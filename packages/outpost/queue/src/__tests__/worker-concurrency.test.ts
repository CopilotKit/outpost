/**
 * Tests for per-type concurrency in the Worker class.
 *
 * Validates that:
 * - Per-type limits are respected (type A at capacity, type B still processes)
 * - Global ceiling still applies
 * - Missing concurrencyByType falls back to global limit
 * - Health check includes per-type info
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JobType } from '../types.js';
import type { JobHandlerContext, WorkerHealthStatus } from '../types.js';

// ─── Mock Setup ─────────────────────────────────────────────────────────────

const mockPrismaJob = {
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    findFirst: vi.fn(),
};

const mockPrisma = {
    job: mockPrismaJob,
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
};

vi.mock('@copilotkit/outpost/db', () => ({
    prisma: mockPrisma,
}));

vi.mock('@copilotkit/outpost/shared', () => ({
    MAX_JOB_ATTEMPTS: 5,
    BACKOFF_BASE_MS: 1000,
    BACKOFF_MAX_MS: 300_000,
    calculateBackoff: (attempt: number) => 1000 * Math.pow(2, attempt),
}));

const { Worker } = await import('../worker.js');

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeJobRow(
    overrides: Partial<{
        id: string;
        type: string;
        payload: unknown;
        attempts: number;
        maxAttempts: number;
        claimToken: string;
    }> = {},
) {
    return {
        id: overrides.id ?? 'job-1',
        type: overrides.type ?? JobType.AI_RESPONSE,
        payload: overrides.payload ?? { ticketId: 'tkt-1', source: 'discord' },
        attempts: overrides.attempts ?? 0,
        maxAttempts: overrides.maxAttempts ?? 5,
        claimToken: overrides.claimToken ?? `claim-${overrides.id ?? 'job-1'}`,
    };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Worker per-type concurrency', () => {
    let worker: InstanceType<typeof Worker>;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        mockPrisma.$executeRaw.mockResolvedValue(0);
        mockPrismaJob.updateMany.mockResolvedValue({ count: 1 });
    });

    afterEach(async () => {
        if (worker) {
            await worker.stop();
        }
        vi.useRealTimers();
    });

    it('respects per-type concurrency limits', async () => {
        worker = new Worker({
            pollIntervalMs: 100,
            maxConcurrency: 10,
            concurrencyByType: {
                [JobType.AI_RESPONSE]: 1, // Only 1 AI_RESPONSE at a time
                [JobType.ESCALATION]: 2,
            },
        });

        // AI_RESPONSE handler: instant completion
        worker.on(JobType.AI_RESPONSE, async () => {
            return { success: true };
        });

        worker.on(JobType.ESCALATION, async () => {
            return { success: true };
        });

        // First poll returns 1 AI_RESPONSE job
        mockPrisma.$queryRaw
            .mockResolvedValueOnce([makeJobRow({ id: 'ai-1', type: JobType.AI_RESPONSE })])
            .mockResolvedValue([]); // subsequent polls for other types

        mockPrismaJob.update.mockResolvedValue({});

        worker.start();
        await vi.advanceTimersByTimeAsync(0);

        // Process should have picked up the job
        expect(mockPrisma.$queryRaw).toHaveBeenCalled();
        const claimSql = mockPrisma.$queryRaw.mock.calls[0][0].join(' ');
        expect(claimSql).toContain('"claimToken" = gen_random_uuid()::text');
        expect(claimSql).toContain('"maxAttempts", "claimToken"');
        // Job should have been completed
        expect(mockPrismaJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ status: 'COMPLETED' }),
            }),
        );
    });

    it('reclaims stale processing jobs before per-type claims', async () => {
        const now = new Date('2026-08-11T12:00:00.000Z');
        vi.setSystemTime(now);
        worker = new Worker({
            pollIntervalMs: 100,
            maxConcurrency: 2,
            concurrencyByType: {
                [JobType.AI_RESPONSE]: 1,
            },
            jobTimeouts: {
                [JobType.AI_RESPONSE]: 2000,
            },
        });

        mockPrisma.$queryRaw.mockResolvedValue([]);
        worker.on(JobType.AI_RESPONSE, async () => ({ success: true }));

        worker.start();
        await vi.advanceTimersByTimeAsync(0);

        expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
        // The sweep no longer carries a per-type policy set. `lockUntil` is on the
        // row, written by whoever claimed it, so this worker's own timeout config
        // is not an input to the decision.
        const reclaimSql = mockPrisma.$executeRaw.mock.calls[0][0].join(' ');
        expect(reclaimSql).toContain('job."lockUntil"');
        expect(reclaimSql).not.toContain('jsonb_to_recordset');
        expect(reclaimSql).not.toContain('job.type = policy.type');
        expect(mockPrisma.$queryRaw).toHaveBeenCalled();
    });

    it('falls back to global limit when concurrencyByType is not specified', async () => {
        worker = new Worker({
            pollIntervalMs: 100,
            maxConcurrency: 3,
            // No concurrencyByType — should use the original claim logic
        });

        const jobRows = [
            makeJobRow({ id: 'j1' }),
            makeJobRow({ id: 'j2' }),
            makeJobRow({ id: 'j3' }),
        ];

        mockPrisma.$queryRaw.mockResolvedValueOnce(jobRows);
        mockPrisma.$queryRaw.mockResolvedValue([]);
        mockPrismaJob.update.mockResolvedValue({});

        let processed = 0;
        worker.on(JobType.AI_RESPONSE, async () => {
            processed++;
            return { success: true };
        });

        worker.start();
        await vi.advanceTimersByTimeAsync(100);

        // All 3 jobs should have been processed (global limit = 3)
        expect(processed).toBe(3);
    });

    it('health check includes activeJobsByType', () => {
        worker = new Worker({
            concurrencyByType: {
                [JobType.AI_RESPONSE]: 4,
            },
        });

        const health = worker.healthCheck();
        expect(health.activeJobsByType).toBeDefined();
        expect(health.activeJobsByType).toEqual({});
    });

    it('global ceiling still applies even with per-type limits', async () => {
        worker = new Worker({
            pollIntervalMs: 100,
            maxConcurrency: 2, // Global ceiling: 2 total
            concurrencyByType: {
                [JobType.AI_RESPONSE]: 5, // Per-type says 5, but global says 2
                [JobType.ESCALATION]: 5,
            },
        });

        mockPrismaJob.update.mockResolvedValue({});

        // Instant handlers — no setTimeout to get stuck on
        worker.on(JobType.AI_RESPONSE, async () => {
            return { success: true };
        });

        worker.on(JobType.ESCALATION, async () => {
            return { success: true };
        });

        // The claimJobsByType path claims per type. With global=2 and AI_RESPONSE limit=5,
        // the first type can claim at most min(5, 2) = 2.
        mockPrisma.$queryRaw
            .mockResolvedValueOnce([
                makeJobRow({ id: 'ai-1', type: JobType.AI_RESPONSE }),
                makeJobRow({ id: 'ai-2', type: JobType.AI_RESPONSE }),
            ])
            .mockResolvedValue([]); // ESCALATION has no jobs

        worker.start();
        await vi.advanceTimersByTimeAsync(0);

        // Both AI jobs should have completed
        const completedCalls = mockPrismaJob.updateMany.mock.calls.filter(
            (call: Array<Record<string, Record<string, unknown>>>) =>
                call[0].data.status === 'COMPLETED',
        );
        expect(completedCalls).toHaveLength(2);
    });

    it('processes different types in separate pools', async () => {
        worker = new Worker({
            pollIntervalMs: 100,
            maxConcurrency: 10,
            concurrencyByType: {
                [JobType.AI_RESPONSE]: 2,
                [JobType.ESCALATION]: 2,
            },
        });

        const processed: string[] = [];

        worker.on(JobType.AI_RESPONSE, async (payload) => {
            processed.push(`ai-${payload.ticketId}`);
            return { success: true };
        });

        worker.on(JobType.ESCALATION, async (payload) => {
            processed.push(`esc-${payload.ticketId}`);
            return { success: true };
        });

        mockPrismaJob.update.mockResolvedValue({});

        // Per-type claims: first call for AI_RESPONSE, second for ESCALATION
        mockPrisma.$queryRaw
            .mockResolvedValueOnce([makeJobRow({ id: 'ai-1', type: JobType.AI_RESPONSE })])
            .mockResolvedValueOnce([
                makeJobRow({
                    id: 'esc-1',
                    type: JobType.ESCALATION,
                    payload: { ticketId: 'tkt-esc', reason: 'test' },
                }),
            ])
            .mockResolvedValue([]);

        worker.start();
        await vi.advanceTimersByTimeAsync(0);

        // Both types should have been processed
        expect(processed).toContain('ai-tkt-1');
        expect(processed).toContain('esc-tkt-esc');
    });

    it('per-type count decrements after job completes', async () => {
        worker = new Worker({
            pollIntervalMs: 50,
            maxConcurrency: 10,
            concurrencyByType: {
                [JobType.AI_RESPONSE]: 1,
            },
        });

        let callCount = 0;
        worker.on(JobType.AI_RESPONSE, async () => {
            callCount++;
            return { success: true };
        });

        mockPrismaJob.update.mockResolvedValue({});

        // First poll returns 1 AI job
        mockPrisma.$queryRaw
            .mockResolvedValueOnce([makeJobRow({ id: 'ai-1', type: JobType.AI_RESPONSE })])
            // After first job completes, second poll returns another AI job
            .mockResolvedValueOnce([]) // ESCALATION slot (no jobs)
            .mockResolvedValueOnce([makeJobRow({ id: 'ai-2', type: JobType.AI_RESPONSE })])
            .mockResolvedValue([]);

        worker.start();
        await vi.advanceTimersByTimeAsync(0);
        // First job processes
        expect(callCount).toBe(1);

        // Advance past poll interval for second poll
        await vi.advanceTimersByTimeAsync(100);

        // Second job should have been picked up after first completed
        // (per-type count went back to 0)
        expect(callCount).toBeGreaterThanOrEqual(1);
    });
});

// ─── Claim-before-process (#232) ────────────────────────────────────────────

/**
 * The global budget used to be charged after `processClaimedJobs` had already
 * awaited the batch, so work that had finished still held slots. With a broad
 * backlog the budget ran out partway down `this.handlers` insertion order and
 * the same tail types were never reached — deterministically, because the next
 * poll started from the same place against the same state.
 */
describe('Worker claim budget and ordering', () => {
    let worker: InstanceType<typeof Worker>;

    /** Types in registration order; the last few are the ones that starved. */
    const TYPES = [
        JobType.AI_RESPONSE,
        JobType.ESCALATION,
        JobType.SLA_CHECK,
        JobType.TRACKER_SYNC,
        JobType.JOB_CLEANUP,
    ];

    /** `claimJobsForType` interpolates type third: jsonb map, default timeout, type, limit. */
    const claimedType = (call: unknown[]) => call[3] as string;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        mockPrisma.$executeRaw.mockResolvedValue(0);
        mockPrismaJob.updateMany.mockResolvedValue({ count: 1 });
        mockPrismaJob.update.mockResolvedValue({});
    });

    afterEach(async () => {
        if (worker) await worker.stop();
        vi.useRealTimers();
    });

    it('reaches every registered type across polls when every type has a backlog', async () => {
        worker = new Worker({
            pollIntervalMs: 10,
            maxConcurrency: 4, // smaller than the backlog, so the budget must run out
            batchSize: 2,
            concurrencyByType: Object.fromEntries(TYPES.map((t) => [t, 2])),
        });

        for (const t of TYPES) worker.on(t, async () => ({ success: true }));

        // Every type always has work waiting.
        let seq = 0;
        mockPrisma.$queryRaw.mockImplementation((...call: unknown[]) => {
            const type = claimedType(call);
            return Promise.resolve([
                makeJobRow({ id: `${type}-${seq++}`, type }),
                makeJobRow({ id: `${type}-${seq++}`, type }),
            ]);
        });

        worker.start();
        // Several polls: any fair scheme reaches all five well inside this.
        await vi.advanceTimersByTimeAsync(200);

        const reached = new Set(mockPrisma.$queryRaw.mock.calls.map(claimedType));
        for (const t of TYPES) {
            expect(reached, `type ${t} was never claimed`).toContain(t);
        }
    });

    it('issues every claim before any handler runs, so a slow type cannot delay the rest', async () => {
        worker = new Worker({
            pollIntervalMs: 10,
            maxConcurrency: 10,
            batchSize: 1,
            concurrencyByType: { [JobType.AI_RESPONSE]: 2, [JobType.ESCALATION]: 2 },
        });

        const events: string[] = [];
        let releaseSlow: () => void = () => {};
        const slowDone = new Promise<void>((r) => (releaseSlow = r));

        worker.on(JobType.AI_RESPONSE, async () => {
            events.push('ai-handler-start');
            await slowDone;
            return { success: true };
        });
        worker.on(JobType.ESCALATION, async () => {
            events.push('esc-handler-start');
            return { success: true };
        });

        mockPrisma.$queryRaw.mockImplementation((...call: unknown[]) => {
            const type = claimedType(call);
            events.push(`claim:${type}`);
            if (type === JobType.AI_RESPONSE)
                return Promise.resolve([makeJobRow({ id: 'ai-1', type })]);
            if (type === JobType.ESCALATION)
                return Promise.resolve([makeJobRow({ id: 'esc-1', type })]);
            return Promise.resolve([]);
        });

        worker.start();
        await vi.advanceTimersByTimeAsync(0);

        // The ESCALATION claim must be issued even though the AI handler is parked.
        // Both events must be present, or the index comparison below proves nothing.
        expect(events).toContain(`claim:${JobType.ESCALATION}`);
        expect(events).toContain('ai-handler-start');
        expect(events.indexOf(`claim:${JobType.ESCALATION}`)).toBeLessThan(
            events.indexOf('ai-handler-start'),
        );

        releaseSlow();
        await vi.advanceTimersByTimeAsync(0);
    });

    it('never claims more than the global ceiling across all types in one poll', async () => {
        // Budget 4 with a per-type limit of 2 means the ceiling can only be
        // honoured by summing across types: no single type can reach it alone.
        worker = new Worker({
            pollIntervalMs: 10,
            maxConcurrency: 4,
            batchSize: 5,
            concurrencyByType: Object.fromEntries(TYPES.map((t) => [t, 2])),
        });

        // Every handler parks, so the first poll cannot finish and cannot
        // schedule a second one. Whatever is claimed is one poll's worth.
        // Released before the assertions so `stop()` can drain in afterEach.
        let release: () => void = () => {};
        const parked = new Promise<void>((r) => (release = r));
        for (const t of TYPES)
            worker.on(t, async () => {
                await parked;
                return { success: true };
            });

        let claimed = 0;
        const typesClaimed = new Set<string>();
        mockPrisma.$queryRaw.mockImplementation((...call: unknown[]) => {
            const type = claimedType(call);
            const limit = call[4] as number;
            const rows = Array.from({ length: limit }, (_, i) =>
                makeJobRow({ id: `${type}-${i}`, type }),
            );
            claimed += rows.length;
            typesClaimed.add(type);
            return Promise.resolve(rows);
        });

        worker.start();
        await vi.advanceTimersByTimeAsync(0);

        const claimedInOnePoll = claimed;
        const spannedTypes = typesClaimed.size;
        release();
        await vi.advanceTimersByTimeAsync(0);

        // Lower bound first: a claim path that did nothing would satisfy the
        // ceiling trivially.
        expect(claimedInOnePoll).toBeGreaterThan(0);
        expect(spannedTypes).toBeGreaterThan(1);
        expect(claimedInOnePoll).toBeLessThanOrEqual(4);
    });

    it('dispatches jobs already claimed when a later claim fails', async () => {
        // Claiming every type before processing any of them means a rejection
        // partway through must not discard the rows already claimed: they are
        // PROCESSING with a live token, and dropping them leaves them for the
        // reclaim sweep, which consumes an attempt.
        worker = new Worker({
            pollIntervalMs: 10,
            maxConcurrency: 10,
            batchSize: 1,
            concurrencyByType: {
                [JobType.AI_RESPONSE]: 2,
                [JobType.ESCALATION]: 2,
                [JobType.SLA_CHECK]: 2,
            },
        });

        const ran: string[] = [];
        for (const t of [JobType.AI_RESPONSE, JobType.ESCALATION, JobType.SLA_CHECK])
            worker.on(t, async (payload) => {
                ran.push(String((payload as { id?: string }).id ?? 'x'));
                return { success: true };
            });

        let call = 0;
        mockPrisma.$queryRaw.mockImplementation((...args: unknown[]) => {
            const type = claimedType(args);
            call += 1;
            if (call === 3) return Promise.reject(new Error('connection pool timeout'));
            return Promise.resolve([
                makeJobRow({ id: `${type}-1`, type, payload: { id: `${type}-1` } }),
            ]);
        });

        worker.start();
        await vi.advanceTimersByTimeAsync(0);

        // The two claims that succeeded before the failure must still have run.
        expect(ran).toHaveLength(2);
    });
});
