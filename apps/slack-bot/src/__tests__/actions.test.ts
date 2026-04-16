import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { registerActionHandlers } from '../events/actions.js';
import { prisma } from '@outpost/db';
import { createJob, JobType } from '@outpost/queue';

const TICKET = {
    id: 'ticket-1',
    displayId: 'TKT-SL01',
    status: 'OPEN',
    priority: 'MEDIUM',
    source: 'SLACK',
    sourceId: 'C_CHAN:1234567890.123456',
};

// Capture action handlers
const actionHandlers: Record<string, (args: Record<string, unknown>) => Promise<void>> = {};

function makeMockApp() {
    return {
        action: vi.fn((actionId: string, handler: (args: Record<string, unknown>) => Promise<void>) => {
            actionHandlers[actionId] = handler;
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

describe('registerActionHandlers', () => {
    beforeEach(() => {
        const app = makeMockApp();
        registerActionHandlers(app as unknown as Parameters<typeof registerActionHandlers>[0]);

        vi.mocked(prisma.ticket.findFirst).mockResolvedValue(
            TICKET as ReturnType<typeof prisma.ticket.findFirst> extends Promise<infer T> ? T : never,
        );
        vi.mocked(prisma.ticket.update).mockResolvedValue(
            TICKET as ReturnType<typeof prisma.ticket.update> extends Promise<infer T> ? T : never,
        );
        vi.mocked(prisma.message.create).mockResolvedValue({
            id: 'msg-1',
        } as ReturnType<typeof prisma.message.create> extends Promise<infer T> ? T : never);
    });

    it('registers both action handlers', () => {
        expect(actionHandlers['issue_solved']).toBeDefined();
        expect(actionHandlers['need_more_help']).toBeDefined();
    });

    describe('issue_solved', () => {
        it('closes the ticket and posts confirmation', async () => {
            const client = makeMockClient();
            const ack = vi.fn();

            await actionHandlers['issue_solved']({
                ack,
                body: {
                    user: { id: 'U_USER' },
                    channel: { id: 'C_CHAN' },
                    message: { thread_ts: '1234567890.123456' },
                },
                client,
            });

            expect(ack).toHaveBeenCalled();

            expect(prisma.ticket.update).toHaveBeenCalledWith({
                where: { id: 'ticket-1' },
                data: { status: 'CLOSED' },
            });

            expect(prisma.message.create).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    ticketId: 'ticket-1',
                    type: 'SYSTEM',
                    content: expect.stringContaining('solved'),
                }),
            });

            expect(client.chat.postMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    text: expect.stringContaining('Glad we could help'),
                }),
            );
        });

        it('posts error when no ticket found', async () => {
            vi.mocked(prisma.ticket.findFirst).mockResolvedValue(null);
            const client = makeMockClient();
            const ack = vi.fn();

            await actionHandlers['issue_solved']({
                ack,
                body: {
                    user: { id: 'U_USER' },
                    channel: { id: 'C_CHAN' },
                    message: { thread_ts: '9999999999.000000' },
                },
                client,
            });

            expect(ack).toHaveBeenCalled();
            expect(prisma.ticket.update).not.toHaveBeenCalled();
            expect(client.chat.postMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    text: expect.stringContaining('No ticket found'),
                }),
            );
        });
    });

    describe('need_more_help', () => {
        it('escalates the ticket and notifies team', async () => {
            const client = makeMockClient();
            const ack = vi.fn();

            await actionHandlers['need_more_help']({
                ack,
                body: {
                    user: { id: 'U_USER' },
                    channel: { id: 'C_CHAN' },
                    message: { thread_ts: '1234567890.123456' },
                },
                client,
            });

            expect(ack).toHaveBeenCalled();

            expect(prisma.ticket.update).toHaveBeenCalledWith({
                where: { id: 'ticket-1' },
                data: { status: 'WAITING_ON_TEAM' },
            });

            expect(createJob).toHaveBeenCalledWith(
                JobType.ESCALATION,
                expect.objectContaining({
                    ticketId: 'ticket-1',
                    reason: expect.stringContaining('Need more help'),
                }),
            );

            expect(client.chat.postMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    text: expect.stringContaining('team member has been notified'),
                }),
            );
        });

        it('handles missing thread context gracefully', async () => {
            const client = makeMockClient();
            const ack = vi.fn();

            await actionHandlers['need_more_help']({
                ack,
                body: {
                    user: { id: 'U_USER' },
                    channel: { id: 'C_CHAN' },
                    // No message.thread_ts
                },
                client,
            });

            expect(ack).toHaveBeenCalled();
            expect(prisma.ticket.update).not.toHaveBeenCalled();
        });
    });
});
