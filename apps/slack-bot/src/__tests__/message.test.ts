import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the handler
vi.mock('@outpost/db', () => ({
    prisma: {
        ticket: {
            create: vi.fn(),
            findFirst: vi.fn(),
            findUnique: vi.fn(),
            update: vi.fn(),
        },
        message: {
            create: vi.fn(),
        },
        note: {
            create: vi.fn(),
        },
        user: {
            findFirst: vi.fn(),
        },
        teamMember: {
            findUnique: vi.fn(),
        },
    },
}));

vi.mock('@outpost/queue', () => ({
    createJob: vi.fn().mockResolvedValue('job-123'),
    JobType: {
        AI_RESPONSE: 'AI_RESPONSE',
        ESCALATION: 'ESCALATION',
    },
}));

vi.mock('@outpost/shared', () => ({
    generateTicketId: vi.fn().mockReturnValue('TKT-SL01'),
    truncate: vi.fn((str: string, _len: number) => str),
}));

vi.mock('../config.js', () => ({
    config: {
        slackBotToken: 'xoxb-test-token',
        slackAppToken: 'xapp-test-token',
        slackSigningSecret: 'test-signing-secret',
        monitoredChannelIds: ['C_MONITORED'],
        teamMemberIds: [],
    },
}));

import { registerMessageHandler } from '../events/message.js';
import { prisma } from '@outpost/db';
import { createJob, JobType } from '@outpost/queue';

// We need to capture the event handler registered with app.event()
let messageHandler: (args: Record<string, unknown>) => Promise<void>;

function makeMockApp() {
    return {
        event: vi.fn((eventName: string, handler: (args: Record<string, unknown>) => Promise<void>) => {
            if (eventName === 'message') {
                messageHandler = handler;
            }
        }),
    };
}

function makeMockClient() {
    return {
        chat: {
            postMessage: vi.fn().mockResolvedValue({ ok: true }),
        },
    };
}

const TICKET = {
    id: 'ticket-1',
    displayId: 'TKT-SL01',
    status: 'OPEN',
    priority: 'MEDIUM',
    source: 'SLACK',
    sourceId: 'C_MONITORED:1234567890.123456',
};

describe('registerMessageHandler', () => {
    beforeEach(() => {
        const app = makeMockApp();
        registerMessageHandler(app as unknown as Parameters<typeof registerMessageHandler>[0]);

        vi.mocked(prisma.ticket.create).mockResolvedValue({
            id: 'ticket-1',
            displayId: 'TKT-SL01',
        } as ReturnType<typeof prisma.ticket.create> extends Promise<infer T> ? T : never);

        vi.mocked(prisma.message.create).mockResolvedValue({
            id: 'msg-1',
        } as ReturnType<typeof prisma.message.create> extends Promise<infer T> ? T : never);

        // Default: not a team member
        vi.mocked(prisma.user.findFirst).mockResolvedValue(null);
    });

    it('registers a message event handler', () => {
        expect(messageHandler).toBeDefined();
    });

    describe('new top-level messages', () => {
        it('creates a ticket and enqueues AI response for a new message in a monitored channel', async () => {
            const client = makeMockClient();

            await messageHandler({
                event: {
                    user: 'U_EXTERNAL',
                    text: 'Help with CopilotKit integration',
                    ts: '1234567890.123456',
                    channel: 'C_MONITORED',
                },
                client,
            });

            // Should create a ticket
            expect(prisma.ticket.create).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    displayId: 'TKT-SL01',
                    source: 'SLACK',
                    sourceId: 'C_MONITORED:1234567890.123456',
                    status: 'OPEN',
                    priority: 'MEDIUM',
                    type: 'QUESTION',
                }),
            });

            // Should create the first message
            expect(prisma.message.create).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    ticketId: 'ticket-1',
                    type: 'USER',
                }),
            });

            // Should enqueue AI response
            expect(createJob).toHaveBeenCalledWith(
                JobType.AI_RESPONSE,
                expect.objectContaining({
                    ticketId: 'ticket-1',
                    source: 'slack',
                }),
            );

            // Should post acknowledgment in thread
            expect(client.chat.postMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    channel: 'C_MONITORED',
                    thread_ts: '1234567890.123456',
                    text: expect.stringContaining('TKT-SL01'),
                }),
            );
        });

        it('ignores messages in unmonitored channels', async () => {
            const client = makeMockClient();

            await messageHandler({
                event: {
                    user: 'U_EXTERNAL',
                    text: 'Hello',
                    ts: '1234567890.000000',
                    channel: 'C_OTHER',
                },
                client,
            });

            expect(prisma.ticket.create).not.toHaveBeenCalled();
        });

        it('ignores bot messages', async () => {
            const client = makeMockClient();

            await messageHandler({
                event: {
                    user: 'U_BOT',
                    bot_id: 'B_BOT',
                    text: 'Bot message',
                    ts: '1234567890.000000',
                    channel: 'C_MONITORED',
                },
                client,
            });

            expect(prisma.ticket.create).not.toHaveBeenCalled();
        });

        it('ignores message subtypes (edits, deletions, etc.)', async () => {
            const client = makeMockClient();

            await messageHandler({
                event: {
                    subtype: 'message_changed',
                    user: 'U_EXTERNAL',
                    text: 'Edited message',
                    ts: '1234567890.000000',
                    channel: 'C_MONITORED',
                },
                client,
            });

            expect(prisma.ticket.create).not.toHaveBeenCalled();
        });
    });

    describe('threaded replies', () => {
        beforeEach(() => {
            vi.mocked(prisma.ticket.findFirst).mockResolvedValue(
                TICKET as ReturnType<typeof prisma.ticket.findFirst> extends Promise<infer T> ? T : never,
            );
        });

        it('appends a message and enqueues AI response for non-team-member replies', async () => {
            const client = makeMockClient();

            await messageHandler({
                event: {
                    user: 'U_EXTERNAL',
                    text: 'I still need help with this',
                    ts: '1234567891.000000',
                    thread_ts: '1234567890.123456',
                    channel: 'C_MONITORED',
                },
                client,
            });

            expect(prisma.message.create).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    ticketId: 'ticket-1',
                    type: 'USER',
                }),
            });

            expect(createJob).toHaveBeenCalledWith(
                JobType.AI_RESPONSE,
                expect.objectContaining({
                    ticketId: 'ticket-1',
                    source: 'slack',
                }),
            );
        });

        it('does not enqueue AI response for team member replies', async () => {
            vi.mocked(prisma.user.findFirst).mockResolvedValue({
                id: 'u-1',
                email: 'team@copilotkit.ai',
            } as ReturnType<typeof prisma.user.findFirst> extends Promise<infer T> ? T : never);
            vi.mocked(prisma.teamMember.findUnique).mockResolvedValue({
                id: 'tm-1',
            } as ReturnType<typeof prisma.teamMember.findUnique> extends Promise<infer T> ? T : never);

            const client = makeMockClient();

            await messageHandler({
                event: {
                    user: 'U_TEAM',
                    text: 'Let me help you with that',
                    ts: '1234567891.000000',
                    thread_ts: '1234567890.123456',
                    channel: 'C_MONITORED',
                },
                client,
            });

            // Should still save the message
            expect(prisma.message.create).toHaveBeenCalled();

            // Should NOT enqueue AI response
            expect(createJob).not.toHaveBeenCalled();
        });

        it('reopens ticket when customer replies to a resolved ticket', async () => {
            vi.mocked(prisma.ticket.findFirst).mockResolvedValue({
                ...TICKET,
                status: 'RESOLVED',
            } as ReturnType<typeof prisma.ticket.findFirst> extends Promise<infer T> ? T : never);

            const client = makeMockClient();

            await messageHandler({
                event: {
                    user: 'U_EXTERNAL',
                    text: 'Actually this is still broken',
                    ts: '1234567891.000000',
                    thread_ts: '1234567890.123456',
                    channel: 'C_MONITORED',
                },
                client,
            });

            expect(prisma.ticket.update).toHaveBeenCalledWith({
                where: { id: 'ticket-1' },
                data: { status: 'OPEN' },
            });
        });

        it('ignores threaded replies in untracked threads', async () => {
            vi.mocked(prisma.ticket.findFirst).mockResolvedValue(null);

            const client = makeMockClient();

            await messageHandler({
                event: {
                    user: 'U_EXTERNAL',
                    text: 'Random reply',
                    ts: '1234567891.000000',
                    thread_ts: '9999999999.000000',
                    channel: 'C_MONITORED',
                },
                client,
            });

            expect(prisma.message.create).not.toHaveBeenCalled();
        });
    });
});
