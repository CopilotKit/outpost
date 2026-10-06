import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';

// The handler's mirror default reads process.env. A developer (or CI) exporting
// SLACK_MIRROR_MODE would otherwise change the createJob call counts asserted
// throughout this file. Neutralize the ambient environment for the whole suite.
const AMBIENT_MIRROR_ENV = ['SLACK_MIRROR_MODE', 'SLACK_MIRROR_CHANNEL_ID'] as const;
const savedMirrorEnv: Record<string, string | undefined> = {};

beforeAll(() => {
    for (const key of AMBIENT_MIRROR_ENV) {
        savedMirrorEnv[key] = process.env[key];
        delete process.env[key];
    }
});

afterAll(() => {
    for (const key of AMBIENT_MIRROR_ENV) {
        if (savedMirrorEnv[key] !== undefined) process.env[key] = savedMirrorEnv[key]!;
        else delete process.env[key];
    }
});
import { InboundHandler } from '../platforms/inbound.js';
import type { PrismaLike, CreateJobFn } from '../platforms/inbound.js';
import type { InboundMessage } from '../platforms/types.js';
import { TicketSource, TicketStatus } from '../types.js';
import { REOPEN_ON_CUSTOMER_REPLY_STATUSES, reopensOnCustomerReply } from '../constants.js';

// ── Mock Prisma ────────────────────────────────────────────────────────

function createMockPrisma(): PrismaLike {
    return {
        ticket: {
            create: vi.fn().mockResolvedValue({
                id: 'ticket-1',
                displayId: 'TKT-ABCDEF12',
                status: 'OPEN',
                sourceId: 'thread-123',
                channel: 'channel-1',
                source: 'DISCORD',
            }),
            findFirst: vi.fn().mockResolvedValue(null),
            update: vi.fn().mockResolvedValue({
                id: 'ticket-1',
                displayId: 'TKT-ABCDEF12',
                status: 'OPEN',
            }),
        },
        message: {
            create: vi.fn().mockResolvedValue({ id: 'msg-1' }),
        },
        user: {
            findFirst: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue({ id: 'user-new-1' }),
        },
        teamMember: {
            findUnique: vi.fn().mockResolvedValue(null),
        },
        ticketExternalLink: {
            create: vi.fn().mockResolvedValue({ id: 'link-1' }),
        },
    };
}

function createMockCreateJob(): CreateJobFn {
    return vi.fn().mockResolvedValue('job-1');
}

function makeInboundMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
    return {
        platformUserId: 'user-123',
        platformUsername: 'testuser',
        content: 'Hello, I need help with the SDK',
        threadId: 'thread-123',
        channelId: 'channel-1',
        sourceUrl: 'https://discord.com/channels/123/456/789',
        source: TicketSource.DISCORD,
        isThreadStart: true,
        rawEvent: { type: 'message' },
        ...overrides,
    };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('InboundHandler', () => {
    let prisma: PrismaLike;
    let createJob: CreateJobFn;
    let handler: InboundHandler;

    beforeEach(() => {
        prisma = createMockPrisma();
        createJob = createMockCreateJob();
        handler = new InboundHandler({ prisma, createJob });
    });

    // ── New ticket creation ──────────────────────────────────────────

    describe('new ticket creation (isThreadStart=true)', () => {
        it('creates a ticket and first message in the database', async () => {
            const msg = makeInboundMessage();
            const result = await handler.handle(msg);

            expect(result.isNewTicket).toBe(true);
            expect(result.isOrphanedReply).toBe(false);
            expect(result.ticketId).toBe('ticket-1');
            expect(result.displayId).toMatch(/^TKT-/);

            // Ticket was created
            expect(prisma.ticket.create).toHaveBeenCalledTimes(1);
            const ticketData = (prisma.ticket.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
                .data;
            expect(ticketData.source).toBe('DISCORD');
            expect(ticketData.sourceId).toBe('thread-123');
            expect(ticketData.status).toBe('OPEN');
            expect(ticketData.priority).toBe('MEDIUM');
            expect(ticketData.type).toBe('QUESTION');

            // First message was created
            expect(prisma.message.create).toHaveBeenCalledTimes(1);
            const msgData = (prisma.message.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
                .data;
            expect(msgData.ticketId).toBe('ticket-1');
            expect(msgData.author).toContain('testuser');
            expect(msgData.author).toContain('user-123');
            expect(msgData.type).toBe('USER');
        });

        it('enqueues an AI_RESPONSE job for non-team-member senders', async () => {
            const msg = makeInboundMessage();
            const result = await handler.handle(msg);

            expect(result.aiJobEnqueued).toBe(true);
            expect(createJob).toHaveBeenCalledTimes(1);
            expect(createJob).toHaveBeenCalledWith('AI_RESPONSE', {
                ticketId: 'ticket-1',
                threadId: 'thread-123',
                source: 'discord',
            });
        });

        it('skips AI job when sender is a team member', async () => {
            // Set up user lookup to find a matching user with email
            (prisma.user.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
                id: 'user-db-1',
                email: 'team@example.com',
            });
            // Set up team member lookup to find a match
            (prisma.teamMember.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
                id: 'member-1',
            });

            const msg = makeInboundMessage();
            const result = await handler.handle(msg);

            expect(result.isNewTicket).toBe(true);
            expect(result.aiJobEnqueued).toBe(false);
            expect(createJob).not.toHaveBeenCalled();
        });

        it('truncates long content for title and description', async () => {
            const longContent = 'x'.repeat(5000);
            const msg = makeInboundMessage({ content: longContent });
            await handler.handle(msg);

            const ticketData = (prisma.ticket.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
                .data;
            expect(ticketData.title.length).toBeLessThanOrEqual(200);
            expect(ticketData.description.length).toBeLessThanOrEqual(4000);
        });

        it('handles empty content gracefully (no message created)', async () => {
            const msg = makeInboundMessage({ content: '' });
            await handler.handle(msg);

            // Ticket created but message not created (content is empty)
            expect(prisma.ticket.create).toHaveBeenCalledTimes(1);
            expect(prisma.message.create).not.toHaveBeenCalled();
        });

        it('maps different TicketSource values to correct PlatformTarget in job', async () => {
            const sources: Array<{ source: TicketSource; expectedTarget: string }> = [
                { source: TicketSource.DISCORD, expectedTarget: 'discord' },
                { source: TicketSource.GITHUB_ISSUE, expectedTarget: 'github' },
                { source: TicketSource.GITHUB_DISCUSSION, expectedTarget: 'github' },
                { source: TicketSource.SLACK, expectedTarget: 'slack' },
                { source: TicketSource.TEAMS, expectedTarget: 'teams' },
                { source: TicketSource.EMAIL, expectedTarget: 'web' },
            ];

            for (const { source, expectedTarget } of sources) {
                const freshPrisma = createMockPrisma();
                const freshCreateJob = createMockCreateJob();
                const freshHandler = new InboundHandler({
                    prisma: freshPrisma,
                    createJob: freshCreateJob,
                });

                const msg = makeInboundMessage({ source });
                await freshHandler.handle(msg);

                expect(freshCreateJob).toHaveBeenCalledWith(
                    'AI_RESPONSE',
                    expect.objectContaining({
                        source: expectedTarget,
                    }),
                );
            }
        });

        it('passes attachments to message record when present', async () => {
            const msg = makeInboundMessage({
                attachments: [
                    {
                        filename: 'screenshot.png',
                        url: 'https://cdn.example.com/screenshot.png',
                        size: 1024,
                        contentType: 'image/png',
                    },
                ],
            });
            await handler.handle(msg);

            const msgData = (prisma.message.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
                .data;
            expect(msgData.attachments).toBeDefined();
            expect(msgData.attachments[0].filename).toBe('screenshot.png');
        });

        // ── User linkage ────────────────────────────────────────────

        it('links the ticket to an existing User found by externalId + source', async () => {
            (prisma.user.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
                id: 'user-existing-1',
                email: 'existing@example.com',
            });

            const msg = makeInboundMessage();
            await handler.handle(msg);

            expect(prisma.user.findFirst).toHaveBeenCalledWith({
                where: {
                    externalId: 'user-123',
                    source: 'DISCORD',
                },
            });
            expect(prisma.user.create).not.toHaveBeenCalled();

            const ticketData = (prisma.ticket.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
                .data;
            expect(ticketData.userId).toBe('user-existing-1');
        });

        it('creates a new User with a synthesized placeholder email when none exists, and links it to the ticket', async () => {
            (prisma.user.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

            const msg = makeInboundMessage();
            await handler.handle(msg);

            expect(prisma.user.create).toHaveBeenCalledWith({
                data: {
                    name: 'testuser',
                    email: 'discord-user-123@reporters.outpost.internal',
                    externalId: 'user-123',
                    source: 'DISCORD',
                },
            });

            const ticketData = (prisma.ticket.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
                .data;
            expect(ticketData.userId).toBe('user-new-1');
        });

        it('recovers from a concurrent-create race: re-reads the User when create hits a unique violation', async () => {
            // Two first-ever messages from the same sender arrive at once: both
            // findFirst -> null, both attempt create with the same synthesized
            // (unique) email. The loser gets P2002; it must re-read and reuse the
            // winner's row, not throw and drop the ticket.
            (prisma.user.findFirst as ReturnType<typeof vi.fn>)
                .mockReset()
                // 1st: initial lookup -> null. 2nd: recovery re-read after the
                // race -> the winner's row. (A later call from isTeamMember
                // falls through to null.)
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce({
                    id: 'user-raced-1',
                    email: 'discord-user-123@reporters.outpost.internal',
                })
                .mockResolvedValue(null);
            (prisma.user.create as ReturnType<typeof vi.fn>)
                .mockReset()
                .mockRejectedValueOnce({ code: 'P2002' });

            const msg = makeInboundMessage();
            const result = await handler.handle(msg);

            expect(result.isNewTicket).toBe(true);
            expect(prisma.user.create).toHaveBeenCalledTimes(1);

            const ticketData = (prisma.ticket.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
                .data;
            expect(ticketData.userId).toBe('user-raced-1');
        });

        it('rethrows a non-unique-violation create error', async () => {
            (prisma.user.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
            (prisma.user.create as ReturnType<typeof vi.fn>)
                .mockReset()
                .mockRejectedValueOnce({ code: 'P1001', message: 'db unreachable' });

            await expect(handler.handle(makeInboundMessage())).rejects.toMatchObject({
                code: 'P1001',
            });
        });
    });

    // ── Reply to existing ticket ─────────────────────────────────────

    describe('reply to existing ticket (isThreadStart=false)', () => {
        const existingTicket = {
            id: 'ticket-existing',
            displayId: 'TKT-EXISTIN',
            status: 'OPEN',
            sourceId: 'thread-123',
            channel: 'channel-1',
            source: 'DISCORD',
        };

        beforeEach(() => {
            (prisma.ticket.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(existingTicket);
        });

        it('appends message to existing ticket', async () => {
            const msg = makeInboundMessage({ isThreadStart: false, content: 'Follow up question' });
            const result = await handler.handle(msg);

            expect(result.isNewTicket).toBe(false);
            expect(result.isOrphanedReply).toBe(false);
            expect(result.ticketId).toBe('ticket-existing');
            expect(result.displayId).toBe('TKT-EXISTIN');

            // No new ticket created
            expect(prisma.ticket.create).not.toHaveBeenCalled();

            // Message was appended
            expect(prisma.message.create).toHaveBeenCalledTimes(1);
            const msgData = (prisma.message.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
                .data;
            expect(msgData.ticketId).toBe('ticket-existing');
            expect(msgData.content).toBe('Follow up question');
        });

        // ONE RESPONSE PER TICKET. Outpost answers the message that opens a
        // ticket and stays out of the thread after that — no follow-up reply to
        // anyone. Before this, every non-team reply enqueued an AI_RESPONSE, so
        // the bot butted into follow-up questions between community members and
        // summarised a human's answer back at them.
        it('never enqueues AI_RESPONSE for a reply from a non-team member', async () => {
            const msg = makeInboundMessage({ isThreadStart: false });
            const result = await handler.handle(msg);

            expect(result.aiJobEnqueued).toBe(false);
            expect(createJob).not.toHaveBeenCalled();
        });

        it('never enqueues AI_RESPONSE for a reply from an unrelated third party', async () => {
            const msg = makeInboundMessage({
                isThreadStart: false,
                platformUserId: 'someone-else-999',
                platformUsername: 'bystander',
                content: 'did you ever get this working?',
            });
            const result = await handler.handle(msg);

            expect(result.aiJobEnqueued).toBe(false);
            expect(createJob).not.toHaveBeenCalled();
        });

        it('still appends the reply as a Message even though no AI job is queued', async () => {
            const msg = makeInboundMessage({ isThreadStart: false, content: 'any update?' });
            await handler.handle(msg);

            expect(prisma.message.create).toHaveBeenCalledTimes(1);
            expect(createJob).not.toHaveBeenCalled();
        });

        // There is deliberately no "skips AI_RESPONSE for a team member reply"
        // test here. Replies never enqueue for anyone (asserted above), so such
        // a test would pass even if team-member detection were deleted. The
        // sender-dependent assertion lives on the new-ticket path — see 'skips
        // AI job when sender is a team member' and the 'team member detection'
        // block. What a team member's reply DOES change is ticket status, which
        // the next two tests cover.
        it('transitions WAITING_ON_TEAM to WAITING_ON_CUSTOMER when team member replies', async () => {
            (prisma.ticket.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
                ...existingTicket,
                status: 'WAITING_ON_TEAM',
            });
            (prisma.user.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
                id: 'user-db-1',
                email: 'team@example.com',
            });
            (prisma.teamMember.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
                id: 'member-1',
            });

            const msg = makeInboundMessage({ isThreadStart: false });
            await handler.handle(msg);

            expect(prisma.ticket.update).toHaveBeenCalledWith({
                where: { id: 'ticket-existing' },
                data: { status: 'WAITING_ON_CUSTOMER' },
            });
        });

        it('does NOT transition ticket if team member replies and status is not WAITING_ON_TEAM', async () => {
            (prisma.ticket.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
                ...existingTicket,
                status: 'OPEN',
            });
            (prisma.user.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
                id: 'user-db-1',
                email: 'team@example.com',
            });
            (prisma.teamMember.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
                id: 'member-1',
            });

            const msg = makeInboundMessage({ isThreadStart: false });
            await handler.handle(msg);

            expect(prisma.ticket.update).not.toHaveBeenCalled();
        });

        it('reopens ticket from WAITING_ON_CUSTOMER when customer replies', async () => {
            (prisma.ticket.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
                ...existingTicket,
                status: 'WAITING_ON_CUSTOMER',
            });

            const msg = makeInboundMessage({ isThreadStart: false });
            await handler.handle(msg);

            expect(prisma.ticket.update).toHaveBeenCalledWith({
                where: { id: 'ticket-existing' },
                data: { status: 'OPEN' },
            });
        });

        it('reopens ticket from RESOLVED when customer replies', async () => {
            (prisma.ticket.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
                ...existingTicket,
                status: 'RESOLVED',
            });

            const msg = makeInboundMessage({ isThreadStart: false });
            await handler.handle(msg);

            expect(prisma.ticket.update).toHaveBeenCalledWith({
                where: { id: 'ticket-existing' },
                data: { status: 'OPEN' },
            });
        });

        it('reopens ticket from CLOSED when customer replies', async () => {
            (prisma.ticket.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
                ...existingTicket,
                status: 'CLOSED',
            });

            const msg = makeInboundMessage({ isThreadStart: false });
            await handler.handle(msg);

            expect(prisma.ticket.update).toHaveBeenCalledWith({
                where: { id: 'ticket-existing' },
                data: { status: 'OPEN' },
            });
        });

        it('does NOT reopen ticket if status is OPEN or IN_PROGRESS', async () => {
            for (const status of ['OPEN', 'IN_PROGRESS']) {
                const freshPrisma = createMockPrisma();
                (freshPrisma.ticket.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
                    ...existingTicket,
                    status,
                });
                const freshCreateJob = createMockCreateJob();
                const freshHandler = new InboundHandler({
                    prisma: freshPrisma,
                    createJob: freshCreateJob,
                });

                const msg = makeInboundMessage({ isThreadStart: false });
                await freshHandler.handle(msg);

                expect(freshPrisma.ticket.update).not.toHaveBeenCalled();
            }
        });

        it('creates new ticket if no existing ticket found for reply thread', async () => {
            (prisma.ticket.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

            const msg = makeInboundMessage({ isThreadStart: false });
            const result = await handler.handle(msg);

            // Falls back to creating a new ticket, flagged as an orphan so
            // callers do not treat it as a conversation Outpost opened.
            expect(result.isNewTicket).toBe(true);
            expect(result.isOrphanedReply).toBe(true);
            expect(prisma.ticket.create).toHaveBeenCalledTimes(1);
        });
    });

    // ── Orphaned replies (reply with no matching ticket) ─────────────
    //
    // Outpost answers exactly ONE message per ticket: the one that OPENED it.
    // An orphaned reply is mid-conversation, so we file it (never drop a
    // customer's words) but must not answer it — the opening message was never
    // seen by us. These assertions exist because the pre-existing fallback
    // tests asserted nothing about createJob, which is how a regression here
    // shipped: the fallback re-entered the new-ticket path and answered.
    describe('orphaned reply fallback never answers', () => {
        beforeEach(() => {
            (prisma.ticket.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
        });

        it('creates the ticket and message but enqueues NO AI_RESPONSE', async () => {
            const msg = makeInboundMessage({
                isThreadStart: false,
                content: 'any update on this?',
            });
            const result = await handler.handle(msg);

            expect(prisma.ticket.create).toHaveBeenCalledTimes(1);
            expect(prisma.message.create).toHaveBeenCalledTimes(1);
            expect(createJob).not.toHaveBeenCalled();
            expect(result.aiJobEnqueued).toBe(false);
            expect(result.isNewTicket).toBe(true);
            // isNewTicket cannot distinguish this from a real thread start, so
            // the orphan flag is what platform handlers gate their ack posts on
            // (see apps/teams-bot/src/handlers/message.ts).
            expect(result.isOrphanedReply).toBe(true);
            expect(result.messageId).toBe('msg-1');
        });

        it('does not answer even when the sender is not a team member', async () => {
            // Non-team sender is the case that WOULD have been answered by the
            // new-ticket path — the exact hole this closes.
            (prisma.user.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
            (prisma.teamMember.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

            const result = await handler.handle(makeInboundMessage({ isThreadStart: false }));

            expect(createJob).not.toHaveBeenCalled();
            expect(result.aiJobEnqueued).toBe(false);
        });

        it.each([
            [TicketSource.TEAMS, 'teams'],
            [TicketSource.DISCORD, 'discord'],
            [TicketSource.GITHUB_ISSUE, 'github'],
            [TicketSource.SLACK, 'slack'],
        ])('stays silent for an orphaned %s reply', async (source) => {
            const result = await handler.handle(
                makeInboundMessage({ source, isThreadStart: false, channelId: 'chan-1' }),
            );

            expect(createJob).not.toHaveBeenCalled();
            expect(result.aiJobEnqueued).toBe(false);
        });

        it('still enqueues for a genuine thread start, so the fix is not a blanket mute', async () => {
            const result = await handler.handle(makeInboundMessage({ isThreadStart: true }));

            expect(createJob).toHaveBeenCalledTimes(1);
            expect(result.aiJobEnqueued).toBe(true);
        });
    });

    // ── Slack composite sourceId ─────────────────────────────────────

    describe('Slack composite sourceId handling', () => {
        it('looks up Slack tickets using channelId:threadTs composite key', async () => {
            const msg = makeInboundMessage({
                source: TicketSource.SLACK,
                threadId: '1234567890.123456',
                channelId: 'C0ABCDEF1',
                isThreadStart: false,
            });

            await handler.handle(msg);

            expect(prisma.ticket.findFirst).toHaveBeenCalledWith({
                where: {
                    source: 'SLACK',
                    sourceId: 'C0ABCDEF1:1234567890.123456',
                },
            });
        });

        it('creates Slack tickets with composite channelId:threadTs as sourceId', async () => {
            const msg = makeInboundMessage({
                source: TicketSource.SLACK,
                threadId: '1234567890.123456',
                channelId: 'C0ABCDEF1',
                isThreadStart: true,
            });

            await handler.handle(msg);

            const ticketData = (prisma.ticket.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
                .data;
            // Slack tickets use composite sourceId so reply lookups match
            expect(ticketData.sourceId).toBe('C0ABCDEF1:1234567890.123456');
        });

        it('stores null instead of a bare threadTs when the Slack channelId is missing', async () => {
            const msg = makeInboundMessage({
                source: TicketSource.SLACK,
                threadId: '1234567890.123456',
                channelId: undefined,
                isThreadStart: true,
            });

            await handler.handle(msg);

            const ticketData = (prisma.ticket.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
                .data;
            // A bare ts is not a Slack key — the reply lookup would build
            // "channel:ts" and never find it, so refuse to pretend otherwise.
            expect(ticketData.sourceId).toBeNull();
        });

        it('does not search for the unmatchable "channelId:" key when a Slack reply has no threadTs', async () => {
            const msg = makeInboundMessage({
                source: TicketSource.SLACK,
                threadId: undefined,
                channelId: 'C0ABCDEF1',
                isThreadStart: false,
            });

            await handler.handle(msg);

            // The old lookup defaulted threadId to '' and queried "C0ABCDEF1:",
            // a key nothing is ever stored under.
            expect(prisma.ticket.findFirst).not.toHaveBeenCalled();
        });

        it('does not search by a bare threadTs when a Slack reply has no channelId', async () => {
            const msg = makeInboundMessage({
                source: TicketSource.SLACK,
                threadId: '1234567890.123456',
                channelId: undefined,
                isThreadStart: false,
            });

            await handler.handle(msg);

            expect(prisma.ticket.findFirst).not.toHaveBeenCalled();
        });
    });

    // ── sourceId write/read symmetry ─────────────────────────────────
    //
    // The regression these guard: create stored `null` for a message with no
    // threadId while the reply lookup searched for `''`. The two could never
    // agree, so every reply in such a conversation looked like a brand-new
    // ticket and drew its own AI answer.

    describe('sourceId write/read symmetry', () => {
        it('does not search for the empty-string key when a non-Slack reply has no threadId', async () => {
            const msg = makeInboundMessage({
                source: TicketSource.DISCORD,
                threadId: undefined,
                isThreadStart: false,
            });

            await handler.handle(msg);

            expect(prisma.ticket.findFirst).not.toHaveBeenCalled();
        });

        it('stores null for a non-Slack ticket with no threadId', async () => {
            const msg = makeInboundMessage({
                source: TicketSource.DISCORD,
                threadId: undefined,
                isThreadStart: true,
            });

            await handler.handle(msg);

            const ticketData = (prisma.ticket.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
                .data;
            expect(ticketData.sourceId).toBeNull();
        });

        it('treats a threadId-less reply as a new ticket instead of matching a null-sourceId ticket', async () => {
            // Guard against the opposite failure mode: matching on the absent
            // key would glue unrelated threadId-less conversations together.
            (prisma.ticket.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
                id: 'ticket-existing',
                displayId: 'TKT-EXISTIN',
                status: 'OPEN',
                sourceId: null,
                channel: 'channel-1',
                source: 'DISCORD',
            });

            const msg = makeInboundMessage({
                source: TicketSource.DISCORD,
                threadId: undefined,
                isThreadStart: false,
            });
            const result = await handler.handle(msg);

            expect(prisma.ticket.findFirst).not.toHaveBeenCalled();
            expect(result.isNewTicket).toBe(true);
        });

        it.each([
            [TicketSource.DISCORD, 'thread-abc', 'channel-1'],
            [TicketSource.SLACK, '1234567890.123456', 'C0ABCDEF1'],
            [TicketSource.TEAMS, 'conv-xyz', undefined],
            [TicketSource.GITHUB_ISSUE, 'owner/repo#42', undefined],
            // The unaddressable cases: written key is null, so no lookup may
            // happen at all. Any query here means the reader invented a key.
            [TicketSource.DISCORD, undefined, 'channel-1'],
            [TicketSource.TEAMS, undefined, undefined],
            [TicketSource.SLACK, '1234567890.123456', undefined],
            [TicketSource.SLACK, undefined, 'C0ABCDEF1'],
        ])(
            'writes and reads the same key for %s (threadId=%s, channelId=%s)',
            async (source, threadId, channelId) => {
                await handler.handle(
                    makeInboundMessage({ source, threadId, channelId, isThreadStart: true }),
                );
                const written = (prisma.ticket.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
                    .data.sourceId;

                const findFirst = prisma.ticket.findFirst as ReturnType<typeof vi.fn>;
                await handler.handle(
                    makeInboundMessage({ source, threadId, channelId, isThreadStart: false }),
                );
                // No query at all is the correct read of a null key.
                const read =
                    findFirst.mock.calls.length === 0
                        ? null
                        : findFirst.mock.calls[0][0].where.sourceId;

                expect(read).toBe(written);
            },
        );
    });

    // ── Team member detection ────────────────────────────────────────

    // These exercise isTeamMember through the NEW-ticket path, because that is
    // the only path where the flag still varies. Replies never enqueue an
    // AI_RESPONSE regardless of sender, so asserting aiJobEnqueued on a reply
    // would pass no matter what isTeamMember returned.
    describe('team member detection', () => {
        it('identifies team member by User.externalId + TeamMember.email lookup', async () => {
            (prisma.user.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
                id: 'user-db-1',
                email: 'developer@company.com',
            });
            (prisma.teamMember.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
                id: 'member-1',
            });

            const result = await handler.handle(makeInboundMessage());
            expect(result.aiJobEnqueued).toBe(false);

            // Verify User lookup used correct source
            expect(prisma.user.findFirst).toHaveBeenCalledWith({
                where: {
                    externalId: 'user-123',
                    source: 'DISCORD',
                },
            });
        });

        it('returns false when user has no email', async () => {
            (prisma.user.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
                id: 'user-db-1',
                email: null,
            });

            const result = await handler.handle(makeInboundMessage());
            expect(result.aiJobEnqueued).toBe(true);
        });

        it('returns false when user not found in database', async () => {
            (prisma.user.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

            const result = await handler.handle(makeInboundMessage());
            expect(result.aiJobEnqueued).toBe(true);
        });

        it('returns false when user found but no matching team member', async () => {
            (prisma.user.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
                id: 'user-db-1',
                email: 'outsider@other.com',
            });
            (prisma.teamMember.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

            const result = await handler.handle(makeInboundMessage());
            expect(result.aiJobEnqueued).toBe(true);
        });
    });

    // ── Error cases ──────────────────────────────────────────────────

    describe('error cases', () => {
        it('propagates Prisma errors during ticket creation', async () => {
            (prisma.ticket.create as ReturnType<typeof vi.fn>).mockRejectedValue(
                new Error('Database connection failed'),
            );

            const msg = makeInboundMessage();
            await expect(handler.handle(msg)).rejects.toThrow('Database connection failed');
        });

        it('propagates Prisma errors during message creation', async () => {
            (prisma.message.create as ReturnType<typeof vi.fn>).mockRejectedValue(
                new Error('Unique constraint violation'),
            );

            const msg = makeInboundMessage();
            await expect(handler.handle(msg)).rejects.toThrow('Unique constraint violation');
        });

        it('propagates job creation errors', async () => {
            (createJob as ReturnType<typeof vi.fn>).mockRejectedValue(
                new Error('Queue unavailable'),
            );

            const msg = makeInboundMessage();
            await expect(handler.handle(msg)).rejects.toThrow('Queue unavailable');
        });
    });

    // ── Custom AI job type ───────────────────────────────────────────

    describe('custom aiResponseJobType', () => {
        it('uses custom job type string when configured', async () => {
            const customHandler = new InboundHandler({
                prisma,
                createJob,
                aiResponseJobType: 'CUSTOM_AI_JOB',
            });

            const msg = makeInboundMessage();
            await customHandler.handle(msg);

            expect(createJob).toHaveBeenCalledWith('CUSTOM_AI_JOB', expect.anything());
        });
    });
    // ── Slack ticket mirror ──────────────────────────────────────────

    describe('Slack ticket mirror', () => {
        it('enqueues a thread-opening mirror job for a new ticket', async () => {
            const handler = new InboundHandler({ prisma, createJob, mirrorToSlack: true });

            await handler.handle(makeInboundMessage());

            expect(createJob).toHaveBeenCalledWith('SLACK_MIRROR', {
                ticketId: 'ticket-1',
                source: 'discord',
                kind: 'ticket',
            });
        });

        // THE PRODUCTION ENABLE PATH. Every other test in this block passes
        // `mirrorToSlack` explicitly, but no `new InboundHandler(...)` anywhere in
        // apps/ does — all six rely on the `??` fallback, so the env branch is
        // what actually turns the mirror on in production and it was the one line
        // no test exercised. Replacing just the fallback with `false` left the
        // whole suite green, because replacing the WHOLE expression kills five
        // tests and makes the switch look covered.
        //
        // The symptom if it were ever wrong is an empty Slack channel, which is
        // indistinguishable from "nobody filed anything today".
        describe('the environment fallback, with no explicit flag', () => {
            const setMirrorEnv = (mode: string | undefined, channel?: string) => {
                if (mode === undefined) delete process.env.SLACK_MIRROR_MODE;
                else process.env.SLACK_MIRROR_MODE = mode;
                if (channel === undefined) delete process.env.SLACK_MIRROR_CHANNEL_ID;
                else process.env.SLACK_MIRROR_CHANNEL_ID = channel;
            };

            afterEach(() => setMirrorEnv(undefined));

            it('enables the mirror from SLACK_MIRROR_MODE=live', async () => {
                setMirrorEnv('live', 'C0123456789');

                const handler = new InboundHandler({ prisma, createJob });
                await handler.handle(makeInboundMessage());

                expect(createJob).toHaveBeenCalledWith('SLACK_MIRROR', {
                    ticketId: 'ticket-1',
                    source: 'discord',
                    kind: 'ticket',
                });
            });

            it('enables the mirror from SLACK_MIRROR_MODE=shadow', async () => {
                setMirrorEnv('shadow', 'C0123456789');

                const handler = new InboundHandler({ prisma, createJob });
                await handler.handle(makeInboundMessage());

                const types = (createJob as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
                expect(types).toContain('SLACK_MIRROR');
            });

            // Fails closed, and each of these is a realistic way to get it wrong.
            it.each([
                [undefined, undefined, 'unset'],
                ['off', 'C0123456789', 'explicitly off'],
                ['on', 'C0123456789', 'a typo that is not a recognized mode'],
                ['live', undefined, 'live with no channel configured'],
            ])('stays off when SLACK_MIRROR_MODE=%s (%s)', async (mode, channel, _why) => {
                setMirrorEnv(mode, channel);

                const handler = new InboundHandler({ prisma, createJob });
                await handler.handle(makeInboundMessage());

                const types = (createJob as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
                expect(types).not.toContain('SLACK_MIRROR');
            });

            // An explicit flag still wins, so a caller that opts out is not
            // overridden by a stray environment variable.
            it('lets an explicit mirrorToSlack:false override a live environment', async () => {
                setMirrorEnv('live', 'C0123456789');

                const handler = new InboundHandler({ prisma, createJob, mirrorToSlack: false });
                await handler.handle(makeInboundMessage());

                const types = (createJob as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
                expect(types).not.toContain('SLACK_MIRROR');
            });
        });

        it('enqueues nothing when the mirror is disabled', async () => {
            const handler = new InboundHandler({ prisma, createJob, mirrorToSlack: false });

            await handler.handle(makeInboundMessage());

            const types = (createJob as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
            expect(types).not.toContain('SLACK_MIRROR');
        });

        it('enqueues a threaded reply job carrying the message id', async () => {
            prisma.ticket.findFirst = vi.fn().mockResolvedValue({
                id: 'ticket-1',
                displayId: 'TKT-ABCDEF12',
                status: 'OPEN',
                sourceId: 'thread-123',
                channel: 'channel-1',
                source: 'DISCORD',
            });
            const handler = new InboundHandler({ prisma, createJob, mirrorToSlack: true });

            await handler.handle(makeInboundMessage({ isThreadStart: false }));

            expect(createJob).toHaveBeenCalledWith('SLACK_MIRROR', {
                ticketId: 'ticket-1',
                source: 'discord',
                kind: 'reply',
                messageId: 'msg-1',
            });
        });

        // The mirror is an ALLOWLIST of GitHub + Discord. A denylist ("anything
        // but SLACK") silently mirrored TEAMS/EMAIL/WEB/MANUAL/LINEAR tickets the
        // feature was never specified for.
        it.each([
            TicketSource.SLACK,
            TicketSource.TEAMS,
            TicketSource.EMAIL,
            TicketSource.WEB,
            TicketSource.MANUAL,
            TicketSource.LINEAR,
        ])('does not mirror a %s-sourced ticket', async (source) => {
            const handler = new InboundHandler({ prisma, createJob, mirrorToSlack: true });

            await handler.handle(makeInboundMessage({ source }));

            const types = (createJob as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
            expect(types).not.toContain('SLACK_MIRROR');
        });

        it.each([TicketSource.GITHUB_ISSUE, TicketSource.GITHUB_DISCUSSION])(
            'mirrors a %s-sourced ticket',
            async (source) => {
                const handler = new InboundHandler({ prisma, createJob, mirrorToSlack: true });

                await handler.handle(makeInboundMessage({ source }));

                const types = (createJob as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
                expect(types).toContain('SLACK_MIRROR');
            },
        );

        // Production does not pass mirrorToSlack — it falls back to the env. With
        // the env unset the fallback must be OFF, so a stray SLACK_MIRROR_MODE in
        // a developer's shell cannot silently enqueue jobs (and cannot perturb the
        // call-count assertions in every other test in this file).
        it('defaults to disabled when the environment configures no mirror', async () => {
            const originalMode = process.env.SLACK_MIRROR_MODE;
            const originalChannel = process.env.SLACK_MIRROR_CHANNEL_ID;
            try {
                delete process.env.SLACK_MIRROR_MODE;
                delete process.env.SLACK_MIRROR_CHANNEL_ID;

                const handler = new InboundHandler({ prisma, createJob });
                await handler.handle(makeInboundMessage());

                const types = (createJob as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
                expect(types).not.toContain('SLACK_MIRROR');
            } finally {
                if (originalMode !== undefined) process.env.SLACK_MIRROR_MODE = originalMode;
                else delete process.env.SLACK_MIRROR_MODE;
                if (originalChannel !== undefined)
                    process.env.SLACK_MIRROR_CHANNEL_ID = originalChannel;
                else delete process.env.SLACK_MIRROR_CHANNEL_ID;
            }
        });

        it('still creates the ticket when enqueueing the mirror job fails', async () => {
            const failing = vi.fn().mockImplementation((type: string) => {
                if (type === 'SLACK_MIRROR') return Promise.reject(new Error('queue down'));
                return Promise.resolve('job-1');
            });
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const handler = new InboundHandler({
                prisma,
                createJob: failing as unknown as CreateJobFn,
                mirrorToSlack: true,
            });

            const result = await handler.handle(makeInboundMessage());

            expect(result.ticketId).toBe('ticket-1');
            expect(result.isNewTicket).toBe(true);
            expect(errorSpy).toHaveBeenCalled();
            errorSpy.mockRestore();
        });
    });
});

// ── The shared reopen predicate ────────────────────────────────────────
//
// All three inbound reply paths (this handler, the GitHub App issue-comment
// webhook, the Postmark inbound-email webhook) gate their reopen on this one
// predicate. They used to each carry their own literal status list and had
// drifted apart, which silently dropped customer follow-ups.

describe('reopensOnCustomerReply', () => {
    it('reopens exactly the three dormant statuses', () => {
        expect(REOPEN_ON_CUSTOMER_REPLY_STATUSES).toEqual([
            'WAITING_ON_CUSTOMER',
            'RESOLVED',
            'CLOSED',
        ]);
        for (const status of REOPEN_ON_CUSTOMER_REPLY_STATUSES) {
            expect(reopensOnCustomerReply(status)).toBe(true);
        }
    });

    it('leaves live statuses alone', () => {
        for (const status of ['OPEN', 'IN_PROGRESS', 'WAITING_ON_TEAM']) {
            expect(reopensOnCustomerReply(status)).toBe(false);
        }
    });

    it('is safe on null/undefined/unknown status', () => {
        expect(reopensOnCustomerReply(null)).toBe(false);
        expect(reopensOnCustomerReply(undefined)).toBe(false);
        expect(reopensOnCustomerReply('NOT_A_STATUS')).toBe(false);
    });

    it('covers every TicketStatus value exactly once, reopen or not', () => {
        // Guard against a new TicketStatus being added without deciding
        // whether a customer reply should reopen it.
        const all = Object.values(TicketStatus) as string[];
        const reopening = all.filter((s) => reopensOnCustomerReply(s));
        expect(reopening.sort()).toEqual(['CLOSED', 'RESOLVED', 'WAITING_ON_CUSTOMER']);
        expect(all.filter((s) => !reopensOnCustomerReply(s)).sort()).toEqual([
            'IN_PROGRESS',
            'OPEN',
            'WAITING_ON_TEAM',
        ]);
    });
});
