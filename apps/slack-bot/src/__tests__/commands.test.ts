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

import { registerCommands } from '../commands/index.js';
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

// Capture command handlers
const commandHandlers: Record<string, (args: Record<string, unknown>) => Promise<void>> = {};

function makeMockApp() {
    return {
        action: vi.fn(),
        command: vi.fn((commandName: string, handler: (args: Record<string, unknown>) => Promise<void>) => {
            commandHandlers[commandName] = handler;
        }),
        event: vi.fn(),
    };
}

function makeMockClient() {
    return {
        chat: {
            postMessage: vi.fn().mockResolvedValue({ ok: true }),
            postEphemeral: vi.fn().mockResolvedValue({ ok: true }),
        },
    };
}

function makeCommand(overrides: Record<string, unknown> = {}) {
    return {
        channel_id: 'C_CHAN',
        user_id: 'U_ADMIN',
        text: '',
        ...overrides,
    };
}

describe('slash commands', () => {
    beforeEach(() => {
        const app = makeMockApp();
        registerCommands(app as unknown as Parameters<typeof registerCommands>[0]);

        vi.mocked(prisma.ticket.findFirst).mockResolvedValue(
            TICKET as ReturnType<typeof prisma.ticket.findFirst> extends Promise<infer T> ? T : never,
        );
        vi.mocked(prisma.ticket.update).mockResolvedValue(
            TICKET as ReturnType<typeof prisma.ticket.update> extends Promise<infer T> ? T : never,
        );
        vi.mocked(prisma.note.create).mockResolvedValue({
            id: 'note-1',
        } as ReturnType<typeof prisma.note.create> extends Promise<infer T> ? T : never);
        vi.mocked(prisma.user.findFirst).mockResolvedValue(null);
    });

    it('registers all four commands', () => {
        expect(commandHandlers['/outpost-assign']).toBeDefined();
        expect(commandHandlers['/outpost-close']).toBeDefined();
        expect(commandHandlers['/outpost-escalate']).toBeDefined();
        expect(commandHandlers['/outpost-priority']).toBeDefined();
    });

    describe('/outpost-assign', () => {
        it('assigns a ticket to a mentioned user', async () => {
            const client = makeMockClient();
            const ack = vi.fn();

            await commandHandlers['/outpost-assign']({
                ack,
                command: makeCommand({ text: '<@U0ENGINEER|engineer>' }),
                client,
            });

            expect(ack).toHaveBeenCalled();

            expect(prisma.ticket.update).toHaveBeenCalledWith({
                where: { id: 'ticket-1' },
                data: expect.objectContaining({
                    status: 'IN_PROGRESS',
                }),
            });

            expect(prisma.note.create).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    ticketId: 'ticket-1',
                    content: expect.stringContaining('U0ENGINEER'),
                }),
            });

            expect(client.chat.postMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    text: expect.stringContaining('assigned'),
                }),
            );
        });

        it('shows usage when no user mentioned', async () => {
            const client = makeMockClient();
            const ack = vi.fn();

            await commandHandlers['/outpost-assign']({
                ack,
                command: makeCommand({ text: '' }),
                client,
            });

            expect(ack).toHaveBeenCalled();
            expect(client.chat.postEphemeral).toHaveBeenCalledWith(
                expect.objectContaining({
                    text: expect.stringContaining('Usage'),
                }),
            );
            expect(prisma.ticket.update).not.toHaveBeenCalled();
        });

        it('shows error when no open ticket found', async () => {
            vi.mocked(prisma.ticket.findFirst).mockResolvedValue(null);
            const client = makeMockClient();
            const ack = vi.fn();

            await commandHandlers['/outpost-assign']({
                ack,
                command: makeCommand({ text: '<@U0ENGINEER>' }),
                client,
            });

            expect(ack).toHaveBeenCalled();
            expect(client.chat.postEphemeral).toHaveBeenCalledWith(
                expect.objectContaining({
                    text: expect.stringContaining('No open ticket'),
                }),
            );
        });
    });

    describe('/outpost-close', () => {
        it('closes the ticket with a reason', async () => {
            const client = makeMockClient();
            const ack = vi.fn();

            await commandHandlers['/outpost-close']({
                ack,
                command: makeCommand({ text: 'Duplicate issue' }),
                client,
            });

            expect(ack).toHaveBeenCalled();

            expect(prisma.ticket.update).toHaveBeenCalledWith({
                where: { id: 'ticket-1' },
                data: { status: 'CLOSED' },
            });

            expect(prisma.note.create).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    content: expect.stringContaining('Duplicate issue'),
                }),
            });

            expect(client.chat.postMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    text: expect.stringContaining('closed'),
                }),
            );
        });

        it('uses default reason when none provided', async () => {
            const client = makeMockClient();
            const ack = vi.fn();

            await commandHandlers['/outpost-close']({
                ack,
                command: makeCommand({ text: '' }),
                client,
            });

            expect(prisma.note.create).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    content: expect.stringContaining('Resolved'),
                }),
            });
        });

        it('shows error when no ticket found', async () => {
            vi.mocked(prisma.ticket.findFirst).mockResolvedValue(null);
            const client = makeMockClient();
            const ack = vi.fn();

            await commandHandlers['/outpost-close']({
                ack,
                command: makeCommand(),
                client,
            });

            expect(client.chat.postEphemeral).toHaveBeenCalledWith(
                expect.objectContaining({
                    text: expect.stringContaining('No open ticket'),
                }),
            );
        });
    });

    describe('/outpost-escalate', () => {
        it('escalates the ticket to HIGH priority', async () => {
            const client = makeMockClient();
            const ack = vi.fn();

            await commandHandlers['/outpost-escalate']({
                ack,
                command: makeCommand({ text: 'Production is down' }),
                client,
            });

            expect(ack).toHaveBeenCalled();

            expect(prisma.ticket.update).toHaveBeenCalledWith({
                where: { id: 'ticket-1' },
                data: {
                    priority: 'HIGH',
                    status: 'WAITING_ON_TEAM',
                },
            });

            expect(createJob).toHaveBeenCalledWith(
                JobType.ESCALATION,
                expect.objectContaining({
                    ticketId: 'ticket-1',
                    reason: expect.stringContaining('Production is down'),
                }),
            );
        });

        it('keeps CRITICAL priority if already critical', async () => {
            vi.mocked(prisma.ticket.findFirst).mockResolvedValue({
                ...TICKET,
                priority: 'CRITICAL',
            } as ReturnType<typeof prisma.ticket.findFirst> extends Promise<infer T> ? T : never);

            const client = makeMockClient();
            const ack = vi.fn();

            await commandHandlers['/outpost-escalate']({
                ack,
                command: makeCommand(),
                client,
            });

            expect(prisma.ticket.update).toHaveBeenCalledWith({
                where: { id: 'ticket-1' },
                data: expect.objectContaining({
                    priority: 'CRITICAL',
                }),
            });
        });
    });

    describe('/outpost-priority', () => {
        it('updates ticket priority', async () => {
            const client = makeMockClient();
            const ack = vi.fn();

            await commandHandlers['/outpost-priority']({
                ack,
                command: makeCommand({ text: 'high' }),
                client,
            });

            expect(ack).toHaveBeenCalled();

            expect(prisma.ticket.update).toHaveBeenCalledWith({
                where: { id: 'ticket-1' },
                data: { priority: 'HIGH' },
            });

            expect(prisma.note.create).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    content: expect.stringContaining('MEDIUM to HIGH'),
                }),
            });
        });

        it('rejects invalid priority levels', async () => {
            const client = makeMockClient();
            const ack = vi.fn();

            await commandHandlers['/outpost-priority']({
                ack,
                command: makeCommand({ text: 'urgent' }),
                client,
            });

            expect(ack).toHaveBeenCalled();
            expect(client.chat.postEphemeral).toHaveBeenCalledWith(
                expect.objectContaining({
                    text: expect.stringContaining('Invalid priority'),
                }),
            );
            expect(prisma.ticket.update).not.toHaveBeenCalled();
        });

        it('shows error when no ticket found', async () => {
            vi.mocked(prisma.ticket.findFirst).mockResolvedValue(null);
            const client = makeMockClient();
            const ack = vi.fn();

            await commandHandlers['/outpost-priority']({
                ack,
                command: makeCommand({ text: 'low' }),
                client,
            });

            expect(client.chat.postEphemeral).toHaveBeenCalledWith(
                expect.objectContaining({
                    text: expect.stringContaining('No open ticket'),
                }),
            );
        });
    });
});
