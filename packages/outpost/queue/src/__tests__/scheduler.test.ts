import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockPrisma, mockCreateJob } = vi.hoisted(() => ({
    mockPrisma: { job: { findFirst: vi.fn() } },
    mockCreateJob: vi.fn(),
}));

vi.mock('@copilotkit/outpost/db', () => ({
    prisma: mockPrisma,
}));

vi.mock('../create-job.js', () => ({
    createJob: mockCreateJob,
}));

import { DEFAULT_SCHEDULED_JOBS, Scheduler, resolveScheduledJobs } from '../scheduler.js';
import { JobType } from '../types.js';

const HUBSPOT_SKIP_LINE =
    '[Scheduler] Skipping HUBSPOT_SYNC: HUBSPOT_API_KEY is not set (set it to enable the HubSpot sync)';

describe('DEFAULT_SCHEDULED_JOBS', () => {
    it('includes GITHUB_REACTION_POLL in the default scheduled jobs at a 24 hour interval', () => {
        const definition = DEFAULT_SCHEDULED_JOBS.find(
            (d) => d.type === JobType.GITHUB_REACTION_POLL,
        );
        expect(definition).toBeDefined();
        expect(definition!.intervalMs).toBe(24 * 60 * 60 * 1000);
    });

    it('schedules PENDING_RESPONSE_SWEEP every 5 minutes', () => {
        // Without a recurring schedule the sweep never runs, and a primary AI
        // response whose owning job dead-lettered stays PENDING forever — the
        // silence the responseState machine exists to prevent.
        const definition = DEFAULT_SCHEDULED_JOBS.find(
            (d) => d.type === JobType.PENDING_RESPONSE_SWEEP,
        );
        expect(definition).toBeDefined();
        expect(definition!.intervalMs).toBe(5 * 60 * 1000);
    });
});

describe('resolveScheduledJobs', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        logSpy.mockRestore();
    });

    it.each([
        ['unset', {}],
        ['empty', { HUBSPOT_API_KEY: '' }],
        ['whitespace-only', { HUBSPOT_API_KEY: '   ' }],
    ])('drops HUBSPOT_SYNC and logs one skip line when HUBSPOT_API_KEY is %s', (_label, env) => {
        // Without a key every HUBSPOT_SYNC run fails at client construction and
        // dead-letters, so the job is not scheduled at all.
        const definitions = resolveScheduledJobs(DEFAULT_SCHEDULED_JOBS, env);

        expect(definitions.map((d) => d.type)).not.toContain(JobType.HUBSPOT_SYNC);
        expect(definitions).toHaveLength(DEFAULT_SCHEDULED_JOBS.length - 1);
        expect(logSpy).toHaveBeenCalledTimes(1);
        expect(logSpy).toHaveBeenCalledWith(HUBSPOT_SKIP_LINE);
    });

    it('keeps every default job, HUBSPOT_SYNC included, when HUBSPOT_API_KEY is set', () => {
        const definitions = resolveScheduledJobs(DEFAULT_SCHEDULED_JOBS, {
            HUBSPOT_API_KEY: 'dummy-key',
        });

        expect(definitions).toEqual(DEFAULT_SCHEDULED_JOBS);
        expect(logSpy).not.toHaveBeenCalled();
    });
});

describe('Scheduler default definitions', () => {
    const savedKey = process.env.HUBSPOT_API_KEY;
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        mockPrisma.job.findFirst.mockReset().mockResolvedValue(null);
        mockCreateJob.mockReset().mockResolvedValue('job-id');
    });

    afterEach(() => {
        logSpy.mockRestore();
        if (savedKey === undefined) delete process.env.HUBSPOT_API_KEY;
        else process.env.HUBSPOT_API_KEY = savedKey;
    });

    async function startAndCollectCreatedTypes(): Promise<string[]> {
        const scheduler = new Scheduler();
        scheduler.start();
        scheduler.stop();
        // start() fires each tick without awaiting; let them settle.
        await vi.waitFor(() =>
            expect(mockCreateJob).toHaveBeenCalledTimes(mockPrisma.job.findFirst.mock.calls.length),
        );
        return mockCreateJob.mock.calls.map((call) => call[0] as string);
    }

    it('never creates a HUBSPOT_SYNC job when HUBSPOT_API_KEY is unset', async () => {
        delete process.env.HUBSPOT_API_KEY;

        const created = await startAndCollectCreatedTypes();

        expect(created).not.toContain(JobType.HUBSPOT_SYNC);
        expect(created).toHaveLength(DEFAULT_SCHEDULED_JOBS.length - 1);
        expect(logSpy).toHaveBeenCalledWith(HUBSPOT_SKIP_LINE);
    });

    it('creates a HUBSPOT_SYNC job as before when HUBSPOT_API_KEY is set', async () => {
        process.env.HUBSPOT_API_KEY = 'dummy-key';

        const created = await startAndCollectCreatedTypes();

        expect(created).toContain(JobType.HUBSPOT_SYNC);
        expect(created).toHaveLength(DEFAULT_SCHEDULED_JOBS.length);
        expect(logSpy).not.toHaveBeenCalledWith(HUBSPOT_SKIP_LINE);
    });
});
