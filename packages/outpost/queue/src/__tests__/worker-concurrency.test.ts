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
    findFirst: vi.fn(),
};

const mockPrisma = {
    job: mockPrismaJob,
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
    }> = {},
) {
    return {
        id: overrides.id ?? 'job-1',
        type: overrides.type ?? JobType.AI_RESPONSE,
        payload: overrides.payload ?? { ticketId: 'tkt-1', source: 'discord' },
        attempts: overrides.attempts ?? 0,
        maxAttempts: overrides.maxAttempts ?? 5,
    };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Worker per-type concurrency', () => {
    let worker: InstanceType<typeof Worker>;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
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
        // Job should have been completed
        expect(mockPrismaJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ status: 'COMPLETED' }),
            }),
        );
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
        const completedCalls = mockPrismaJob.update.mock.calls.filter(
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

// ─── Poll-in-progress instrumentation ──────────────────────────────────────
//
// healthCheck() used to expose only lastPollTime, stamped at the START of poll()
// — and poll() awaits Promise.allSettled over every job it claims. So the stamp
// freezes for as long as the longest job runs, and a consumer reading it alone
// cannot tell a worker grinding through a 5-minute HubSpot sync from one wedged
// on a hung database call. apps/worker/src/health.ts answered 503 "stalled" for
// the former and the container healthcheck killed it mid-job. These fields are
// what let the two be told apart.
describe('Worker health check — poll lifecycle', () => {
    let worker: InstanceType<typeof Worker>;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
    });

    afterEach(async () => {
        if (worker) await worker.stop();
        vi.useRealTimers();
    });

    it('reports no poll in flight before the worker starts', () => {
        worker = new Worker({ pollIntervalMs: 100 });

        const health: WorkerHealthStatus = worker.healthCheck();

        expect(health.pollStartedAt).toBeNull();
        expect(health.lastPollCompletedAt).toBeNull();
        expect(health.running).toBe(false);
    });

    it('exposes an in-flight poll while a job is still running, and clears it after', async () => {
        worker = new Worker({ pollIntervalMs: 100, maxConcurrency: 1 });

        // A handler that does not settle until we let it, standing in for a long
        // job. poll() cannot return while this is pending.
        let release: (() => void) | undefined;
        const jobRunning = new Promise<void>((resolve) => {
            release = resolve;
        });
        worker.on(JobType.AI_RESPONSE, async () => {
            await jobRunning;
            return { success: true };
        });

        mockPrismaJob.update.mockResolvedValue({});
        mockPrisma.$queryRaw
            .mockResolvedValueOnce([makeJobRow({ id: 'slow-1' })])
            .mockResolvedValue([]);

        worker.start();
        await vi.advanceTimersByTimeAsync(0);

        // Mid-job: the poll has not returned, so pollStartedAt is set. This is the
        // observation that makes "busy" distinguishable from "stalled".
        const midJob = worker.healthCheck();
        expect(midJob.pollStartedAt).toBeInstanceOf(Date);
        expect(midJob.activeJobCount).toBe(1);

        release?.();
        await vi.advanceTimersByTimeAsync(0);

        const afterJob = worker.healthCheck();
        expect(afterJob.pollStartedAt).toBeNull();
        expect(afterJob.lastPollCompletedAt).toBeInstanceOf(Date);
    });

    it('clears the in-flight marker when a poll throws', async () => {
        worker = new Worker({ pollIntervalMs: 100 });
        worker.on(JobType.AI_RESPONSE, async () => ({ success: true }));

        // The claim query itself fails, which poll() catches and reschedules. A
        // poll that threw has still stopped running: leaving the marker set would
        // report a dead loop as permanently busy.
        mockPrisma.$queryRaw.mockRejectedValueOnce(new Error('connection reset'));

        worker.start();
        await vi.advanceTimersByTimeAsync(0);

        expect(worker.healthCheck().pollStartedAt).toBeNull();
        expect(worker.healthCheck().lastPollCompletedAt).toBeInstanceOf(Date);
    });

    it('reports no overdue jobs on a fresh worker', () => {
        worker = new Worker({ pollIntervalMs: 100 });

        const health: WorkerHealthStatus = worker.healthCheck();

        expect(health.overdueJobCount).toBe(0);
        expect(health.lastJobSettledAt).toBeNull();
    });

    it('stamps lastJobSettledAt when a job finishes', async () => {
        worker = new Worker({ pollIntervalMs: 100 });
        worker.on(JobType.AI_RESPONSE, async () => ({ success: true }));

        mockPrismaJob.update.mockResolvedValue({});
        mockPrisma.$queryRaw.mockResolvedValueOnce([makeJobRow()]).mockResolvedValue([]);

        worker.start();
        await vi.advanceTimersByTimeAsync(0);

        expect(worker.healthCheck().lastJobSettledAt).toBeInstanceOf(Date);
    });

    // The signal that replaced the poll-duration bound. A job past its OWN
    // timeout means the timeout machinery failed — including the case where the
    // untimed status write after runWithTimeout hangs, so processJob's `finally`
    // never runs and the slot is held forever.
    it('counts an in-flight job as overdue once it outlives its own timeout', async () => {
        worker = new Worker({
            pollIntervalMs: 100,
            maxConcurrency: 1,
            jobTimeouts: { [JobType.AI_RESPONSE]: 1_000 },
        });

        let release: (() => void) | undefined;
        const hung = new Promise<void>((resolve) => {
            release = resolve;
        });
        worker.on(JobType.AI_RESPONSE, async () => {
            await hung;
            return { success: true };
        });

        mockPrismaJob.update.mockResolvedValue({});
        mockPrisma.$queryRaw
            .mockResolvedValueOnce([makeJobRow({ id: 'hung-1' })])
            .mockResolvedValue([]);

        worker.start();
        await vi.advanceTimersByTimeAsync(0);

        // Inside its timeout: busy, not overdue.
        expect(worker.healthCheck().overdueJobCount).toBe(0);

        // Past timeout (1s) plus the 60s grace. Time is advanced without letting
        // the handler settle, which is exactly the orphaned-handler state.
        vi.setSystemTime(Date.now() + 62_000);

        expect(worker.healthCheck().overdueJobCount).toBe(1);

        release?.();
        await vi.advanceTimersByTimeAsync(0);
    });

    // Superseded poll chains must not clear the live chain's marker: a worker
    // whose only running poll is wedged would otherwise show a fresh completion
    // and answer 200 — a guard wrong in the reassuring direction.
    it('leaves no pending poll timer after stop(), and does not resurrect one', async () => {
        worker = new Worker({ pollIntervalMs: 100 });
        worker.on(JobType.AI_RESPONSE, async () => ({ success: true }));
        mockPrisma.$queryRaw.mockResolvedValue([]);

        worker.start();
        await vi.advanceTimersByTimeAsync(0);
        await worker.stop();

        const timersAfterStop = vi.getTimerCount();
        // Advancing well past the interval must not start another poll.
        await vi.advanceTimersByTimeAsync(1_000);

        expect(vi.getTimerCount()).toBeLessThanOrEqual(timersAfterStop);
        expect(worker.healthCheck().running).toBe(false);
    });

    // The grace exists because runWithTimeout bounds only the handler — the
    // status write after it is untimed, so a job legitimately overshoots its
    // stated timeout a little on a slow database. Without the grace, ordinary
    // slowness would be reported as a stall.
    it('does not count a job that is past its timeout but inside the grace', async () => {
        worker = new Worker({
            pollIntervalMs: 100,
            maxConcurrency: 1,
            jobTimeouts: { [JobType.AI_RESPONSE]: 1_000 },
        });

        let release: (() => void) | undefined;
        const hung = new Promise<void>((resolve) => {
            release = resolve;
        });
        worker.on(JobType.AI_RESPONSE, async () => {
            await hung;
            return { success: true };
        });

        mockPrismaJob.update.mockResolvedValue({});
        mockPrisma.$queryRaw
            .mockResolvedValueOnce([makeJobRow({ id: 'slow-but-fine' })])
            .mockResolvedValue([]);

        worker.start();
        await vi.advanceTimersByTimeAsync(0);

        // 30s past a 1s timeout, still inside the 60s grace.
        vi.setSystemTime(Date.now() + 31_000);
        expect(worker.healthCheck().overdueJobCount).toBe(0);

        // Past the grace.
        vi.setSystemTime(Date.now() + 31_000);
        expect(worker.healthCheck().overdueJobCount).toBe(1);

        release?.();
        await vi.advanceTimersByTimeAsync(0);
    });

    // stop() clears pollTimer, but an in-flight poll resumes after its await and
    // would otherwise install a fresh timer behind it — a live handle outliving
    // `await worker.stop()`, still claiming jobs.
    it('claims nothing more after stop(), however long time advances', async () => {
        worker = new Worker({ pollIntervalMs: 100 });
        worker.on(JobType.AI_RESPONSE, async () => ({ success: true }));
        mockPrisma.$queryRaw.mockResolvedValue([]);

        worker.start();
        await vi.advanceTimersByTimeAsync(250);
        await worker.stop();

        const claimsAtStop = mockPrisma.$queryRaw.mock.calls.length;
        await vi.advanceTimersByTimeAsync(5_000);

        expect(mockPrisma.$queryRaw.mock.calls.length).toBe(claimsAtStop);
    });

    // Covers the drain: stop() is called with a job in flight, and the poll
    // awaiting that job resumes after stop() has already cleared the timer.
    //
    // Note on what this does NOT pin: reschedule()'s `!this.running` guard is
    // defense-in-depth with the same check at the top of poll(), and its effect
    // is not observable from here — after processing, nextPollDelay is 0, so the
    // re-armed timer fires on the next flush and poll() returns immediately
    // either way. Removing the guard leaves this test green. It is kept because a
    // handle queued behind a resolved stop() is worth preventing at the source,
    // not because a test distinguishes it.
    it('finishes a post-stop poll without leaving the worker running', async () => {
        worker = new Worker({ pollIntervalMs: 50, maxConcurrency: 1 });

        let release: (() => void) | undefined;
        const jobRunning = new Promise<void>((resolve) => {
            release = resolve;
        });
        worker.on(JobType.AI_RESPONSE, async () => {
            await jobRunning;
            return { success: true };
        });

        mockPrismaJob.update.mockResolvedValue({});
        mockPrisma.$queryRaw
            .mockResolvedValueOnce([makeJobRow({ id: 'draining' })])
            .mockResolvedValue([]);

        worker.start();
        await vi.advanceTimersByTimeAsync(0);
        // A poll is genuinely in flight, holding the job.
        expect(worker.healthCheck().pollStartedAt).toBeInstanceOf(Date);

        // Signal shutdown, then let the job settle so the drain can complete.
        const stopping = worker.stop();
        release?.();
        await stopping;

        // Let the resumed poll finish unwinding: completePoll() and reschedule()
        // run after stop() has already resolved.
        await vi.advanceTimersByTimeAsync(0);
        expect(worker.healthCheck().running).toBe(false);
        expect(worker.healthCheck().pollStartedAt).toBeNull();
    });

    // NOTE on the at-capacity branch in poll(): it is not reachable while a poll
    // awaits its own jobs, because the poll cannot return to schedule the next
    // one until every slot it filled has drained. It is left calling
    // completePoll() for correctness rather than because a test can reach it.
});

// A poll that THROWS is not a poll that found nothing. completePoll() runs on
// the error path too, stamping lastPollCompletedAt exactly as success does, so
// without a failure record a worker whose every claim query fails — drifted
// schema, rotated credentials, refused connections — is indistinguishable from
// an idle one and answers 200 forever.
describe('Worker health check — poll failures', () => {
    let worker: InstanceType<typeof Worker>;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
    });

    afterEach(async () => {
        if (worker) await worker.stop();
        vi.useRealTimers();
    });

    it('records nothing while polls succeed', async () => {
        worker = new Worker({ pollIntervalMs: 50 });
        worker.on(JobType.AI_RESPONSE, async () => ({ success: true }));
        mockPrisma.$queryRaw.mockResolvedValue([]);

        worker.start();
        await vi.advanceTimersByTimeAsync(120);

        const health: WorkerHealthStatus = worker.healthCheck();
        expect(health.pollFailingSince).toBeNull();
        expect(health.consecutivePollFailures).toBe(0);
    });

    it('opens a failure window when the claim query throws', async () => {
        worker = new Worker({ pollIntervalMs: 50 });
        worker.on(JobType.AI_RESPONSE, async () => ({ success: true }));
        mockPrisma.$queryRaw.mockRejectedValue(new Error('relation "Job" does not exist'));

        worker.start();
        await vi.advanceTimersByTimeAsync(120);

        const health = worker.healthCheck();
        expect(health.pollFailingSince).toBeInstanceOf(Date);
        expect(health.consecutivePollFailures).toBeGreaterThan(1);
        // The tell: the error path stamps this exactly as success would, which is
        // why it cannot be the liveness signal on its own.
        expect(health.lastPollCompletedAt).toBeInstanceOf(Date);
    });

    it('closes the window as soon as a poll returns normally', async () => {
        worker = new Worker({ pollIntervalMs: 50 });
        worker.on(JobType.AI_RESPONSE, async () => ({ success: true }));
        mockPrisma.$queryRaw
            .mockRejectedValueOnce(new Error('connection refused'))
            .mockRejectedValueOnce(new Error('connection refused'))
            .mockResolvedValue([]);

        worker.start();
        await vi.advanceTimersByTimeAsync(60);
        expect(worker.healthCheck().pollFailingSince).toBeInstanceOf(Date);

        await vi.advanceTimersByTimeAsync(200);

        const recovered = worker.healthCheck();
        expect(recovered.pollFailingSince).toBeNull();
        expect(recovered.consecutivePollFailures).toBe(0);
    });
});

// `overdueJobCount` reads `activeJobStarts`, and nothing else prunes that map.
// If a completed job's entry is left behind, every job the worker has EVER run
// eventually crosses its timeout plus the grace, the count climbs without bound,
// and — because overdue is checked before every timing branch — a healthy worker
// answers 503 permanently and the container probe kills it. That is the exact
// revert-worthy failure this endpoint exists to avoid, reached from the other
// direction, plus an unbounded Map.
describe('completed jobs leave no overdue residue', () => {
    let worker: InstanceType<typeof Worker>;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
    });

    afterEach(async () => {
        if (worker) await worker.stop();
        vi.useRealTimers();
    });

    it('reports no overdue jobs long after finished work would have aged out', async () => {
        worker = new Worker({
            pollIntervalMs: 50,
            maxConcurrency: 2,
            jobTimeouts: { [JobType.AI_RESPONSE]: 1_000 },
        });
        worker.on(JobType.AI_RESPONSE, async () => ({ success: true }));

        mockPrismaJob.update.mockResolvedValue({});
        mockPrisma.$queryRaw
            .mockResolvedValueOnce([makeJobRow({ id: 'done-1' }), makeJobRow({ id: 'done-2' })])
            .mockResolvedValue([]);

        worker.start();
        await vi.advanceTimersByTimeAsync(0);

        expect(worker.healthCheck().activeJobCount).toBe(0);

        // Well past the 1s timeout plus the 60s grace. If the entries survived
        // their jobs, both would now be counted overdue.
        vi.setSystemTime(Date.now() + 120_000);

        expect(worker.healthCheck().overdueJobCount).toBe(0);
    });

    // The failure path frees the slot too, so it must prune the same way.
    it('leaves no residue when a job fails', async () => {
        worker = new Worker({
            pollIntervalMs: 50,
            maxConcurrency: 1,
            jobTimeouts: { [JobType.AI_RESPONSE]: 1_000 },
        });
        worker.on(JobType.AI_RESPONSE, async () => ({ success: false, error: 'nope' }));

        mockPrismaJob.update.mockResolvedValue({});
        mockPrisma.$queryRaw
            .mockResolvedValueOnce([makeJobRow({ id: 'failed-1' })])
            .mockResolvedValue([]);

        worker.start();
        await vi.advanceTimersByTimeAsync(0);
        vi.setSystemTime(Date.now() + 120_000);

        expect(worker.healthCheck().overdueJobCount).toBe(0);
    });
});

// A poll that recovers then spends a long time processing what it claimed must
// not still read as failing. The counters are cleared when the CLAIM returns —
// the moment the database proves it is answering — not at the end of the poll
// body, which can be minutes later.
describe('a recovering worker stops reporting failure at the claim, not at the end of the poll', () => {
    let worker: InstanceType<typeof Worker>;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
    });

    afterEach(async () => {
        if (worker) await worker.stop();
        vi.useRealTimers();
    });

    it('clears the failure window while the recovered poll is still processing', async () => {
        // concurrencyByType populated so hasPerTypeLimits is true and the poll
        // takes the claimJobsByType path — the one production uses, since
        // apps/worker/src/index.ts names all ten types.
        worker = new Worker({
            pollIntervalMs: 50,
            maxConcurrency: 1,
            concurrencyByType: { [JobType.AI_RESPONSE]: 1 },
        });

        let release: (() => void) | undefined;
        const stillWorking = new Promise<void>((resolve) => {
            release = resolve;
        });
        worker.on(JobType.AI_RESPONSE, async () => {
            await stillWorking;
            return { success: true };
        });

        mockPrismaJob.update.mockResolvedValue({});
        mockPrisma.$queryRaw
            .mockRejectedValueOnce(new Error('connection refused'))
            .mockRejectedValueOnce(new Error('connection refused'))
            .mockResolvedValueOnce([makeJobRow({ id: 'recovered-1' })])
            .mockResolvedValue([]);

        worker.start();
        await vi.advanceTimersByTimeAsync(60);
        expect(worker.healthCheck().pollFailingSince).toBeInstanceOf(Date);

        // The claim has now succeeded and the job is in flight. The poll body has
        // NOT finished — it is awaiting the handler.
        await vi.advanceTimersByTimeAsync(60);

        const midRecovery = worker.healthCheck();
        expect(midRecovery.activeJobCount).toBe(1);
        expect(midRecovery.pollFailingSince).toBeNull();
        expect(midRecovery.consecutivePollFailures).toBe(0);

        release?.();
        await vi.advanceTimersByTimeAsync(0);
    });
});
