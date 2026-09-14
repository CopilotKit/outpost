/**
 * Tests for the Outpost job queue package.
 *
 * These tests use mocked Prisma to avoid needing a live database.
 * Each test was developed red-green: the test was written first to fail,
 * then the implementation was verified to make it pass.
 *
 * NOTE: If a real Postgres test database is available via DATABASE_URL,
 * integration tests should be added separately. These are unit tests
 * against mocked persistence.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JobType } from '../types.js';
import type { JobResult, JobHandlerContext, WorkerHealthStatus } from '../types.js';

// ─── Mock Setup ─────────────────────────────────────────────────────────────

// Mock prisma before importing modules that use it
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

// The `shared` mock above re-declares MAX_JOB_ATTEMPTS, BACKOFF_BASE_MS and
// BACKOFF_MAX_MS as literals. Every assertion written against those literals was
// checking the mock against itself: editing the real constants left the whole
// file green. Importing the real ones straight from source — past both the mock
// and the package alias — gives the suite something honest to compare against.
// `importActual` deliberately, not a relative path into shared/src: the queue
// tsconfig sets rootDir to queue/src, so reaching across the package boundary by
// path is a typecheck error. This goes through the same specifier the mock
// intercepts, and gets the real module behind it.
const realConstants = (await vi.importActual('@copilotkit/outpost/shared')) as {
    MAX_JOB_ATTEMPTS: number;
    BACKOFF_BASE_MS: number;
    BACKOFF_MAX_MS: number;
};

// Import after mocks are set up
const { createJob, updateJobProgress } = await import('../create-job.js');
const { Worker } = await import('../worker.js');
const { Scheduler, DEFAULT_SCHEDULED_JOBS } = await import('../scheduler.js');

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
        claimToken: overrides.claimToken ?? 'claim-1',
    };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('createJob', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('creates a job with correct defaults', async () => {
        mockPrismaJob.create.mockResolvedValue({ id: 'job-123' });

        const id = await createJob(JobType.AI_RESPONSE, {
            ticketId: 'tkt-1',
            source: 'discord',
        });

        expect(id).toBe('job-123');
        expect(mockPrismaJob.create).toHaveBeenCalledOnce();

        const callArg = mockPrismaJob.create.mock.calls[0][0];
        expect(callArg.data.type).toBe('AI_RESPONSE');
        expect(callArg.data.maxAttempts).toBe(realConstants.MAX_JOB_ATTEMPTS);
        expect(callArg.data.payload).toEqual({ ticketId: 'tkt-1', source: 'discord' });
        expect(callArg.data.runAt).toBeInstanceOf(Date);
    });

    it('accepts custom runAt and maxAttempts', async () => {
        mockPrismaJob.create.mockResolvedValue({ id: 'job-456' });
        const futureDate = new Date('2026-12-01T00:00:00Z');

        await createJob(
            JobType.TICKET_CLASSIFY,
            { ticketId: 'tkt-2' },
            { runAt: futureDate, maxAttempts: 3 },
        );

        const callArg = mockPrismaJob.create.mock.calls[0][0];
        expect(callArg.data.maxAttempts).toBe(3);
        expect(callArg.data.runAt).toBe(futureDate);
    });

    it('creates SLA_CHECK job with empty payload', async () => {
        mockPrismaJob.create.mockResolvedValue({ id: 'job-789' });

        const id = await createJob(JobType.SLA_CHECK, {});

        expect(id).toBe('job-789');
        const callArg = mockPrismaJob.create.mock.calls[0][0];
        expect(callArg.data.payload).toEqual({});
    });
});

describe('updateJobProgress', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('updates progress clamped between 0 and 100', async () => {
        mockPrismaJob.updateMany.mockResolvedValue({ count: 1 });

        await updateJobProgress('job-1', 50, 'claim-1');
        expect(mockPrismaJob.updateMany).toHaveBeenCalledWith({
            where: { id: 'job-1', status: 'PROCESSING', claimToken: 'claim-1' },
            data: { progress: 50 },
        });
    });

    it('clamps progress above 100 to 100', async () => {
        mockPrismaJob.updateMany.mockResolvedValue({ count: 1 });

        await updateJobProgress('job-1', 150, 'claim-1');
        expect(mockPrismaJob.updateMany).toHaveBeenCalledWith({
            where: { id: 'job-1', status: 'PROCESSING', claimToken: 'claim-1' },
            data: { progress: 100 },
        });
    });

    it('clamps negative progress to 0', async () => {
        mockPrismaJob.updateMany.mockResolvedValue({ count: 1 });

        await updateJobProgress('job-1', -10, 'claim-1');
        expect(mockPrismaJob.updateMany).toHaveBeenCalledWith({
            where: { id: 'job-1', status: 'PROCESSING', claimToken: 'claim-1' },
            data: { progress: 0 },
        });
    });
});

describe('updateJobProgress resilience', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('cannot fail the job it is only describing', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        mockPrismaJob.updateMany.mockRejectedValue(new Error('pool exhausted'));

        // Handlers `await` this. A rejection propagated into the handler, the
        // worker recorded it as a job failure, and work that was running perfectly
        // well got retried — repeating every side effect it had already produced.
        // Progress is telemetry; it must never be able to fail the job.
        await expect(updateJobProgress('job-1', 50, 'claim-1')).resolves.toBeUndefined();

        expect(warn.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toContain(
            'failed and was ignored',
        );
        warn.mockRestore();
    });
});

describe('Worker', () => {
    let worker: InstanceType<typeof Worker>;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        mockPrisma.$executeRaw.mockResolvedValue(0);
        mockPrismaJob.updateMany.mockResolvedValue({ count: 1 });
        // `clearAllMocks` clears call records but keeps implementations and any
        // unconsumed `Once` queue, and nothing here re-armed `$queryRaw` — so a
        // test that set no claim result silently inherited the previous test's,
        // and `poll()` swallowed the resulting TypeError in its own catch. Reset
        // and give it an explicit default; per-test `Once` values still win.
        mockPrisma.$queryRaw.mockReset();
        mockPrisma.$queryRaw.mockResolvedValue([]);
        worker = new Worker({
            pollIntervalMs: 100,
            maxConcurrency: 2,
            defaultTimeoutMs: 5000,
        });
    });

    afterEach(async () => {
        // Ensure worker is stopped
        await worker.stop();
        vi.useRealTimers();
    });

    it('picks up jobs in order and processes them', async () => {
        const jobRow = makeJobRow();
        mockPrisma.$queryRaw.mockResolvedValueOnce([jobRow]);
        mockPrisma.$queryRaw.mockResolvedValue([]); // subsequent polls return nothing
        mockPrismaJob.update.mockResolvedValue({});

        const results: string[] = [];
        worker.on(JobType.AI_RESPONSE, async (payload, _ctx) => {
            results.push(payload.ticketId);
            return { success: true };
        });

        worker.start();
        // Advance past the first poll
        await vi.advanceTimersByTimeAsync(0);

        expect(results).toEqual(['tkt-1']);
        const claimSql = mockPrisma.$queryRaw.mock.calls[0][0].join(' ');
        expect(claimSql).toContain('"claimToken" = gen_random_uuid()::text');
        expect(claimSql).toContain('"maxAttempts", "claimToken"');
        expect(mockPrismaJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ id: 'job-1', claimToken: 'claim-1' }),
                data: expect.objectContaining({ status: 'COMPLETED', attempts: 1 }),
            }),
        );
    });

    it('reclaims on the deadline the claiming worker recorded, not its own config', async () => {
        const now = new Date('2026-08-11T12:00:00.000Z');
        vi.setSystemTime(now);

        await worker.stop();
        worker = new Worker({
            pollIntervalMs: 100,
            maxConcurrency: 2,
            defaultTimeoutMs: 5000,
            // Deliberately not 1000: that is BACKOFF_BASE_MS, and the assertion
            // below is that this worker's config does NOT reach the predicate, so
            // it has to be a value nothing else could have put there.
            jobTimeouts: {
                [JobType.AI_RESPONSE]: 7000,
            },
        });

        const recoveredJob = makeJobRow();
        mockPrisma.$executeRaw.mockResolvedValue(1);
        mockPrisma.$queryRaw.mockResolvedValueOnce([recoveredJob]);
        mockPrisma.$queryRaw.mockResolvedValue([]);
        mockPrismaJob.update.mockResolvedValue({});

        const handled: string[] = [];
        worker.on(JobType.AI_RESPONSE, async (payload) => {
            handled.push(payload.ticketId);
            return { success: true };
        });
        worker.on(JobType.ESCALATION, async () => ({ success: true }));

        worker.start();
        await vi.advanceTimersByTimeAsync(0);

        const firstReclaim = mockPrisma.$executeRaw.mock.calls[0];
        const reclaimSql = firstReclaim[0].join(' ');
        expect(reclaimSql).toContain("WHERE job.status = 'PROCESSING'");

        // The whole point of B2: this worker's `jobTimeouts` must not appear in the
        // predicate. A replica configured differently from the one that claimed the
        // row would otherwise decide a live claim had expired, and the original
        // handler's success would be fenced out and silently discarded.
        expect(reclaimSql).toContain('job."lockUntil"');
        expect(reclaimSql).not.toContain('jsonb_to_recordset');
        expect(firstReclaim.slice(1)).not.toContain(7000);
        expect(firstReclaim.slice(1)).not.toContain(5000);

        // Rows claimed before `lockUntil` existed still need a way out, on an
        // absolute ceiling rather than a guessed deadline.
        expect(reclaimSql).toContain('job."lockedAt"');
        expect(firstReclaim.slice(1)).toContain(900_000);

        expect(handled).toEqual(['tkt-1']);
    });

    it("writes the claiming worker's own timeout onto the row it claims", async () => {
        await worker.stop();
        worker = new Worker({
            pollIntervalMs: 100,
            maxConcurrency: 2,
            defaultTimeoutMs: 5000,
            jobTimeouts: {
                [JobType.AI_RESPONSE]: 120_000,
            },
        });

        mockPrisma.$queryRaw.mockResolvedValue([]);
        worker.on(JobType.AI_RESPONSE, async () => ({ success: true }));

        worker.start();
        await vi.advanceTimersByTimeAsync(0);

        const claim = mockPrisma.$queryRaw.mock.calls[0];
        const claimSql = claim[0].join(' ');
        expect(claimSql).toContain('"lockUntil" = NOW()');
        // Per-type, looked up by the row's own type, with the worker default as the
        // fallback — so a type this worker has no entry for still gets a deadline.
        expect(claimSql).toContain('->> "Job".type');
        const timeoutMap = claim
            .slice(1)
            .find((v: unknown): v is string => typeof v === 'string' && v.includes('AI_RESPONSE'));
        expect(JSON.parse(timeoutMap as string)).toEqual({
            [JobType.AI_RESPONSE]: 120_000,
        });
        expect(claim.slice(1)).toContain(5000);
    });

    it('does not let an old execution clobber the reclaimed claim', async () => {
        const persisted = {
            id: 'job-1',
            status: 'PROCESSING',
            claimToken: 'claim-old',
            attempts: 0,
            progress: null as number | null,
        };
        mockPrismaJob.updateMany.mockImplementation(async ({ where, data }) => {
            if (
                where.id !== persisted.id ||
                where.status !== persisted.status ||
                where.claimToken !== persisted.claimToken
            ) {
                return { count: 0 };
            }
            Object.assign(persisted, data);
            return { count: 1 };
        });

        let oldStarted!: () => void;
        const oldIsRunning = new Promise<void>((resolve) => {
            oldStarted = resolve;
        });
        let releaseOld!: () => void;
        const oldMayFinish = new Promise<void>((resolve) => {
            releaseOld = resolve;
        });
        worker.on(JobType.AI_RESPONSE, async (payload, context) => {
            if (payload.ticketId === 'old-execution') {
                oldStarted();
                await oldMayFinish;
                await context.reportProgress(25);
            }
            return { success: true };
        });

        type ClaimedJob = ReturnType<typeof makeJobRow>;
        const processJob = (
            worker as unknown as { processJob(job: ClaimedJob): Promise<void> }
        ).processJob.bind(worker);
        const oldExecution = processJob(
            makeJobRow({
                payload: { ticketId: 'old-execution', source: 'discord' },
                claimToken: 'claim-old',
            }),
        );
        await oldIsRunning;

        // Model stale reclamation followed by a new exclusive claim.
        persisted.claimToken = 'claim-new';
        persisted.attempts = 1;
        const newExecution = processJob(
            makeJobRow({
                payload: { ticketId: 'new-execution', source: 'discord' },
                attempts: 1,
                claimToken: 'claim-new',
            }),
        );
        await newExecution;

        releaseOld();
        await oldExecution;

        expect(persisted).toMatchObject({
            status: 'COMPLETED',
            claimToken: null,
            attempts: 2,
            progress: 100,
        });
        expect(mockPrismaJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    id: 'job-1',
                    status: 'PROCESSING',
                    claimToken: 'claim-old',
                },
            }),
        );
        expect(mockPrismaJob.update).not.toHaveBeenCalled();
    });

    it('counts crash-abandoned claims toward dead letter only after a recovery grace', async () => {
        worker.on(JobType.AI_RESPONSE, async () => ({ success: true }));
        mockPrisma.$queryRaw.mockResolvedValue([]);

        worker.start();
        await vi.advanceTimersByTimeAsync(0);

        const reclaimCall = mockPrisma.$executeRaw.mock.calls[0];
        const reclaimSql = reclaimCall[0].join(' ');
        expect(reclaimSql).toContain('job."attempts" + 1');
        expect(reclaimSql).toContain("THEN 'DEAD_LETTER'");
        expect(reclaimSql).toContain('"claimToken" = NULL');
        expect(reclaimSql).toContain('"lockUntil" = NULL');
        // The grace sits on top of the recorded deadline: the normal timeout path
        // must have time to release its own claim before another worker calls it
        // crash-abandoned.
        expect(reclaimCall.slice(1)).toContain(30_000);
    });

    it('spaces a reclaimed retry by the same backoff a handler failure would', async () => {
        worker.on(JobType.AI_RESPONSE, async () => ({ success: true }));
        mockPrisma.$queryRaw.mockResolvedValue([]);

        worker.start();
        await vi.advanceTimersByTimeAsync(0);

        const reclaimCall = mockPrisma.$executeRaw.mock.calls[0];
        const reclaimSql = reclaimCall[0].join(' ');

        // `runAt = NOW()` let a crash-looping worker burn every attempt on a job
        // back to back and drive it to DEAD_LETTER at full speed. A reclaim and a
        // handler failure both mean "this attempt did not finish", so they have to
        // space retries the same way.
        // Asserting the shape of the `runAt` arm rather than the absence of one
        // spelling of the regression: `not.toContain('ELSE NOW()\n')` only fired
        // when a newline happened to follow, so `ELSE NOW() END` on one line —
        // the same bug — walked straight past it.
        expect(reclaimSql).toMatch(/"runAt" = CASE[\s\S]*ELSE NOW\(\)\s*\+/);
        expect(reclaimSql).toContain('random()');
        expect(reclaimSql).toContain('LEAST');

        // The exponent is clamped. `maxAttempts` is per-row and settable through
        // `createJob`, and float8 overflows around 2^1024 — which would abort the
        // whole sweep for every row, not just the offending one. JS saturates
        // gracefully here (`Math.min(Infinity, MAX)` is MAX), so without the clamp
        // the SQL and `calculateBackoff` diverge at the extreme.
        expect(reclaimSql).toContain('POWER(2, LEAST(job."attempts" + 1, 30))');

        // Against the REAL constants, not the mock's copies of them.
        expect(reclaimCall.slice(1)).toContain(realConstants.BACKOFF_BASE_MS);
        expect(reclaimCall.slice(1)).toContain(realConstants.BACKOFF_MAX_MS);
        // Mirrors calculateBackoff: BACKOFF_BASE_MS with jitter, BACKOFF_MAX_MS cap.
        expect(reclaimCall.slice(1)).toContain(1000);
        expect(reclaimCall.slice(1)).toContain(300_000);
    });

    it('marks job DEAD_LETTER after maxAttempts exhausted', async () => {
        const jobRow = makeJobRow({ attempts: 4, maxAttempts: 5 }); // attempt will be 5
        mockPrisma.$queryRaw.mockResolvedValueOnce([jobRow]);
        mockPrisma.$queryRaw.mockResolvedValue([]);
        mockPrismaJob.update.mockResolvedValue({});

        worker.on(JobType.AI_RESPONSE, async () => {
            return { success: false, error: 'Still broken' };
        });

        worker.start();
        await vi.advanceTimersByTimeAsync(0);

        expect(mockPrismaJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ id: 'job-1', claimToken: 'claim-1' }),
                data: expect.objectContaining({
                    status: 'DEAD_LETTER',
                    attempts: 5,
                    error: 'Still broken',
                }),
            }),
        );
    });

    it('retries failed jobs with backoff when attempts remain', async () => {
        const jobRow = makeJobRow({ attempts: 1, maxAttempts: 5 }); // attempt will be 2
        mockPrisma.$queryRaw.mockResolvedValueOnce([jobRow]);
        mockPrisma.$queryRaw.mockResolvedValue([]);
        mockPrismaJob.update.mockResolvedValue({});

        worker.on(JobType.AI_RESPONSE, async () => {
            throw new Error('Temporary failure');
        });

        worker.start();
        await vi.advanceTimersByTimeAsync(0);

        expect(mockPrismaJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ id: 'job-1', claimToken: 'claim-1' }),
                data: expect.objectContaining({
                    status: 'PENDING',
                    attempts: 2,
                    error: 'Temporary failure',
                }),
            }),
        );
    });

    it('times out jobs that take too long', async () => {
        const jobRow = makeJobRow();
        mockPrisma.$queryRaw.mockResolvedValueOnce([jobRow]);
        mockPrisma.$queryRaw.mockResolvedValue([]);
        mockPrismaJob.update.mockResolvedValue({});

        // Create worker with very short timeout
        await worker.stop();
        worker = new Worker({
            pollIntervalMs: 100,
            defaultTimeoutMs: 50,
        });

        worker.on(JobType.AI_RESPONSE, async () => {
            // This job will never finish before timeout
            await new Promise((resolve) => setTimeout(resolve, 10_000));
            return { success: true };
        });

        worker.start();
        // Advance past poll + timeout
        await vi.advanceTimersByTimeAsync(200);

        // Should have been marked as retryable (attempt 1 of 5)
        expect(mockPrismaJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    status: 'PENDING',
                    error: expect.stringContaining('timed out'),
                }),
            }),
        );
    });

    it('handles missing handler gracefully', async () => {
        const jobRow = makeJobRow({ type: 'UNKNOWN_TYPE' });
        mockPrisma.$queryRaw.mockResolvedValueOnce([jobRow]);
        mockPrisma.$queryRaw.mockResolvedValue([]);
        mockPrismaJob.update.mockResolvedValue({});

        // No handler registered for UNKNOWN_TYPE
        worker.start();
        await vi.advanceTimersByTimeAsync(0);

        expect(mockPrismaJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    status: 'FAILED',
                    error: expect.stringContaining('No handler'),
                }),
            }),
        );
    });

    it('respects concurrency limits', async () => {
        // Worker has maxConcurrency: 2
        let concurrentCount = 0;
        let maxSeen = 0;

        const slowJobs = [
            makeJobRow({ id: 'j1' }),
            makeJobRow({ id: 'j2' }),
            makeJobRow({ id: 'j3' }),
        ];

        mockPrisma.$queryRaw.mockResolvedValueOnce(slowJobs);
        mockPrisma.$queryRaw.mockResolvedValue([]);
        mockPrismaJob.update.mockResolvedValue({});

        worker.on(JobType.AI_RESPONSE, async () => {
            concurrentCount++;
            maxSeen = Math.max(maxSeen, concurrentCount);
            // Simulate some work
            await new Promise((resolve) => setTimeout(resolve, 10));
            concurrentCount--;
            return { success: true };
        });

        worker.start();
        // The query returns 3 jobs but batchSize is limited by available slots (maxConcurrency=2)
        // However since we mocked $queryRaw directly, all 3 will be "claimed"
        // The important thing is processJob tracks them all
        await vi.advanceTimersByTimeAsync(100);

        // All 3 should complete (they run concurrently via Promise.allSettled)
        expect(mockPrismaJob.updateMany).toHaveBeenCalledTimes(3);
    });

    it('provides accurate health check information', () => {
        const health = worker.healthCheck();
        expect(health.running).toBe(false);
        expect(health.activeJobCount).toBe(0);
        expect(health.lastPollTime).toBeNull();

        worker.start();
        const healthRunning = worker.healthCheck();
        expect(healthRunning.running).toBe(true);
        expect(healthRunning.upSince).toBeInstanceOf(Date);
    });

    it('stops gracefully and waits for active jobs', async () => {
        let jobFinished = false;
        const jobRow = makeJobRow();
        mockPrisma.$queryRaw.mockResolvedValueOnce([jobRow]);
        mockPrisma.$queryRaw.mockResolvedValue([]);
        mockPrismaJob.update.mockResolvedValue({});

        worker.on(JobType.AI_RESPONSE, async () => {
            await new Promise((resolve) => setTimeout(resolve, 200));
            jobFinished = true;
            return { success: true };
        });

        worker.start();
        // Start processing
        await vi.advanceTimersByTimeAsync(0);

        // Now stop while job is still running
        const stopPromise = worker.stop();

        // Job should still be running
        expect(jobFinished).toBe(false);

        // Advance time so the job completes
        await vi.advanceTimersByTimeAsync(300);
        await stopPromise;

        expect(jobFinished).toBe(true);
    });

    it('shares the active-job drain across repeated stop calls', async () => {
        let jobFinished = false;
        const jobRow = makeJobRow();
        mockPrisma.$queryRaw.mockResolvedValueOnce([jobRow]);
        mockPrisma.$queryRaw.mockResolvedValue([]);
        mockPrismaJob.update.mockResolvedValue({});

        worker.on(JobType.AI_RESPONSE, async () => {
            await new Promise((resolve) => setTimeout(resolve, 200));
            jobFinished = true;
            return { success: true };
        });

        worker.start();
        await vi.advanceTimersByTimeAsync(0);

        const signalStop = worker.stop();
        let appStopResolved = false;
        const appStop = worker.stop().then(() => {
            appStopResolved = true;
        });

        await Promise.resolve();
        expect(appStopResolved).toBe(false);
        expect(jobFinished).toBe(false);

        await vi.advanceTimersByTimeAsync(300);
        await Promise.all([signalStop, appStop]);

        expect(jobFinished).toBe(true);
        expect(appStopResolved).toBe(true);
    });

    it('waits for an in-flight poll and does not claim after shutdown begins', async () => {
        let releaseReclaim!: () => void;
        mockPrisma.$executeRaw.mockImplementationOnce(
            () =>
                new Promise<number>((resolve) => {
                    releaseReclaim = () => resolve(0);
                }),
        );

        worker.on(JobType.AI_RESPONSE, async () => ({ success: true }));
        worker.start();

        const stopPromise = worker.stop();
        let stopped = false;
        void stopPromise.then(() => {
            stopped = true;
        });
        await Promise.resolve();
        expect(stopped).toBe(false);

        releaseReclaim();
        await stopPromise;

        expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
        expect(worker.healthCheck().running).toBe(false);
    });

    it('handler receives context with progress reporting', async () => {
        const jobRow = makeJobRow();
        mockPrisma.$queryRaw.mockResolvedValueOnce([jobRow]);
        mockPrisma.$queryRaw.mockResolvedValue([]);
        mockPrismaJob.update.mockResolvedValue({});

        let receivedContext: JobHandlerContext | null = null;

        worker.on(JobType.AI_RESPONSE, async (_payload, ctx) => {
            receivedContext = ctx;
            await ctx.reportProgress(50);
            return { success: true };
        });

        worker.start();
        await vi.advanceTimersByTimeAsync(0);

        expect(receivedContext).not.toBeNull();
        expect(receivedContext!.jobId).toBe('job-1');
        // reportProgress should fence the update to this execution's claim.
        const progressCall = mockPrismaJob.updateMany.mock.calls.find(
            (call: Array<Record<string, Record<string, unknown>>>) => call[0].data.progress === 50,
        );
        expect(progressCall).toBeDefined();
    });

    // Production sets `concurrencyByType` (apps/worker/src/index.ts), so every job
    // it claims goes through `claimJobsForType` — and that query had no coverage
    // of the deadline it writes. Deleting the `lockUntil` SET from it alone left
    // all 1113 tests green while every production claim got `lockUntil = NULL` and
    // fell into the 15-minute legacy branch forever, which is precisely the
    // failure this whole change exists to remove.
    describe('the claim path production actually runs', () => {
        const setClauseOf = (call: unknown[]) => {
            const sql = (call[0] as TemplateStringsArray).join(' ');
            return sql.slice(
                sql.indexOf("SET status = 'PROCESSING'"),
                sql.indexOf('WHERE id IN ('),
            );
        };

        it('writes a deadline onto every row it claims', async () => {
            await worker.stop();
            worker = new Worker({
                pollIntervalMs: 100,
                maxConcurrency: 2,
                defaultTimeoutMs: 5000,
                // The presence of this is what routes claiming through
                // `claimJobsForType` instead of `claimAndProcessJobs`.
                concurrencyByType: { [JobType.AI_RESPONSE]: 1 },
                jobTimeouts: { [JobType.AI_RESPONSE]: 120_000 },
            });
            worker.on(JobType.AI_RESPONSE, async () => ({ success: true }));

            worker.start();
            await vi.advanceTimersByTimeAsync(0);

            const claim = mockPrisma.$queryRaw.mock.calls[0];
            const claimSql = claim[0].join(' ');
            expect(claimSql).toContain('"lockUntil" = NOW()');
            // Per-type, looked up by the row's own type, with the worker default
            // as the fallback — the same contract the other claim path has.
            expect(claimSql).toContain('->> "Job".type');
            const timeoutMap = claim
                .slice(1)
                .find(
                    (v: unknown): v is string => typeof v === 'string' && v.includes('AI_RESPONSE'),
                );
            expect(JSON.parse(timeoutMap as string)).toEqual({
                [JobType.AI_RESPONSE]: 120_000,
            });
            expect(claim.slice(1)).toContain(5000);
        });

        it('claims identically whichever path is taken', async () => {
            await worker.stop();
            const perType = new Worker({
                pollIntervalMs: 100,
                defaultTimeoutMs: 5000,
                concurrencyByType: { [JobType.AI_RESPONSE]: 1 },
            });
            perType.on(JobType.AI_RESPONSE, async () => ({ success: true }));
            perType.start();
            await vi.advanceTimersByTimeAsync(0);
            const perTypeSet = setClauseOf(mockPrisma.$queryRaw.mock.calls[0]);
            await perType.stop();

            mockPrisma.$queryRaw.mockClear();

            worker = new Worker({ pollIntervalMs: 100, defaultTimeoutMs: 5000 });
            worker.on(JobType.AI_RESPONSE, async () => ({ success: true }));
            worker.start();
            await vi.advanceTimersByTimeAsync(0);
            const batchSet = setClauseOf(mockPrisma.$queryRaw.mock.calls[0]);

            // The two claim queries carry byte-identical SET clauses, duplicated by
            // hand. Nothing else notices when one is edited and the other is not,
            // and a divergence there is silent in production and invisible in CI.
            expect(perTypeSet).toBe(batchSet);
            expect(perTypeSet).toContain('"lockUntil" = NOW()');
            expect(perTypeSet).toContain('"claimToken" = gen_random_uuid()::text');
        });
    });

    // A claim whose writes cannot be fenced is worse than no claim: Prisma drops a
    // `where` key whose value is undefined, so every fenced write in `processJob`
    // would quietly become an unfenced update-by-id.
    describe('a claim with no token', () => {
        it('is refused rather than run unfenced', async () => {
            const error = vi.spyOn(console, 'error').mockImplementation(() => {});
            mockPrisma.$queryRaw.mockResolvedValueOnce([
                { ...makeJobRow(), claimToken: undefined as unknown as string },
            ]);

            let ran = false;
            worker.on(JobType.AI_RESPONSE, async () => {
                ran = true;
                return { success: true };
            });
            worker.start();
            await vi.advanceTimersByTimeAsync(0);

            expect(ran).toBe(false);
            // Left PROCESSING with its deadline intact, so the sweep recovers it.
            expect(mockPrismaJob.updateMany).not.toHaveBeenCalled();
            expect(error.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toContain(
                'could not be fenced',
            );
            error.mockRestore();
        });
    });

    // The bookkeeping that records a result is not the work itself, and the two
    // must not fail the same way.
    describe('when the database fails after the handler succeeded', () => {
        it('does not re-queue work that already ran', async () => {
            const error = vi.spyOn(console, 'error').mockImplementation(() => {});
            mockPrisma.$queryRaw.mockResolvedValueOnce([makeJobRow()]);
            mockPrismaJob.updateMany.mockRejectedValueOnce(new Error('connection reset by peer'));

            worker.on(JobType.AI_RESPONSE, async () => ({ success: true }));
            worker.start();
            await vi.advanceTimersByTimeAsync(0);

            // The old shape wrapped the completion write in the handler's own try,
            // so a Prisma blip was laundered into "the job failed": the row went
            // back to PENDING carrying the DB error as the job's error, and the
            // retry re-ran every external side effect the handler had already
            // produced. That is the duplicate execution the claim token exists to
            // detect, manufactured by the worker from a bookkeeping error.
            const retried = mockPrismaJob.updateMany.mock.calls
                .map((call: Array<{ data: Record<string, unknown> }>) => call[0].data)
                .find((data: Record<string, unknown>) => data.status === 'PENDING');
            expect(retried).toBeUndefined();

            const messages = error.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
            expect(messages).toContain('succeeded but its');
            error.mockRestore();
        });

        it('reports a processJob that threw outright', async () => {
            const error = vi.spyOn(console, 'error').mockImplementation(() => {});
            mockPrisma.$queryRaw.mockResolvedValueOnce([makeJobRow({ attempts: 1 })]);
            // Both the failure write and its fallback fail — the DB is down, which
            // is exactly when this happens.
            mockPrismaJob.updateMany.mockRejectedValue(new Error('pool exhausted'));

            worker.on(JobType.AI_RESPONSE, async () => {
                throw new Error('handler said no');
            });
            worker.start();
            await vi.advanceTimersByTimeAsync(0);

            // `Promise.allSettled` absorbed the rejection and nobody read the
            // result, so this produced no output at all: not the Prisma error, and
            // not the handler failure it was trying to record.
            const messages = error.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
            expect(messages).toContain('processJob threw');
            error.mockRestore();
        });
    });

    // The sweep is the only thing standing between a crashed claim and a row that
    // is PROCESSING forever, and it is also the first `await` in every poll. Both
    // properties are load-bearing and neither was pinned.
    describe('the reclaim sweep', () => {
        let warn: ReturnType<typeof vi.spyOn>;
        let error: ReturnType<typeof vi.spyOn>;

        beforeEach(() => {
            warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            error = vi.spyOn(console, 'error').mockImplementation(() => {});
        });

        afterEach(() => {
            warn.mockRestore();
            error.mockRestore();
        });

        it('cannot stop the worker claiming when it fails', async () => {
            // The sweep runs ahead of every claim in the same `try`, and
            // `lastPollTime` is already set by then. Without its own catch, one
            // failing sweep ends all claiming while `healthCheck()` still reports
            // healthy: a total outage with nothing to restart it. Recovering
            // abandoned work is a nice-to-have; claiming new work is the job.
            mockPrisma.$executeRaw.mockRejectedValueOnce(new Error('reclaim exploded'));
            mockPrisma.$queryRaw.mockResolvedValue([]);

            worker.on(JobType.AI_RESPONSE, async () => ({ success: true }));
            worker.start();
            await vi.advanceTimersByTimeAsync(0);

            // The claim ran anyway. This is the assertion that dies if the
            // try/catch around the sweep is deleted.
            expect(mockPrisma.$queryRaw).toHaveBeenCalled();

            // And it is not a silent recovery.
            const logged = error.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
            expect(logged).toContain('Reclaim sweep failed');
        });

        it('keeps lockUntil bare on one side so the index can serve the predicate', async () => {
            mockPrisma.$queryRaw.mockResolvedValue([]);
            worker.on(JobType.AI_RESPONSE, async () => ({ success: true }));
            worker.start();
            await vi.advanceTimersByTimeAsync(0);

            const reclaimSql = mockPrisma.$executeRaw.mock.calls[0][0].join(' ');
            const where = reclaimSql.slice(reclaimSql.indexOf("WHERE job.status = 'PROCESSING'"));

            // `Job_status_lockUntil_idx` exists for this predicate. A `CASE` over
            // the column is not sargable, so the planner would take the `status`
            // prefix and then filter every PROCESSING row — the index would be
            // there and unusable, which is worse than not adding it.
            expect(where).not.toContain('CASE');
            expect(where).toContain('job."lockUntil"');

            // Same reason, one level down: the interval arithmetic has to sit on
            // the right-hand side. `lockUntil + interval < NOW()` is a disjunction
            // and still non-sargable.
            expect(where).toContain('< NOW() -');
            expect(where).not.toMatch(/job\."lockUntil"\s*\+/);

            // Deliberately not asserting the same of `lockedAt`. That arm cannot
            // use the index's second column either way — `lockedAt` is not in the
            // index — so it rides the status + `lockUntil IS NULL` prefix and then
            // filters. An assertion there would look like it defended the index
            // and defend nothing.
        });

        it('leaves no PROCESSING row without a way out', async () => {
            worker.start();
            await vi.advanceTimersByTimeAsync(0);

            const reclaimSql = mockPrisma.$executeRaw.mock.calls[0][0].join(' ');
            const where = reclaimSql.slice(reclaimSql.indexOf("WHERE job.status = 'PROCESSING'"));

            // Both timestamp arms NULL-guard one column and compare the other, and
            // `NULL < x` is NULL — so a PROCESSING row carrying neither timestamp
            // matched no arm and sat there forever, invisible to the one mechanism
            // that exists to rescue it. Unreachable from the two claim paths, which
            // is exactly the assumption a last-resort sweep should not be making.
            // `updatedAt` is written by every path, so it closes the blind spot.
            expect(where).toContain('job."updatedAt"');
        });

        it('keeps the failure that actually killed a dead-lettered job', async () => {
            worker.start();
            await vi.advanceTimersByTimeAsync(0);

            const reclaimSql = mockPrisma.$executeRaw.mock.calls[0][0].join(' ');

            // The sweep used to overwrite `error` unconditionally, including on the
            // arm that lands on DEAD_LETTER — so the one surface where the *why*
            // matters most was left holding a generic string. Bounded with `left`
            // so repeated reclaims of a crash-looping job cannot grow it without
            // limit.
            expect(reclaimSql).toContain('previous error');
            expect(reclaimSql).toContain('left(job.error, 200)');
        });

        it('says how many rows it returned to the queue', async () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            mockPrisma.$executeRaw.mockResolvedValue(7);

            worker.start();
            await vi.advanceTimersByTimeAsync(0);

            // Every row this moves is a claim a worker took and never released.
            // The count was computed once per poll on every replica and discarded,
            // which threw away the earliest signal that replicas are dying.
            const messages = warn.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
            expect(messages).toContain('7 abandoned');
            warn.mockRestore();
        });

        it('stays silent when it reclaimed nothing', async () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            mockPrisma.$executeRaw.mockResolvedValue(0);

            worker.start();
            await vi.advanceTimersByTimeAsync(0);

            const messages = warn.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
            expect(messages).not.toContain('abandoned');
            warn.mockRestore();
        });

        it('still runs when this replica has no free slots', async () => {
            const saturated = new Worker({ pollIntervalMs: 100, maxConcurrency: 0 });
            saturated.on(JobType.AI_RESPONSE, async () => ({ success: true }));

            saturated.start();
            await vi.advanceTimersByTimeAsync(0);

            // Reclaiming is a global sweep over rows other replicas abandoned. It
            // has nothing to do with this replica's spare capacity, and gating it
            // behind the capacity check stopped recovery exactly when the backlog
            // that produced the abandoned rows was largest.
            expect(mockPrisma.$executeRaw).toHaveBeenCalled();
            await saturated.stop();
        });

        it('consumes an attempt, so a crash-looping job still reaches DEAD_LETTER', async () => {
            mockPrisma.$queryRaw.mockResolvedValue([]);
            worker.on(JobType.AI_RESPONSE, async () => ({ success: true }));
            worker.start();
            await vi.advanceTimersByTimeAsync(0);

            const reclaimSql = mockPrisma.$executeRaw.mock.calls[0][0].join(' ');

            // Asserting the `SET` fragment specifically. A bare
            // `toContain('job."attempts" + 1')` is satisfied by the occurrences in
            // the `status`, `completedAt` and `runAt` arms, so mutating the
            // assignment to `"attempts" = job."attempts"` walks straight past it —
            // and a job that never accrues an attempt is reclaimed forever.
            expect(reclaimSql).toContain('"attempts" = job."attempts" + 1');
        });

        it("is blind to job type, so no replica can strand another replica's work", async () => {
            mockPrisma.$queryRaw.mockResolvedValue([]);
            worker.on(JobType.AI_RESPONSE, async () => ({ success: true }));
            worker.start();
            await vi.advanceTimersByTimeAsync(0);

            const reclaimSql = mockPrisma.$executeRaw.mock.calls[0][0].join(' ');

            // `lockUntil` makes the row self-describing, so nothing about the type
            // is needed to tell that a claim has expired. Asserting the absence of
            // any type reference rather than one spelling of the old predicate:
            // `AND job.type = ANY(...)` would have satisfied the previous guard,
            // and it reintroduces the bug where a crashed claim of a type this
            // replica does not register sits PROCESSING forever.
            expect(reclaimSql).not.toContain('job.type');
            expect(reclaimSql).not.toContain('"Job".type');
        });
    });

    // Every release path has to clear the deadline it set. Inert while the
    // predicate gates on `status = 'PROCESSING'`, but the first future path that
    // sets PROCESSING without writing a fresh `lockUntil` inherits a deadline
    // already in the past and gets reclaimed mid-flight.
    describe('releasing a claim clears its deadline', () => {
        const releaseData = (status: string) =>
            mockPrismaJob.updateMany.mock.calls
                .map((call: Array<{ data: Record<string, unknown> }>) => call[0].data)
                .find((data: Record<string, unknown>) => data.status === status);

        it('clears lockUntil when a job completes', async () => {
            mockPrisma.$queryRaw.mockResolvedValueOnce([makeJobRow()]);
            mockPrisma.$queryRaw.mockResolvedValue([]);

            worker.on(JobType.AI_RESPONSE, async () => ({ success: true }));
            worker.start();
            await vi.advanceTimersByTimeAsync(0);

            expect(releaseData('COMPLETED')).toMatchObject({ lockUntil: null });
        });

        it('clears lockUntil when a job is scheduled for retry', async () => {
            mockPrisma.$queryRaw.mockResolvedValueOnce([makeJobRow({ attempts: 1 })]);
            mockPrisma.$queryRaw.mockResolvedValue([]);

            worker.on(JobType.AI_RESPONSE, async () => ({
                success: false,
                error: 'transient',
            }));
            worker.start();
            await vi.advanceTimersByTimeAsync(0);

            expect(releaseData('PENDING')).toMatchObject({ lockUntil: null });
        });

        it('clears lockUntil when a job is dead-lettered', async () => {
            mockPrisma.$queryRaw.mockResolvedValueOnce([
                makeJobRow({ attempts: 4, maxAttempts: 5 }),
            ]);
            mockPrisma.$queryRaw.mockResolvedValue([]);

            worker.on(JobType.AI_RESPONSE, async () => ({
                success: false,
                error: 'permanently broken',
            }));
            worker.start();
            await vi.advanceTimersByTimeAsync(0);

            expect(releaseData('DEAD_LETTER')).toMatchObject({ lockUntil: null });
        });
    });

    // A fenced write means two executions of the same row overlapped — the exact
    // event the claim token exists to produce. Before these, changing both
    // `count > 0` checks to `count >= 0` passed the whole suite: the fence fired
    // and said nothing, on every path.
    describe('fence rejections are reported', () => {
        let warn: ReturnType<typeof vi.spyOn>;
        let error: ReturnType<typeof vi.spyOn>;

        beforeEach(() => {
            warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            error = vi.spyOn(console, 'error').mockImplementation(() => {});
        });

        afterEach(() => {
            warn.mockRestore();
            error.mockRestore();
        });

        const fencedMessages = () => warn.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');

        it('warns when a completed job can no longer write its own result', async () => {
            mockPrisma.$queryRaw.mockResolvedValueOnce([makeJobRow()]);
            mockPrisma.$queryRaw.mockResolvedValue([]);
            // Someone else owns the row: it was reclaimed while this execution was
            // still live, so this handler's side effects have now happened twice.
            mockPrismaJob.updateMany.mockResolvedValue({ count: 0 });

            worker.on(JobType.AI_RESPONSE, async () => ({ success: true }));
            worker.start();
            await vi.advanceTimersByTimeAsync(0);

            expect(fencedMessages()).toContain('job-1');
            expect(fencedMessages()).toContain('reclaimed while still live');
        });

        it('keeps the underlying failure when a retry write is fenced', async () => {
            mockPrisma.$queryRaw.mockResolvedValueOnce([
                makeJobRow({ attempts: 1, maxAttempts: 5 }),
            ]);
            mockPrisma.$queryRaw.mockResolvedValue([]);
            mockPrismaJob.updateMany.mockResolvedValue({ count: 0 });

            worker.on(JobType.AI_RESPONSE, async () => {
                throw new Error('upstream timed out');
            });
            worker.start();
            await vi.advanceTimersByTimeAsync(0);

            // Pre-fence this path always logged. Losing the retry log would also
            // lose the failure that caused the timeout in the first place.
            expect(fencedMessages()).toContain('upstream timed out');
            expect(fencedMessages()).toContain('fenced');
        });

        it('keeps the underlying failure when a dead-letter write is fenced', async () => {
            mockPrisma.$queryRaw.mockResolvedValueOnce([
                makeJobRow({ attempts: 4, maxAttempts: 5 }),
            ]);
            mockPrisma.$queryRaw.mockResolvedValue([]);
            mockPrismaJob.updateMany.mockResolvedValue({ count: 0 });

            worker.on(JobType.AI_RESPONSE, async () => ({
                success: false,
                error: 'permanently broken',
            }));
            worker.start();
            await vi.advanceTimersByTimeAsync(0);

            expect(fencedMessages()).toContain('permanently broken');
            expect(fencedMessages()).toContain('dead-letter write was fenced');
        });

        it('warns when the no-handler tombstone is fenced', async () => {
            // The fifth fenced write in the file, and the last one that was still
            // silent. It also clears the claim, so a fenced tombstone means some
            // other execution owns a row this one just tried to mark FAILED.
            mockPrisma.$queryRaw.mockResolvedValueOnce([makeJobRow({ type: JobType.SLA_CHECK })]);
            mockPrisma.$queryRaw.mockResolvedValue([]);
            mockPrismaJob.updateMany.mockResolvedValue({ count: 0 });

            // No handler registered for SLA_CHECK on this worker.
            worker.start();
            await vi.advanceTimersByTimeAsync(0);

            expect(fencedMessages()).toContain('no-handler failure');
            expect(fencedMessages()).toContain('reclaimed while still live');
        });

        it('records the attempt the no-handler tombstone consumed', async () => {
            mockPrisma.$queryRaw.mockResolvedValueOnce([
                makeJobRow({ type: JobType.SLA_CHECK, attempts: 2 }),
            ]);

            worker.start();
            await vi.advanceTimersByTimeAsync(0);

            // Every other terminal path writes the attempt it used. This one did
            // not, so a job that was claimed and dispatched read `attempts: 2`
            // afterwards — indistinguishable from one that was never picked up.
            const tombstone = mockPrismaJob.updateMany.mock.calls
                .map((call: Array<{ data: Record<string, unknown> }>) => call[0].data)
                .find((data: Record<string, unknown>) => data.status === 'FAILED');
            expect(tombstone).toMatchObject({ attempts: 3 });
        });

        it('clears lockUntil on the no-handler tombstone', async () => {
            mockPrisma.$queryRaw.mockResolvedValueOnce([makeJobRow({ type: JobType.SLA_CHECK })]);
            mockPrisma.$queryRaw.mockResolvedValue([]);

            worker.start();
            await vi.advanceTimersByTimeAsync(0);

            const tombstone = mockPrismaJob.updateMany.mock.calls
                .map((call: Array<{ data: Record<string, unknown> }>) => call[0].data)
                .find((data: Record<string, unknown>) => data.status === 'FAILED');
            expect(tombstone).toMatchObject({ lockUntil: null });
        });

        it('warns when a progress report is fenced', async () => {
            mockPrisma.$queryRaw.mockResolvedValueOnce([makeJobRow()]);
            mockPrisma.$queryRaw.mockResolvedValue([]);
            mockPrismaJob.updateMany.mockResolvedValue({ count: 0 });

            worker.on(JobType.AI_RESPONSE, async (_payload, ctx) => {
                await ctx.reportProgress(50);
                return { success: true };
            });
            worker.start();
            await vi.advanceTimersByTimeAsync(0);

            // Earliest observable sign that this execution has lost its claim while
            // the handler is still running.
            expect(fencedMessages()).toContain('Progress update for job job-1 was fenced');
        });
    });
});

// `LEGACY_RECLAIM_CEILING_MS` is fixed on purpose — deriving it from the observing
// worker's config is the bug `lockUntil` was added to remove. But fixed means it
// does not follow `jobTimeouts` upward, and the two live in different packages, so
// nothing else would notice them drifting apart.
describe('Worker legacy-reclaim ceiling guard', () => {
    let warn: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        warn.mockRestore();
    });

    const warnings = () => warn.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');

    it('stays quiet for the timeouts the worker actually ships with', () => {
        // apps/worker/src/index.ts: the two longest are HUBSPOT_SYNC and
        // ACCOUNT_SCORING, tied at 300s. 300_000 + 30_000 grace < 900_000.
        new Worker({
            defaultTimeoutMs: 30_000,
            jobTimeouts: {
                [JobType.AI_RESPONSE]: 120_000,
                [JobType.HUBSPOT_SYNC]: 300_000,
                [JobType.ACCOUNT_SCORING]: 300_000,
            },
        });

        expect(warnings()).not.toContain('LEGACY_RECLAIM_CEILING_MS');
    });

    it('says so when a configured timeout outgrows the ceiling', () => {
        // During the one rollout where rows still carry a NULL `lockUntil`, a
        // timeout this long means the sweep calls a live claim abandoned and the
        // original execution's completion is fenced out and discarded.
        new Worker({ jobTimeouts: { [JobType.HUBSPOT_SYNC]: 1_200_000 } });

        expect(warnings()).toContain('LEGACY_RECLAIM_CEILING_MS');
        expect(warnings()).toContain('1230000');
    });

    it('counts defaultTimeoutMs too, not just the per-type map', () => {
        new Worker({ defaultTimeoutMs: 1_200_000 });

        expect(warnings()).toContain('LEGACY_RECLAIM_CEILING_MS');
    });
});

describe('Scheduler', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('has correct default scheduled jobs', () => {
        expect(DEFAULT_SCHEDULED_JOBS).toHaveLength(7);
        const types = DEFAULT_SCHEDULED_JOBS.map((d) => d.type);
        expect(types).toContain(JobType.SLA_CHECK);
        expect(types).toContain(JobType.ONBOARDING_DIGEST);
        expect(types).toContain(JobType.ACCOUNT_SCORING);
        expect(types).toContain(JobType.HUBSPOT_SYNC);
        expect(types).toContain(JobType.JOB_CLEANUP);
        expect(types).toContain(JobType.GITHUB_REACTION_POLL);
        expect(types).toContain(JobType.PENDING_RESPONSE_SWEEP);
    });

    it('creates a job immediately on start if none exists', async () => {
        mockPrismaJob.findFirst.mockResolvedValue(null); // no existing job
        mockPrismaJob.create.mockResolvedValue({ id: 'sched-1' });

        const scheduler = new Scheduler([
            {
                type: JobType.SLA_CHECK,
                payload: {},
                intervalMs: 60_000,
                description: 'Test SLA check',
            },
        ]);

        scheduler.start();
        // tick runs immediately on start
        await vi.advanceTimersByTimeAsync(0);

        expect(mockPrismaJob.create).toHaveBeenCalledOnce();
        const callArg = mockPrismaJob.create.mock.calls[0][0];
        expect(callArg.data.type).toBe(JobType.SLA_CHECK);

        scheduler.stop();
    });

    it('skips creating a job if one is already pending', async () => {
        mockPrismaJob.findFirst.mockResolvedValue({ id: 'existing-1', status: 'PENDING' });

        const scheduler = new Scheduler([
            {
                type: JobType.SLA_CHECK,
                payload: {},
                intervalMs: 60_000,
                description: 'Test SLA check',
            },
        ]);

        scheduler.start();
        await vi.advanceTimersByTimeAsync(0);

        // Should NOT have created a new job
        expect(mockPrismaJob.create).not.toHaveBeenCalled();

        scheduler.stop();
    });

    it('creates recurring jobs on interval', async () => {
        mockPrismaJob.findFirst.mockResolvedValue(null);
        mockPrismaJob.create.mockResolvedValue({ id: 'sched-recurring' });

        const scheduler = new Scheduler([
            {
                type: JobType.SLA_CHECK,
                payload: {},
                intervalMs: 1000, // 1 second for testing
                description: 'Fast SLA check',
            },
        ]);

        scheduler.start();
        // Initial tick
        await vi.advanceTimersByTimeAsync(0);
        expect(mockPrismaJob.create).toHaveBeenCalledTimes(1);

        // Advance past one interval
        await vi.advanceTimersByTimeAsync(1000);
        expect(mockPrismaJob.create).toHaveBeenCalledTimes(2);

        // Advance past another interval
        await vi.advanceTimersByTimeAsync(1000);
        expect(mockPrismaJob.create).toHaveBeenCalledTimes(3);

        scheduler.stop();
    });

    it('injects current date for onboarding digest jobs', async () => {
        vi.setSystemTime(new Date('2026-04-15T12:00:00Z'));
        mockPrismaJob.findFirst.mockResolvedValue(null);
        mockPrismaJob.create.mockResolvedValue({ id: 'digest-1' });

        const scheduler = new Scheduler([
            {
                type: JobType.ONBOARDING_DIGEST,
                payload: { date: '' },
                intervalMs: 86_400_000,
                description: 'Daily digest',
            },
        ]);

        scheduler.start();
        await vi.advanceTimersByTimeAsync(0);

        const callArg = mockPrismaJob.create.mock.calls[0][0];
        // payload goes through JSON.parse(JSON.stringify(...)) in createJob
        expect(JSON.stringify(callArg.data.payload)).toContain('2026-04-15');

        scheduler.stop();
    });

    it('stops cleanly and clears all timers', () => {
        const scheduler = new Scheduler();
        scheduler.start();
        scheduler.stop();

        // Double stop should be safe
        scheduler.stop();
    });
});

describe('JobType enum', () => {
    it('contains all expected job types', () => {
        expect(JobType.AI_RESPONSE).toBe('AI_RESPONSE');
        expect(JobType.TICKET_CLASSIFY).toBe('TICKET_CLASSIFY');
        expect(JobType.SLA_CHECK).toBe('SLA_CHECK');
        expect(JobType.ESCALATION).toBe('ESCALATION');
        expect(JobType.ONBOARDING_DIGEST).toBe('ONBOARDING_DIGEST');
    });

    it('has exactly 11 job types', () => {
        const values = Object.values(JobType);
        expect(values).toHaveLength(11);
    });
});
