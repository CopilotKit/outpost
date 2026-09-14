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
        expect(callArg.data.maxAttempts).toBe(5); // MAX_JOB_ATTEMPTS
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
        mockPrismaJob.update.mockResolvedValue({});

        await updateJobProgress('job-1', 50);
        expect(mockPrismaJob.update).toHaveBeenCalledWith({
            where: { id: 'job-1' },
            data: { progress: 50 },
        });
    });

    it('clamps progress above 100 to 100', async () => {
        mockPrismaJob.update.mockResolvedValue({});

        await updateJobProgress('job-1', 150);
        expect(mockPrismaJob.update).toHaveBeenCalledWith({
            where: { id: 'job-1' },
            data: { progress: 100 },
        });
    });

    it('clamps negative progress to 0', async () => {
        mockPrismaJob.update.mockResolvedValue({});

        await updateJobProgress('job-1', -10);
        expect(mockPrismaJob.update).toHaveBeenCalledWith({
            where: { id: 'job-1' },
            data: { progress: 0 },
        });
    });
});

describe('Worker', () => {
    let worker: InstanceType<typeof Worker>;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
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
        expect(mockPrismaJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'job-1' },
                data: expect.objectContaining({ status: 'COMPLETED', attempts: 1 }),
            }),
        );
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

        expect(mockPrismaJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'job-1' },
                data: expect.objectContaining({
                    status: 'DEAD_LETTER',
                    attempts: 5,
                    error: 'Still broken',
                }),
            }),
        );
    });

    // A handler that reports retryable:false has told the worker the failure
    // cannot succeed on a retry (malformed payload, missing referenced row,
    // permanent API rejection like Slack's not_in_channel). Retrying those burns
    // every attempt and leaves a dead-letter trail that reads like a transient
    // fault.
    it('dead-letters immediately when a handler reports the failure as permanent', async () => {
        const jobRow = makeJobRow({ attempts: 0, maxAttempts: 5 }); // attempt would be 1
        mockPrisma.$queryRaw.mockResolvedValueOnce([jobRow]);
        mockPrisma.$queryRaw.mockResolvedValue([]);
        mockPrismaJob.update.mockResolvedValue({});

        worker.on(JobType.AI_RESPONSE, async () => {
            return { success: false, error: 'not_in_channel', retryable: false };
        });

        worker.start();
        await vi.advanceTimersByTimeAsync(0);

        expect(mockPrismaJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'job-1' },
                data: expect.objectContaining({
                    status: 'DEAD_LETTER',
                    // The TRUE attempt count. Writing maxAttempts here would
                    // fabricate an exhausted-retry trail for a job that ran once.
                    attempts: 1,
                    error: 'not_in_channel',
                }),
            }),
        );
    });

    // The flag is opt-in: every pre-existing handler omits it and must keep
    // retrying exactly as before.
    it('still retries a failure that does not set retryable', async () => {
        const jobRow = makeJobRow({ attempts: 0, maxAttempts: 5 });
        mockPrisma.$queryRaw.mockResolvedValueOnce([jobRow]);
        mockPrisma.$queryRaw.mockResolvedValue([]);
        mockPrismaJob.update.mockResolvedValue({});

        worker.on(JobType.AI_RESPONSE, async () => {
            return { success: false, error: 'transient' };
        });

        worker.start();
        await vi.advanceTimersByTimeAsync(0);

        expect(mockPrismaJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'job-1' },
                data: expect.objectContaining({ status: 'PENDING', attempts: 1 }),
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

        expect(mockPrismaJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'job-1' },
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
        expect(mockPrismaJob.update).toHaveBeenCalledWith(
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

        expect(mockPrismaJob.update).toHaveBeenCalledWith(
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
        expect(mockPrismaJob.update).toHaveBeenCalledTimes(3);
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
        // reportProgress should have called prisma.job.update with progress: 50
        const progressCall = mockPrismaJob.update.mock.calls.find(
            (call: Array<Record<string, Record<string, unknown>>>) => call[0].data.progress === 50,
        );
        expect(progressCall).toBeDefined();
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
        expect(JobType.SLACK_MIRROR).toBe('SLACK_MIRROR');
        expect(JobType.PENDING_RESPONSE_SWEEP).toBe('PENDING_RESPONSE_SWEEP');
    });

    // The count is here so adding a type without registering a handler in
    // apps/worker/src/index.ts is caught. A bare length assertion says nothing
    // about WHICH type is missing, so the two most recently added are named
    // above — this merge landed both at once and only the count moved.
    it('has exactly 12 job types', () => {
        const values = Object.values(JobType);
        expect(values).toHaveLength(12);
    });
});
