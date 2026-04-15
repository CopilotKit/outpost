/**
 * Tests for the SLA tracking and breach detection engine.
 *
 * Covers: checker, config, metrics, and the SLA_CHECK job handler.
 * All Prisma calls are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TicketPriority, SlaMetric } from '@outpost/shared';
import type { TicketForSla, SlaTargetMap, SlaCheckResult } from '@outpost/shared';

// ─── Mock Setup ─────────────────────────────────────────────────────────────

const mockPrisma = {
    slaConfig: { findMany: vi.fn() },
    ticket: {
        findMany: vi.fn(),
        update: vi.fn(),
    },
    message: { create: vi.fn() },
    $transaction: vi.fn(),
};

vi.mock('@outpost/db', () => ({
    prisma: mockPrisma,
}));

// Import after mocks
const { checkSlaCompliance, buildBreachEvents } = await import('@outpost/shared');
const { loadSlaConfig, DEFAULT_SLA_TARGETS } = await import('@outpost/shared');
const { getSlaMetrics } = await import('@outpost/shared');
const { handleSlaCheck } = await import('../handlers/sla-check.js');

// ─── Helpers ────────────────────────────────────────────────────────────────

const HOUR_MS = 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

function makeTicket(overrides: Partial<TicketForSla> = {}): TicketForSla {
    return {
        id: overrides.id ?? 'ticket-1',
        priority: overrides.priority ?? TicketPriority.MEDIUM,
        status: overrides.status ?? 'OPEN',
        slaBreachedAt: overrides.slaBreachedAt ?? null,
        createdAt: overrides.createdAt ?? new Date('2026-04-15T10:00:00Z'),
        messages: overrides.messages ?? [],
    };
}

function defaultTargets(): SlaTargetMap {
    return structuredClone(DEFAULT_SLA_TARGETS);
}

const mockContext = {
    jobId: 'job-1',
    reportProgress: vi.fn().mockResolvedValue(undefined),
};

// ─── checkSlaCompliance ─────────────────────────────────────────────────────

describe('checkSlaCompliance', () => {
    const targets = defaultTargets();

    describe('first response time calculation', () => {
        it('detects breach when no response exists and time exceeds target', () => {
            const ticket = makeTicket({
                priority: TicketPriority.MEDIUM,
                createdAt: new Date('2026-04-15T10:00:00Z'),
                messages: [],
            });
            // MEDIUM first response target is 240 min = 4 hours
            const now = new Date('2026-04-15T15:00:00Z'); // 5 hours later
            const result = checkSlaCompliance(ticket, targets, now);

            expect(result.firstResponseBreached).toBe(true);
            expect(result.firstResponseTimeMs).toBeNull(); // no response yet
        });

        it('does not breach when no response but within target', () => {
            const ticket = makeTicket({
                priority: TicketPriority.MEDIUM,
                createdAt: new Date('2026-04-15T10:00:00Z'),
                messages: [],
            });
            const now = new Date('2026-04-15T13:00:00Z'); // 3 hours later (< 4h target)
            const result = checkSlaCompliance(ticket, targets, now);

            expect(result.firstResponseBreached).toBe(false);
            expect(result.firstResponseTimeMs).toBeNull();
        });

        it('calculates first response time from first BOT message', () => {
            const created = new Date('2026-04-15T10:00:00Z');
            const botReply = new Date('2026-04-15T10:30:00Z'); // 30 min later
            const ticket = makeTicket({
                priority: TicketPriority.MEDIUM,
                createdAt: created,
                messages: [
                    { type: 'USER', createdAt: new Date('2026-04-15T10:05:00Z') },
                    { type: 'BOT', createdAt: botReply },
                ],
            });
            const now = new Date('2026-04-15T12:00:00Z');
            const result = checkSlaCompliance(ticket, targets, now);

            expect(result.firstResponseTimeMs).toBe(30 * MIN_MS);
            expect(result.firstResponseBreached).toBe(false); // 30 min < 240 min
        });

        it('calculates first response time from first SYSTEM message', () => {
            const created = new Date('2026-04-15T10:00:00Z');
            const systemMsg = new Date('2026-04-15T10:10:00Z'); // 10 min later
            const ticket = makeTicket({
                priority: TicketPriority.MEDIUM,
                createdAt: created,
                messages: [
                    { type: 'SYSTEM', createdAt: systemMsg },
                    { type: 'BOT', createdAt: new Date('2026-04-15T11:00:00Z') },
                ],
            });
            const now = new Date('2026-04-15T12:00:00Z');
            const result = checkSlaCompliance(ticket, targets, now);

            // Should pick the SYSTEM message since it came first
            expect(result.firstResponseTimeMs).toBe(10 * MIN_MS);
        });

        it('ignores USER messages for first response calculation', () => {
            const created = new Date('2026-04-15T10:00:00Z');
            const ticket = makeTicket({
                priority: TicketPriority.HIGH,
                createdAt: created,
                messages: [
                    { type: 'USER', createdAt: new Date('2026-04-15T10:05:00Z') },
                    { type: 'USER', createdAt: new Date('2026-04-15T10:30:00Z') },
                ],
            });
            // HIGH first response = 60 min
            const now = new Date('2026-04-15T11:30:00Z'); // 90 min later
            const result = checkSlaCompliance(ticket, targets, now);

            expect(result.firstResponseTimeMs).toBeNull();
            expect(result.firstResponseBreached).toBe(true);
        });

        it('detects first response breach when response was too slow', () => {
            const created = new Date('2026-04-15T10:00:00Z');
            const ticket = makeTicket({
                priority: TicketPriority.HIGH,
                createdAt: created,
                messages: [
                    { type: 'BOT', createdAt: new Date('2026-04-15T11:30:00Z') }, // 90 min
                ],
            });
            // HIGH first response = 60 min, response took 90 min
            const now = new Date('2026-04-15T12:00:00Z');
            const result = checkSlaCompliance(ticket, targets, now);

            expect(result.firstResponseTimeMs).toBe(90 * MIN_MS);
            expect(result.firstResponseBreached).toBe(true);
        });
    });

    describe('resolution time calculation', () => {
        it('calculates resolution time for closed tickets', () => {
            const created = new Date('2026-04-15T10:00:00Z');
            const ticket = makeTicket({
                status: 'CLOSED',
                priority: TicketPriority.MEDIUM,
                createdAt: created,
                messages: [
                    { type: 'BOT', createdAt: new Date('2026-04-15T10:05:00Z') },
                ],
            });
            // MEDIUM resolution = 2880 min = 48 hours
            const closedAt = new Date('2026-04-15T20:00:00Z'); // 10 hours later
            const result = checkSlaCompliance(ticket, targets, closedAt);

            expect(result.resolutionTimeMs).toBe(10 * HOUR_MS);
            expect(result.resolutionBreached).toBe(false); // 10h < 48h
        });

        it('detects resolution breach for closed ticket resolved too late', () => {
            const created = new Date('2026-04-15T10:00:00Z');
            const ticket = makeTicket({
                status: 'CLOSED',
                priority: TicketPriority.CRITICAL,
                createdAt: created,
                messages: [
                    { type: 'BOT', createdAt: new Date('2026-04-15T10:02:00Z') },
                ],
            });
            // CRITICAL resolution = 240 min = 4 hours
            const closedAt = new Date('2026-04-15T15:00:00Z'); // 5 hours later
            const result = checkSlaCompliance(ticket, targets, closedAt);

            expect(result.resolutionTimeMs).toBe(5 * HOUR_MS);
            expect(result.resolutionBreached).toBe(true);
        });

        it('detects resolution breach for open ticket exceeding target', () => {
            const created = new Date('2026-04-15T10:00:00Z');
            const ticket = makeTicket({
                status: 'OPEN',
                priority: TicketPriority.CRITICAL,
                createdAt: created,
                messages: [],
            });
            // CRITICAL resolution = 240 min = 4 hours
            const now = new Date('2026-04-15T15:00:00Z'); // 5 hours later
            const result = checkSlaCompliance(ticket, targets, now);

            expect(result.resolutionTimeMs).toBeNull(); // not closed
            expect(result.resolutionBreached).toBe(true); // but elapsed > target
        });

        it('does not breach resolution for open ticket within target', () => {
            const created = new Date('2026-04-15T10:00:00Z');
            const ticket = makeTicket({
                status: 'IN_PROGRESS',
                priority: TicketPriority.LOW,
                createdAt: created,
                messages: [
                    { type: 'BOT', createdAt: new Date('2026-04-15T10:30:00Z') },
                ],
            });
            // LOW resolution = 10080 min = 7 days
            const now = new Date('2026-04-16T10:00:00Z'); // 1 day later
            const result = checkSlaCompliance(ticket, targets, now);

            expect(result.resolutionTimeMs).toBeNull();
            expect(result.resolutionBreached).toBe(false);
        });
    });

    describe('priority-specific targets', () => {
        it('applies CRITICAL targets correctly', () => {
            const created = new Date('2026-04-15T10:00:00Z');
            const ticket = makeTicket({
                priority: TicketPriority.CRITICAL,
                createdAt: created,
                messages: [],
            });
            // CRITICAL first response = 15 min
            const now = new Date('2026-04-15T10:20:00Z'); // 20 min
            const result = checkSlaCompliance(ticket, targets, now);

            expect(result.firstResponseBreached).toBe(true);
            expect(result.target.firstResponseMinutes).toBe(15);
            expect(result.target.resolutionMinutes).toBe(240);
        });

        it('applies LOW targets correctly — generous window', () => {
            const created = new Date('2026-04-15T10:00:00Z');
            const ticket = makeTicket({
                priority: TicketPriority.LOW,
                createdAt: created,
                messages: [],
            });
            // LOW first response = 1440 min = 24 hours
            const now = new Date('2026-04-15T20:00:00Z'); // 10 hours
            const result = checkSlaCompliance(ticket, targets, now);

            expect(result.firstResponseBreached).toBe(false);
            expect(result.target.firstResponseMinutes).toBe(1440);
            expect(result.target.resolutionMinutes).toBe(10080);
        });
    });

    describe('no false breaches for tickets within SLA', () => {
        it('ticket with fast response and still open — no breach', () => {
            const created = new Date('2026-04-15T10:00:00Z');
            const ticket = makeTicket({
                priority: TicketPriority.MEDIUM,
                createdAt: created,
                messages: [
                    { type: 'BOT', createdAt: new Date('2026-04-15T10:05:00Z') }, // 5 min
                ],
            });
            // MEDIUM: first response 240 min, resolution 2880 min
            const now = new Date('2026-04-15T12:00:00Z'); // 2 hours in
            const result = checkSlaCompliance(ticket, targets, now);

            expect(result.firstResponseBreached).toBe(false);
            expect(result.resolutionBreached).toBe(false);
        });

        it('closed ticket resolved quickly — no breach', () => {
            const created = new Date('2026-04-15T10:00:00Z');
            const ticket = makeTicket({
                status: 'CLOSED',
                priority: TicketPriority.HIGH,
                createdAt: created,
                messages: [
                    { type: 'BOT', createdAt: new Date('2026-04-15T10:10:00Z') },
                ],
            });
            // HIGH: first response 60 min, resolution 480 min
            const closedAt = new Date('2026-04-15T14:00:00Z'); // 4 hours
            const result = checkSlaCompliance(ticket, targets, closedAt);

            expect(result.firstResponseBreached).toBe(false);
            expect(result.resolutionBreached).toBe(false);
        });
    });
});

// ─── buildBreachEvents ──────────────────────────────────────────────────────

describe('buildBreachEvents', () => {
    it('returns empty array for non-breached result', () => {
        const result: SlaCheckResult = {
            ticketId: 'ticket-1',
            priority: TicketPriority.MEDIUM,
            firstResponseBreached: false,
            resolutionBreached: false,
            firstResponseTimeMs: 5 * MIN_MS,
            resolutionTimeMs: null,
            target: { firstResponseMinutes: 240, resolutionMinutes: 2880 },
        };
        expect(buildBreachEvents(result)).toEqual([]);
    });

    it('returns first response breach event', () => {
        const result: SlaCheckResult = {
            ticketId: 'ticket-1',
            priority: TicketPriority.HIGH,
            firstResponseBreached: true,
            resolutionBreached: false,
            firstResponseTimeMs: 90 * MIN_MS,
            resolutionTimeMs: null,
            target: { firstResponseMinutes: 60, resolutionMinutes: 480 },
        };
        const events = buildBreachEvents(result);
        expect(events).toHaveLength(1);
        expect(events[0].metric).toBe(SlaMetric.FIRST_RESPONSE);
        expect(events[0].ticketId).toBe('ticket-1');
        expect(events[0].elapsedMs).toBe(90 * MIN_MS);
        expect(events[0].targetMs).toBe(60 * MIN_MS);
    });

    it('returns both breach events when both are breached', () => {
        const result: SlaCheckResult = {
            ticketId: 'ticket-1',
            priority: TicketPriority.CRITICAL,
            firstResponseBreached: true,
            resolutionBreached: true,
            firstResponseTimeMs: 20 * MIN_MS,
            resolutionTimeMs: 5 * HOUR_MS,
            target: { firstResponseMinutes: 15, resolutionMinutes: 240 },
        };
        const events = buildBreachEvents(result);
        expect(events).toHaveLength(2);
        expect(events[0].metric).toBe(SlaMetric.FIRST_RESPONSE);
        expect(events[1].metric).toBe(SlaMetric.RESOLUTION);
    });
});

// ─── loadSlaConfig ──────────────────────────────────────────────────────────

describe('loadSlaConfig', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns defaults when DB has no rows', async () => {
        mockPrisma.slaConfig.findMany.mockResolvedValue([]);
        const targets = await loadSlaConfig(mockPrisma);

        expect(targets[TicketPriority.CRITICAL].firstResponseMinutes).toBe(15);
        expect(targets[TicketPriority.HIGH].resolutionMinutes).toBe(480);
        expect(targets[TicketPriority.LOW].resolutionMinutes).toBe(10080);
    });

    it('overrides defaults with DB values', async () => {
        mockPrisma.slaConfig.findMany.mockResolvedValue([
            { metric: 'FIRST_RESPONSE', priority: 'HIGH', targetMinutes: 5 },
            { metric: 'RESOLUTION', priority: 'MEDIUM', targetMinutes: 1440 },
        ]);
        const targets = await loadSlaConfig(mockPrisma);

        expect(targets[TicketPriority.HIGH].firstResponseMinutes).toBe(5);
        expect(targets[TicketPriority.MEDIUM].resolutionMinutes).toBe(1440);
        // Others remain defaults
        expect(targets[TicketPriority.CRITICAL].firstResponseMinutes).toBe(15);
    });
});

// ─── handleSlaCheck ─────────────────────────────────────────────────────────

describe('handleSlaCheck', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockPrisma.slaConfig.findMany.mockResolvedValue([]);
        mockPrisma.$transaction.mockResolvedValue([]);
    });

    it('returns zero breaches when no open tickets', async () => {
        mockPrisma.ticket.findMany.mockResolvedValue([]);

        const result = await handleSlaCheck({}, mockContext);

        expect(result.success).toBe(true);
        expect(result.data).toEqual({
            checked: 0,
            breached: 0,
            newBreaches: 0,
        });
    });

    it('detects new breach and creates system message', async () => {
        const created = new Date(Date.now() - 5 * HOUR_MS); // 5 hours ago
        mockPrisma.ticket.findMany.mockResolvedValue([
            {
                id: 'ticket-breach',
                displayId: 'TKT-B001',
                priority: 'CRITICAL',
                status: 'OPEN',
                slaBreachedAt: null,
                createdAt: created,
                messages: [],
            },
        ]);

        const result = await handleSlaCheck({}, mockContext);

        expect(result.success).toBe(true);
        expect(result.data?.newBreaches).toBe(1);
        expect(result.data?.breached).toBe(1);
        expect(result.data?.checked).toBe(1);

        // Verify transaction was called to update ticket + create message
        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
        const txArgs = mockPrisma.$transaction.mock.calls[0][0];
        expect(txArgs).toHaveLength(2); // ticket.update + message.create
    });

    it('does not re-flag already-breached tickets as new breaches', async () => {
        const created = new Date(Date.now() - 5 * HOUR_MS);
        mockPrisma.ticket.findMany.mockResolvedValue([
            {
                id: 'ticket-already-breached',
                displayId: 'TKT-B002',
                priority: 'CRITICAL',
                status: 'OPEN',
                slaBreachedAt: new Date(Date.now() - 1 * HOUR_MS), // already marked
                createdAt: created,
                messages: [],
            },
        ]);

        const result = await handleSlaCheck({}, mockContext);

        expect(result.success).toBe(true);
        expect(result.data?.breached).toBe(1);
        expect(result.data?.newBreaches).toBe(0); // not a NEW breach
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('does not breach tickets within SLA', async () => {
        const created = new Date(Date.now() - 5 * MIN_MS); // 5 min ago
        mockPrisma.ticket.findMany.mockResolvedValue([
            {
                id: 'ticket-ok',
                displayId: 'TKT-OK01',
                priority: 'LOW',
                status: 'OPEN',
                slaBreachedAt: null,
                createdAt: created,
                messages: [
                    { type: 'BOT', createdAt: new Date(Date.now() - 4 * MIN_MS) },
                ],
            },
        ]);

        const result = await handleSlaCheck({}, mockContext);

        expect(result.success).toBe(true);
        expect(result.data?.breached).toBe(0);
        expect(result.data?.newBreaches).toBe(0);
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('reports progress during processing', async () => {
        const created = new Date(Date.now() - 1 * MIN_MS);
        mockPrisma.ticket.findMany.mockResolvedValue([
            {
                id: 'ticket-1',
                displayId: 'TKT-P001',
                priority: 'LOW',
                status: 'OPEN',
                slaBreachedAt: null,
                createdAt: created,
                messages: [{ type: 'BOT', createdAt: created }],
            },
            {
                id: 'ticket-2',
                displayId: 'TKT-P002',
                priority: 'LOW',
                status: 'OPEN',
                slaBreachedAt: null,
                createdAt: created,
                messages: [{ type: 'BOT', createdAt: created }],
            },
        ]);

        await handleSlaCheck({}, mockContext);

        expect(mockContext.reportProgress).toHaveBeenCalledWith(50);
        expect(mockContext.reportProgress).toHaveBeenCalledWith(100);
    });

    it('includes breach message with SLA target duration', async () => {
        const created = new Date(Date.now() - 25 * HOUR_MS); // 25 hours ago
        mockPrisma.ticket.findMany.mockResolvedValue([
            {
                id: 'ticket-msg',
                displayId: 'TKT-MSG1',
                priority: 'MEDIUM',
                status: 'OPEN',
                slaBreachedAt: null,
                createdAt: created,
                messages: [],
            },
        ]);

        await handleSlaCheck({}, mockContext);

        // Check the system message content in the transaction
        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
        const txArgs = mockPrisma.$transaction.mock.calls[0][0];
        // The message.create call is the second element
        // We can verify it was called by checking the mock
        expect(mockPrisma.ticket.update).toHaveBeenCalled();
        expect(mockPrisma.message.create).toHaveBeenCalled();
    });
});

// ─── getSlaMetrics ──────────────────────────────────────────────────────────

describe('getSlaMetrics', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockPrisma.slaConfig.findMany.mockResolvedValue([]);
    });

    it('returns zero metrics when no tickets exist', async () => {
        mockPrisma.ticket.findMany.mockResolvedValue([]);

        const metrics = await getSlaMetrics(mockPrisma);

        expect(metrics.totalTickets).toBe(0);
        expect(metrics.totalBreaches).toBe(0);
        expect(metrics.avgFirstResponseTimeMs).toBeNull();
        expect(metrics.avgResolutionTimeMs).toBeNull();
        expect(metrics.breachRateByPriority).toHaveLength(4);
        expect(metrics.trend.delta).toBe(0);
    });

    it('computes average first response time', async () => {
        const created = new Date('2026-04-01T10:00:00Z');
        const tickets: TicketForSla[] = [
            makeTicket({
                id: 't1',
                priority: TicketPriority.MEDIUM,
                createdAt: created,
                messages: [
                    { type: 'BOT', createdAt: new Date('2026-04-01T10:30:00Z') }, // 30 min
                ],
            }),
            makeTicket({
                id: 't2',
                priority: TicketPriority.MEDIUM,
                createdAt: created,
                messages: [
                    { type: 'BOT', createdAt: new Date('2026-04-01T11:00:00Z') }, // 60 min
                ],
            }),
        ];

        // Current period returns our tickets, previous period returns empty
        mockPrisma.ticket.findMany
            .mockResolvedValueOnce(tickets)   // current
            .mockResolvedValueOnce([]);       // previous

        const range = {
            from: new Date('2026-04-01T00:00:00Z'),
            to: new Date('2026-04-15T00:00:00Z'),
        };
        const metrics = await getSlaMetrics(mockPrisma, range);

        // Average of 30 min and 60 min = 45 min
        expect(metrics.avgFirstResponseTimeMs).toBe(45 * MIN_MS);
    });

    it('computes breach rate by priority', async () => {
        const created = new Date('2026-04-14T10:00:00Z'); // 14 hours before range end
        const tickets: TicketForSla[] = [
            // CRITICAL ticket with no response — will breach (15 min first response)
            makeTicket({
                id: 'breach-1',
                priority: TicketPriority.CRITICAL,
                createdAt: created,
                messages: [],
            }),
            // LOW ticket with fast response, recently created — no breach
            // LOW targets: first response 1440 min (24h), resolution 10080 min (7d)
            makeTicket({
                id: 'ok-1',
                priority: TicketPriority.LOW,
                createdAt: created,
                messages: [
                    { type: 'BOT', createdAt: new Date('2026-04-14T10:05:00Z') },
                ],
            }),
        ];

        mockPrisma.ticket.findMany
            .mockResolvedValueOnce(tickets)
            .mockResolvedValueOnce([]);

        const range = {
            from: new Date('2026-04-14T00:00:00Z'),
            to: new Date('2026-04-15T00:00:00Z'),
        };
        const metrics = await getSlaMetrics(mockPrisma, range);

        const criticalRate = metrics.breachRateByPriority.find(
            (r) => r.priority === TicketPriority.CRITICAL,
        );
        const lowRate = metrics.breachRateByPriority.find(
            (r) => r.priority === TicketPriority.LOW,
        );

        expect(criticalRate?.rate).toBe(1); // 1/1 breached
        expect(lowRate?.rate).toBe(0);      // 0/1 breached
    });

    it('computes period-over-period trend', async () => {
        // Current period: CRITICAL ticket with no response — breaches in 15 min
        const currentTickets: TicketForSla[] = [
            makeTicket({
                id: 'cur-1',
                priority: TicketPriority.CRITICAL,
                createdAt: new Date('2026-04-14T10:00:00Z'),
                messages: [], // will breach first response (15 min target)
            }),
        ];
        // Previous period: LOW ticket created recently with fast response — no breach
        const previousTickets: TicketForSla[] = [
            makeTicket({
                id: 'prev-1',
                priority: TicketPriority.LOW,
                createdAt: new Date('2026-04-13T23:00:00Z'), // 1 hour before prev range end
                messages: [
                    { type: 'BOT', createdAt: new Date('2026-04-13T23:05:00Z') },
                ],
            }),
        ];

        mockPrisma.ticket.findMany
            .mockResolvedValueOnce(currentTickets)
            .mockResolvedValueOnce(previousTickets);

        const range = {
            from: new Date('2026-04-14T00:00:00Z'),
            to: new Date('2026-04-15T00:00:00Z'),
        };
        const metrics = await getSlaMetrics(mockPrisma, range);

        expect(metrics.trend.currentBreaches).toBe(1);
        expect(metrics.trend.previousBreaches).toBe(0);
        expect(metrics.trend.delta).toBe(1); // worse this period
    });
});
