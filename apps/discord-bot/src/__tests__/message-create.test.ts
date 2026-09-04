import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChannelType } from 'discord.js';
import { mockPrisma, mockQueue } from './helpers/mocks.js';

vi.mock('@copilotkit/outpost/db', () => mockPrisma());
vi.mock('@copilotkit/outpost/queue', () => mockQueue());

vi.mock('../lib/shadow-mode.js', () => ({
    isShadowMode: vi.fn().mockReturnValue(false),
    handleShadowMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../config.js', () => ({
    config: {
        discordToken: 'test-token',
        clientId: 'test-client-id',
        guildId: 'test-guild-id',
        monitoredChannelIds: ['forum-channel-1'],
    },
}));

// Mock discord.js REST to prevent real HTTP calls
vi.mock('discord.js', async (importOriginal) => {
    const actual = await importOriginal() as Record<string, unknown>;
    return {
        ...actual,
        REST: vi.fn().mockImplementation(function(this: Record<string, unknown>) {
            this.setToken = vi.fn().mockReturnValue(this);
            this.post = vi.fn().mockResolvedValue({});
            this.get = vi.fn().mockResolvedValue({});
        }),
    };
});

import { handleMessageCreate } from '../events/message-create.js';
import { prisma } from '@copilotkit/outpost/db';
import { createJob } from '@copilotkit/outpost/queue';
import { isShadowMode, handleShadowMessage } from '../lib/shadow-mode.js';

const TICKET = {
    id: 'ticket-1',
    displayId: 'TKT-AB12CD34',
    status: 'OPEN',
    priority: 'MEDIUM',
    source: 'DISCORD',
    sourceId: 'thread-123',
    channel: 'forum-channel-1',
};

function makeMessage(overrides: Record<string, unknown> = {}) {
    return {
        author: {
            bot: false,
            tag: 'TestUser#1234',
            id: 'user-456',
            username: 'TestUser',
        },
        content: 'I still need help with this',
        url: 'https://discord.com/channels/guild/thread-123/msg-1',
        channel: {
            type: ChannelType.PublicThread,
            id: 'thread-123',
            parentId: 'forum-channel-1',
        },
        attachments: [],
        ...overrides,
    } as unknown as Parameters<typeof handleMessageCreate>[0];
}

describe('handleMessageCreate', () => {
    beforeEach(() => {
        vi.mocked(isShadowMode).mockReturnValue(false);
        // findTicketByThreadId returns the existing ticket
        vi.mocked(prisma.ticket.findFirst).mockResolvedValue(TICKET as ReturnType<typeof prisma.ticket.findFirst> extends Promise<infer T> ? T : never);
        vi.mocked(prisma.message.create).mockResolvedValue({
            id: 'msg-1',
        } as ReturnType<typeof prisma.message.create> extends Promise<infer T> ? T : never);
        // Default: not a team member
        vi.mocked(prisma.user.findFirst).mockResolvedValue(null);
        vi.mocked(prisma.user.create).mockResolvedValue({
            id: 'user-internal-id',
        } as ReturnType<typeof prisma.user.create> extends Promise<infer T> ? T : never);
    });

    it('ignores messages from bots', async () => {
        const message = makeMessage({ author: { bot: true, tag: 'Bot', id: 'bot-1', username: 'Bot' } });
        await handleMessageCreate(message);
        expect(prisma.ticket.findFirst).not.toHaveBeenCalled();
    });

    it('ignores messages outside of threads', async () => {
        const message = makeMessage({
            channel: { type: ChannelType.GuildText, id: 'chan-1' },
        });
        await handleMessageCreate(message);
        expect(prisma.ticket.findFirst).not.toHaveBeenCalled();
    });

    it('ignores messages in threads without tracked tickets', async () => {
        vi.mocked(prisma.ticket.findFirst).mockResolvedValue(null);
        const message = makeMessage();
        await handleMessageCreate(message);
        // InboundHandler should not be invoked (no message.create call)
        expect(prisma.message.create).not.toHaveBeenCalled();
    });

    // ONE RESPONSE PER TICKET. The thread starter gets an answer (see
    // thread-create.test.ts); replies in that thread never do, whoever sends
    // them. This test used to assert the opposite — it locked in the behaviour
    // where the bot answered follow-up messages, including a maintainer's own
    // reply in a Discord support thread.
    it('appends a reply through InboundHandler without enqueuing an AI response', async () => {
        const message = makeMessage();
        await handleMessageCreate(message);

        // InboundHandler appends a message
        expect(prisma.message.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                ticketId: 'ticket-1',
                type: 'USER',
            }),
        });

        expect(createJob).not.toHaveBeenCalled();
    });

    // No "does not enqueue AI response for team member messages" test here:
    // every message this handler sees is a thread reply, and replies never
    // enqueue for any sender, so it would pass with team-member detection
    // removed entirely. The sender-dependent assertion now lives on the
    // new-ticket path — see 'a team member opening a thread gets a ticket but
    // no AI response' in thread-create.test.ts.

    it('reopens ticket when customer replies to a resolved ticket', async () => {
        vi.mocked(prisma.ticket.findFirst).mockResolvedValue({
            ...TICKET,
            status: 'RESOLVED',
        } as ReturnType<typeof prisma.ticket.findFirst> extends Promise<infer T> ? T : never);

        vi.mocked(prisma.ticket.update).mockResolvedValue({
            ...TICKET,
            status: 'OPEN',
        } as ReturnType<typeof prisma.ticket.update> extends Promise<infer T> ? T : never);

        const message = makeMessage();
        await handleMessageCreate(message);

        expect(prisma.ticket.update).toHaveBeenCalledWith({
            where: { id: 'ticket-1' },
            data: { status: 'OPEN' },
        });
    });

    // Regression: Discord dispatches BOTH ThreadCreate and MessageCreate for a
    // new forum post. handleThreadCreate already ingests the starter message,
    // so handling it again here enqueued a SECOND AI_RESPONSE job for the same
    // ticket — the same question retrieved and answered twice, ~0.2s apart.
    // A thread's starter message shares the thread's own ID.
    it('ignores the thread starter message already ingested by ThreadCreate', async () => {
        const starter = makeMessage({ id: 'thread-123' });

        await handleMessageCreate(starter);

        expect(prisma.ticket.findFirst).not.toHaveBeenCalled();
        expect(prisma.message.create).not.toHaveBeenCalled();
        expect(createJob).not.toHaveBeenCalled();
    });

    it('ignores the thread starter message in shadow mode too', async () => {
        vi.mocked(isShadowMode).mockReturnValue(true);
        const starter = makeMessage({ id: 'thread-123' });

        await handleMessageCreate(starter);

        expect(handleShadowMessage).not.toHaveBeenCalled();
        expect(createJob).not.toHaveBeenCalled();
    });

    // The gate above must not swallow real replies. Asserted on the message
    // record rather than on an enqueue: since #172/#191, `InboundHandler` never
    // enqueues AI_RESPONSE for a reply on ANY platform — Outpost answers once per
    // ticket, on the opening message, and a human owns the thread after that. This
    // test predates that rule and asserted the enqueue, which is why it survived
    // the textual merge and then failed. What it is actually here to prove is that
    // `message.id === threadId` distinguishes the starter message from a reply,
    // and the message record is what shows that.
    it('still processes genuine replies in the same thread', async () => {
        const reply = makeMessage({ id: 'msg-777' });

        await handleMessageCreate(reply);

        expect(prisma.message.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ ticketId: 'ticket-1', type: 'USER' }),
            }),
        );
        // And the one-answer rule still holds: a reply enqueues nothing.
        expect(createJob).not.toHaveBeenCalled();
    });

    it('uses DiscordAdapter.parseInboundEvent to normalize message events', async () => {
        const message = makeMessage();
        await handleMessageCreate(message);

        // The adapter sets isThreadStart=false for message events
        // InboundHandler should find the existing ticket (not create a new one)
        // Verify by checking ticket.create was NOT called (only findFirst and message.create)
        expect(prisma.ticket.create).not.toHaveBeenCalled();
        expect(prisma.message.create).toHaveBeenCalled();
    });
});
