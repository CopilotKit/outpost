import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChannelType } from 'discord.js';
import { mockPrisma, mockQueue } from './helpers/mocks.js';

// Mock dependencies before importing the handler
vi.mock('@copilotkit/outpost/db', () => mockPrisma());
vi.mock('@copilotkit/outpost/queue', () => mockQueue());

vi.mock('../lib/shadow-mode.js', () => ({
    isShadowMode: vi.fn().mockReturnValue(false),
    handleShadowThreadCreate: vi.fn().mockResolvedValue('shadow-ticket-id'),
}));

// Mutable so the fail-closed case can empty MONITORED_CHANNEL_IDS.
const { testConfig } = vi.hoisted(() => ({
    testConfig: {
        discordToken: 'test-token',
        clientId: 'test-client-id',
        guildId: 'test-guild-id',
        monitoredChannelIds: ['forum-channel-1'] as string[],
    },
}));

vi.mock('../config.js', () => ({ config: testConfig }));

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

import { handleThreadCreate } from '../events/thread-create.js';
import { prisma } from '@copilotkit/outpost/db';
import { createJob } from '@copilotkit/outpost/queue';
import { isShadowMode, handleShadowThreadCreate } from '../lib/shadow-mode.js';
import { PlatformDiscordAdapter } from '@copilotkit/outpost/shared/platforms';

function makeThread(overrides: Record<string, unknown> = {}) {
    return {
        id: 'thread-123',
        name: 'Help with CopilotKit integration',
        parentId: 'forum-channel-1',
        url: 'https://discord.com/channels/guild/thread-123',
        type: ChannelType.PublicThread,
        parent: { name: 'support-forum' },
        fetchStarterMessage: vi.fn().mockResolvedValue({
            content: 'I need help integrating CopilotKit with my Next.js app.',
            author: { tag: 'TestUser#1234', id: 'user-456', username: 'TestUser' },
        }),
        send: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    } as unknown as Parameters<typeof handleThreadCreate>[0];
}

describe('handleThreadCreate', () => {
    beforeEach(() => {
        testConfig.monitoredChannelIds = ['forum-channel-1'];
        vi.mocked(isShadowMode).mockReturnValue(false);

        vi.mocked(prisma.ticket.create).mockResolvedValue({
            id: 'ticket-internal-id',
            displayId: 'TKT-AB12CD34',
            status: 'OPEN',
            sourceId: 'thread-123',
            channel: 'forum-channel-1',
            source: 'DISCORD',
        } as ReturnType<typeof prisma.ticket.create> extends Promise<infer T> ? T : never);

        vi.mocked(prisma.message.create).mockResolvedValue({
            id: 'message-internal-id',
        } as ReturnType<typeof prisma.message.create> extends Promise<infer T> ? T : never);

        // Default: not a team member
        vi.mocked(prisma.user.findFirst).mockResolvedValue(null);
        vi.mocked(prisma.user.create).mockResolvedValue({
            id: 'user-internal-id',
        } as ReturnType<typeof prisma.user.create> extends Promise<infer T> ? T : never);
    });

    it('ignores threads that are not newly created', async () => {
        const thread = makeThread();
        await handleThreadCreate(thread, false);
        expect(prisma.ticket.create).not.toHaveBeenCalled();
    });

    it('ignores threads in unmonitored channels', async () => {
        const thread = makeThread({ parentId: 'random-channel' });
        await handleThreadCreate(thread, true);
        expect(prisma.ticket.create).not.toHaveBeenCalled();
    });

    it('ignores threads without a parent channel', async () => {
        const thread = makeThread({ parentId: null });
        await handleThreadCreate(thread, true);
        expect(prisma.ticket.create).not.toHaveBeenCalled();
    });

    it('creates a ticket via InboundHandler and enqueues AI response for a new thread', async () => {
        const thread = makeThread();
        await handleThreadCreate(thread, true);

        // InboundHandler should create a ticket via prisma
        expect(prisma.ticket.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                source: 'DISCORD',
                sourceId: 'thread-123',
                status: 'OPEN',
                priority: 'MEDIUM',
                type: 'QUESTION',
            }),
        });

        // InboundHandler should create the first message
        expect(prisma.message.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                ticketId: 'ticket-internal-id',
                type: 'USER',
            }),
        });

        // InboundHandler should enqueue an AI response job via our createJob wrapper
        expect(createJob).toHaveBeenCalledWith(
            'AI_RESPONSE',
            expect.objectContaining({
                ticketId: 'ticket-internal-id',
                source: 'discord',
            }),
        );
    });

    // The new-ticket path is the one place where the sender still decides
    // whether an AI job is enqueued: a community reporter's thread gets an
    // answer (test above), a team member's does not. Replies never enqueue for
    // anyone, so this assertion cannot live on the reply path.
    it('creates a ticket but does not enqueue an AI response when a team member opens the thread', async () => {
        vi.mocked(prisma.user.findFirst).mockResolvedValue({
            id: 'u-1',
            email: 'team@copilotkit.ai',
        } as ReturnType<typeof prisma.user.findFirst> extends Promise<infer T> ? T : never);
        vi.mocked(prisma.teamMember.findUnique).mockResolvedValue({
            id: 'tm-1',
        } as ReturnType<typeof prisma.teamMember.findUnique> extends Promise<infer T> ? T : never);

        const thread = makeThread();
        await handleThreadCreate(thread, true);

        // The ticket and its first message are still recorded.
        expect(prisma.ticket.create).toHaveBeenCalled();
        expect(prisma.message.create).toHaveBeenCalled();

        // But the bot does not answer its own team.
        expect(createJob).not.toHaveBeenCalled();
    });

    // The bot used to open every thread with "🎫 Ticket TKT-XXXXXXXX created…",
    // publishing an internal identifier into a public server and spending a bot
    // message on nothing the reporter can act on. The AI answer is the only
    // message the bot sends.
    it('posts no acknowledgment message and never emits the ticket displayId', async () => {
        const postSystemMessage = vi.spyOn(
            PlatformDiscordAdapter.prototype,
            'postSystemMessage',
        );

        const thread = makeThread();
        await handleThreadCreate(thread, true);

        expect(postSystemMessage).not.toHaveBeenCalled();
        expect(thread.send).not.toHaveBeenCalled();

        postSystemMessage.mockRestore();
    });

    it('handles threads with no starter message content gracefully', async () => {
        const thread = makeThread();
        vi.mocked(thread.fetchStarterMessage).mockResolvedValue(null);

        await handleThreadCreate(thread, true);

        // Should still create a ticket (with empty content)
        expect(prisma.ticket.create).toHaveBeenCalled();

        // InboundHandler skips message creation when content is empty
        // (the handler checks message.content truthiness)
    });

    it('logs error and does not crash when prisma.ticket.create rejects', async () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.mocked(prisma.ticket.create).mockRejectedValueOnce(
            new Error('DB connection lost'),
        );

        const thread = makeThread();

        // Should not throw — the handler catches the error
        await expect(handleThreadCreate(thread, true)).resolves.toBeUndefined();

        // Should have logged the error
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('Failed to create ticket'),
            expect.any(Error),
        );

        consoleSpy.mockRestore();
    });

    // An unset MONITORED_CHANNEL_IDS used to mean "monitor every channel", so a
    // missing env var silently opted the whole guild into a retrieval +
    // generation cycle per thread. It now fails closed.
    it('ignores every thread when MONITORED_CHANNEL_IDS is empty', async () => {
        testConfig.monitoredChannelIds = [];

        await handleThreadCreate(makeThread(), true);

        expect(prisma.ticket.create).not.toHaveBeenCalled();
        expect(createJob).not.toHaveBeenCalled();
    });

    // Announcements and release notes are threads too — they should not spend a
    // full retrieval + generation cycle.
    it('ignores a thread that does not read as a support request', async () => {
        const thread = makeThread({
            name: 'v1.10.0 released',
            fetchStarterMessage: vi.fn().mockResolvedValue({
                content: 'v1.10.0 is out. Release notes are in the changelog.',
                author: { tag: 'Maintainer#0001', id: 'user-1', username: 'Maintainer' },
            }),
        });

        await handleThreadCreate(thread, true);

        expect(prisma.ticket.create).not.toHaveBeenCalled();
        expect(createJob).not.toHaveBeenCalled();
    });

    it('answers an announcement-shaped thread that @-mentions the bot', async () => {
        const thread = makeThread({
            name: 'v1.10.0 released',
            fetchStarterMessage: vi.fn().mockResolvedValue({
                content: '<@test-client-id> v1.10.0 is out. Notes in the changelog.',
                author: { tag: 'Maintainer#0001', id: 'user-1', username: 'Maintainer' },
            }),
        });

        await handleThreadCreate(thread, true);

        expect(prisma.ticket.create).toHaveBeenCalled();
    });

    it('answers a thread whose question is only in the title', async () => {
        const thread = makeThread({
            name: 'How do I render generative UI?',
            fetchStarterMessage: vi.fn().mockResolvedValue({
                content: 'Details below.',
                author: { tag: 'TestUser#1234', id: 'user-456', username: 'TestUser' },
            }),
        });

        await handleThreadCreate(thread, true);

        expect(prisma.ticket.create).toHaveBeenCalled();
    });

    it('applies the support-request gate in shadow mode too', async () => {
        vi.mocked(isShadowMode).mockReturnValue(true);
        const thread = makeThread({
            name: 'v1.10.0 released',
            fetchStarterMessage: vi.fn().mockResolvedValue({
                content: 'v1.10.0 is out. Release notes are in the changelog.',
                author: { tag: 'Maintainer#0001', id: 'user-1', username: 'Maintainer' },
            }),
        });

        await handleThreadCreate(thread, true);

        expect(handleShadowThreadCreate).not.toHaveBeenCalled();
    });

    it('uses DiscordAdapter.parseInboundEvent to normalize the thread event', async () => {
        const thread = makeThread();
        await handleThreadCreate(thread, true);

        // Verify the InboundHandler was called (proxied through prisma.ticket.create)
        // The adapter should have extracted the correct threadId from the thread object
        const createCall = vi.mocked(prisma.ticket.create).mock.calls[0][0];
        expect(createCall.data.sourceId).toBe('thread-123');
        expect(createCall.data.channel).toBe('forum-channel-1');
    });
});
