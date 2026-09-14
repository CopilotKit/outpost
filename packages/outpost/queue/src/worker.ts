import { prisma } from '@copilotkit/outpost/db';
import { calculateBackoff } from '@copilotkit/outpost/shared';
import { updateJobProgress } from './create-job.js';
import type {
    JobType,
    JobHandler,
    JobResult,
    WorkerOptions,
    WorkerHealthStatus,
    JobHandlerContext,
} from './types.js';

/**
 * A worker that polls the Postgres job queue and processes jobs using
 * SELECT ... FOR UPDATE SKIP LOCKED for safe concurrent processing.
 *
 * Features:
 * - Graceful shutdown on SIGTERM/SIGINT
 * - Per-job-type timeout support
 * - Job progress tracking
 * - Dead letter queue after maxAttempts exhausted
 * - Configurable concurrency (global + per-type pools)
 * - Health check endpoint
 */
export class Worker {
    private handlers = new Map<string, JobHandler<JobType>>();
    private running = false;
    private shuttingDown = false;
    private pollIntervalMs: number;
    private batchSize: number;
    private maxConcurrency: number;
    private concurrencyByType: Partial<Record<string, number>>;
    private jobTimeouts: Partial<Record<JobType, number>>;
    private defaultTimeoutMs: number;
    private pollTimer: ReturnType<typeof setTimeout> | null = null;
    private activeJobs = new Set<string>();
    /** Track active job counts per type for per-type concurrency enforcement */
    private activeJobsByType = new Map<string, number>();
    private lastPollTime: Date | null = null;
    /**
     * When the in-flight poll began, or null when no poll is running.
     *
     * `lastPollTime` alone cannot distinguish "busy" from "wedged": poll()
     * stamps it and then awaits Promise.allSettled over every claimed job, so a
     * 300s job freezes the stamp for 300s on a perfectly healthy worker. A
     * health check that reads only the stamp reports such a worker stalled and
     * the container probe kills it mid-job. These two fields separate the
     * question "is a poll running right now" from "how long since one finished".
     */
    private pollStartedAt: Date | null = null;
    /** Start time and own timeout of every in-flight job, keyed by job id. */
    private activeJobStarts = new Map<
        string,
        { type: string; startedAt: Date; timeoutMs: number }
    >();
    /** When a job last reached its `finally`, whatever the outcome. */
    private lastJobSettledAt: Date | null = null;
    /**
     * When the current unbroken run of poll failures began, or null if the last
     * poll returned normally.
     *
     * A poll that THROWS is not a poll that found nothing, but `completePoll()`
     * runs on the error path too — deliberately, so a dead loop is not reported
     * as busy forever — and that stamps `lastPollCompletedAt` exactly as success
     * would. Without this, a worker whose every claim query fails is
     * indistinguishable from an idle one, and answers 200 forever.
     *
     * A window rather than a count, so one blip during a Postgres failover does
     * not flap the probe.
     */
    private pollFailingSince: Date | null = null;
    private consecutivePollFailures = 0;
    /** When the last poll returned. Only meaningful while pollStartedAt is null. */
    private lastPollCompletedAt: Date | null = null;
    private upSince: Date | null = null;
    private shutdownResolve: (() => void) | null = null;
    private signalHandlers: { signal: string; handler: () => void }[] = [];

    constructor(options?: WorkerOptions) {
        this.pollIntervalMs = options?.pollIntervalMs ?? 1000;
        this.batchSize = options?.batchSize ?? 10;
        this.maxConcurrency = options?.maxConcurrency ?? 5;
        this.concurrencyByType = (options?.concurrencyByType ?? {}) as Partial<
            Record<string, number>
        >;
        this.jobTimeouts = options?.jobTimeouts ?? {};
        this.defaultTimeoutMs = options?.defaultTimeoutMs ?? 30_000;
    }

    /**
     * Register a handler for a specific job type.
     */
    on<T extends JobType>(type: T, handler: JobHandler<T>): void {
        this.handlers.set(type, handler as unknown as JobHandler<JobType>);
    }

    /**
     * Start processing jobs.
     * Registers signal handlers for graceful shutdown.
     */
    start(): void {
        if (this.running) return;
        this.running = true;
        this.shuttingDown = false;
        this.upSince = new Date();
        console.log('[Queue Worker] Started');
        this.registerSignalHandlers();
        this.poll();
    }

    /**
     * Stop processing jobs gracefully.
     * Waits for all active jobs to complete before resolving.
     */
    async stop(): Promise<void> {
        if (!this.running) return;
        this.shuttingDown = true;
        this.running = false;

        // A stopped worker has no poll in flight, whatever the poll that is
        // still unwinding thinks. Health checks read `running` first, but leaving
        // a marker set here would make the snapshot self-contradictory.
        this.pollStartedAt = null;

        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }

        this.removeSignalHandlers();

        // Wait for active jobs to finish
        if (this.activeJobs.size > 0) {
            console.log(
                `[Queue Worker] Waiting for ${this.activeJobs.size} active jobs to complete...`,
            );
            await new Promise<void>((resolve) => {
                this.shutdownResolve = resolve;
                // Check immediately in case jobs finished between the check and setting the resolver
                if (this.activeJobs.size === 0) {
                    this.shutdownResolve = null;
                    resolve();
                }
            });
        }

        this.upSince = null;
        console.log('[Queue Worker] Stopped');
    }

    /**
     * Return the current health status of the worker.
     */
    healthCheck(): WorkerHealthStatus {
        return {
            running: this.running,
            activeJobCount: this.activeJobs.size,
            activeJobsByType: Object.fromEntries(this.activeJobsByType),
            lastPollTime: this.lastPollTime,
            pollStartedAt: this.pollStartedAt,
            lastPollCompletedAt: this.lastPollCompletedAt,
            overdueJobCount: this.overdueJobCount(),
            lastJobSettledAt: this.lastJobSettledAt,
            pollFailingSince: this.pollFailingSince,
            consecutivePollFailures: this.consecutivePollFailures,
            registeredHandlers: Array.from(this.handlers.keys()),
            upSince: this.upSince,
        };
    }

    /**
     * How far past its own timeout an in-flight job may run before it counts as
     * overdue.
     *
     * runWithTimeout bounds only the handler; the status write that follows it is
     * untimed (see processJob), so a job legitimately overshoots its timeout by a
     * little on a slow database. It does not overshoot by a minute.
     */
    private static readonly JOB_OVERRUN_GRACE_MS = 60_000;

    /**
     * In-flight jobs that have outlived their own timeout plus the grace.
     *
     * This is the liveness signal, and it is deliberately per-job rather than
     * derived from poll duration. An earlier version of the health check bounded
     * the whole poll at `max(jobTimeouts) + grace`, which is simply not what a
     * poll is: claimJobsByType awaits each type's batch SEQUENTIALLY, so one poll
     * can legitimately run the SUM of every registered type's timeout — 930s
     * against the worker's real configuration, versus a 360s bound. A healthy
     * worker working through a backlog was reported stalled and the container
     * probe killed it mid-job.
     *
     * Asking whether any single job has outlived its own timeout needs no
     * scheduling arithmetic, so it cannot drift out of step with how poll()
     * batches. A non-zero count means the timeout machinery itself failed —
     * which also catches the case where a job's untimed status write hangs, its
     * `finally` never runs, and the poll spins at capacity looking healthy.
     */
    private overdueJobCount(now: number = Date.now()): number {
        let overdue = 0;
        for (const { startedAt, timeoutMs } of this.activeJobStarts.values()) {
            if (now - startedAt.getTime() > timeoutMs + Worker.JOB_OVERRUN_GRACE_MS) overdue++;
        }
        return overdue;
    }

    private registerSignalHandlers(): void {
        const handler = () => {
            console.log('[Queue Worker] Received shutdown signal');
            this.stop();
        };
        for (const signal of ['SIGTERM', 'SIGINT'] as const) {
            process.on(signal, handler);
            this.signalHandlers.push({ signal, handler });
        }
    }

    private removeSignalHandlers(): void {
        for (const { signal, handler } of this.signalHandlers) {
            process.removeListener(signal, handler);
        }
        this.signalHandlers = [];
    }

    private async poll(): Promise<void> {
        if (!this.running) return;

        this.pollStartedAt = new Date();
        try {
            this.lastPollTime = this.pollStartedAt;
            const availableSlots = this.maxConcurrency - this.activeJobs.size;

            if (availableSlots <= 0) {
                // At capacity, wait and retry
                this.completePoll();
                this.reschedule(this.pollIntervalMs);
                return;
            }

            const hasPerTypeLimits = Object.keys(this.concurrencyByType).length > 0;
            let processedCount: number;

            if (hasPerTypeLimits) {
                processedCount = await this.claimJobsByType(availableSlots);
            } else {
                processedCount = await this.claimAndProcessJobs(
                    Math.min(availableSlots, this.batchSize),
                );
            }

            // If we processed jobs, poll immediately for more
            const nextPollDelay = processedCount > 0 ? 0 : this.pollIntervalMs;
            // Belt and braces: a poll that claimed nothing at all still proves
            // the database answered.
            this.recordPollSuccess();
            this.completePoll();
            this.reschedule(nextPollDelay);
        } catch (error) {
            console.error('[Queue Worker] Poll error:', error);
            this.consecutivePollFailures++;
            this.pollFailingSince ??= new Date();
            this.completePoll();
            this.reschedule(this.pollIntervalMs);
        }
    }

    /**
     * Mark the in-flight poll finished. Called on every exit path out of poll()
     * — including the error path, because a poll that threw has still stopped
     * running, and leaving pollStartedAt set would report a dead loop as busy
     * forever.
     */
    /** The database answered a claim, so any open failure window is closed. */
    private recordPollSuccess(): void {
        this.pollFailingSince = null;
        this.consecutivePollFailures = 0;
    }

    private completePoll(): void {
        this.pollStartedAt = null;
        this.lastPollCompletedAt = new Date();
    }

    /**
     * Re-arm the poll loop, unless the worker has stopped.
     *
     * shutdown() calls `await worker.stop()` with a job potentially in flight,
     * and the poll awaiting that job resumes AFTER stop() has cleared the timer.
     * Without this check it installs a fresh timer behind the stop, so
     * `await worker.stop()` returns while a live handle is still queued to claim
     * more work.
     */
    private reschedule(delayMs: number): void {
        if (!this.running) return;
        this.pollTimer = setTimeout(() => this.poll(), delayMs);
    }

    /**
     * Claim jobs respecting per-type concurrency limits.
     * For each registered job type that has available capacity, claim up to
     * the available slots for that type.
     */
    private async claimJobsByType(globalSlots: number): Promise<number> {
        let totalProcessed = 0;
        let remainingGlobalSlots = globalSlots;

        // Determine which types have capacity
        const typesWithCapacity: Array<{ type: string; available: number }> = [];

        for (const [type] of this.handlers) {
            if (remainingGlobalSlots <= 0) break;

            const typeLimit = this.concurrencyByType[type];
            const activeForType = this.activeJobsByType.get(type) ?? 0;

            if (typeLimit !== undefined) {
                const available = typeLimit - activeForType;
                if (available > 0) {
                    typesWithCapacity.push({
                        type,
                        available: Math.min(available, remainingGlobalSlots),
                    });
                }
            } else {
                // No per-type limit; bound by global slots only
                typesWithCapacity.push({
                    type,
                    available: remainingGlobalSlots,
                });
            }
        }

        // Claim jobs for each type that has capacity
        for (const { type, available } of typesWithCapacity) {
            if (remainingGlobalSlots <= 0) break;

            const limit = Math.min(available, remainingGlobalSlots, this.batchSize);
            const jobs = await this.claimJobsForType(type, limit);
            // The claim came back, so the database is answering. Cleared here
            // rather than at the end of the poll body: a poll that recovers then
            // spends 300s processing what it claimed would otherwise report
            // "every poll has failed" for that whole window, about a poll in the
            // middle of succeeding.
            this.recordPollSuccess();

            if (jobs.length > 0) {
                const promises = jobs.map((job) => this.processJob(job));
                await Promise.allSettled(promises);
                totalProcessed += jobs.length;
                remainingGlobalSlots -= jobs.length;
            }
        }

        return totalProcessed;
    }

    /**
     * Claim pending jobs of a specific type using SKIP LOCKED.
     */
    private async claimJobsForType(
        type: string,
        limit: number,
    ): Promise<
        Array<{
            id: string;
            type: string;
            payload: unknown;
            attempts: number;
            maxAttempts: number;
        }>
    > {
        return prisma.$queryRaw<
            Array<{
                id: string;
                type: string;
                payload: unknown;
                attempts: number;
                maxAttempts: number;
            }>
        >`
            UPDATE "Job"
            SET status = 'PROCESSING', "lockedAt" = NOW(), "updatedAt" = NOW()
            WHERE id IN (
                SELECT id FROM "Job"
                WHERE status = 'PENDING'
                AND type = ${type}
                AND "runAt" <= NOW()
                ORDER BY "runAt" ASC
                LIMIT ${limit}
                FOR UPDATE SKIP LOCKED
            )
            RETURNING id, type, payload, attempts, "maxAttempts"
        `;
    }

    private async claimAndProcessJobs(limit: number): Promise<number> {
        // Use raw query with SKIP LOCKED for safe concurrent job processing.
        // This atomically selects and locks pending jobs that are ready to run.
        const jobs = await prisma.$queryRaw<
            Array<{
                id: string;
                type: string;
                payload: unknown;
                attempts: number;
                maxAttempts: number;
            }>
        >`
            UPDATE "Job"
            SET status = 'PROCESSING', "lockedAt" = NOW(), "updatedAt" = NOW()
            WHERE id IN (
                SELECT id FROM "Job"
                WHERE status = 'PENDING'
                AND "runAt" <= NOW()
                ORDER BY "runAt" ASC
                LIMIT ${limit}
                FOR UPDATE SKIP LOCKED
            )
            RETURNING id, type, payload, attempts, "maxAttempts"
        `;
        this.recordPollSuccess();

        // Process jobs concurrently (each tracked in activeJobs)
        const promises = jobs.map(
            (job: {
                id: string;
                type: string;
                payload: unknown;
                attempts: number;
                maxAttempts: number;
            }) => this.processJob(job),
        );
        await Promise.allSettled(promises);

        return jobs.length;
    }

    private async processJob(job: {
        id: string;
        type: string;
        payload: unknown;
        attempts: number;
        maxAttempts: number;
    }): Promise<void> {
        this.activeJobs.add(job.id);
        this.activeJobsByType.set(job.type, (this.activeJobsByType.get(job.type) ?? 0) + 1);
        this.activeJobStarts.set(job.id, {
            type: job.type,
            startedAt: new Date(),
            timeoutMs: this.jobTimeouts[job.type as JobType] ?? this.defaultTimeoutMs,
        });

        try {
            const handler = this.handlers.get(job.type);

            if (!handler) {
                console.warn(`[Queue Worker] No handler for job type: ${job.type}`);
                await prisma.job.update({
                    where: { id: job.id },
                    data: {
                        status: 'FAILED',
                        error: `No handler registered for job type: ${job.type}`,
                        completedAt: new Date(),
                    },
                });
                return;
            }

            const attempt = job.attempts + 1;
            const timeoutMs = this.jobTimeouts[job.type as JobType] ?? this.defaultTimeoutMs;

            // Build handler context
            const context: JobHandlerContext = {
                jobId: job.id,
                reportProgress: (percent: number) => updateJobProgress(job.id, percent),
            };

            try {
                const result = await this.runWithTimeout(
                    handler(job.payload as Record<string, never>, context),
                    timeoutMs,
                );

                if (result.success) {
                    await prisma.job.update({
                        where: { id: job.id },
                        data: {
                            status: 'COMPLETED',
                            attempts: attempt,
                            progress: 100,
                            completedAt: new Date(),
                            lockedAt: null,
                        },
                    });
                } else {
                    await this.handleFailure(
                        job.id,
                        attempt,
                        job.maxAttempts,
                        result.error ?? 'Unknown error',
                    );
                }
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                await this.handleFailure(job.id, attempt, job.maxAttempts, errorMessage);
            }
        } finally {
            this.activeJobs.delete(job.id);
            this.activeJobStarts.delete(job.id);
            this.lastJobSettledAt = new Date();
            const currentCount = this.activeJobsByType.get(job.type) ?? 1;
            if (currentCount <= 1) {
                this.activeJobsByType.delete(job.type);
            } else {
                this.activeJobsByType.set(job.type, currentCount - 1);
            }
            // If shutting down and no more active jobs, resolve the shutdown promise
            if (this.shuttingDown && this.activeJobs.size === 0 && this.shutdownResolve) {
                this.shutdownResolve();
                this.shutdownResolve = null;
            }
        }
    }

    private async runWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
        let timer: ReturnType<typeof setTimeout>;
        const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
                () => reject(new Error(`Job timed out after ${timeoutMs}ms`)),
                timeoutMs,
            );
        });

        try {
            return await Promise.race([promise, timeout]);
        } finally {
            clearTimeout(timer!);
        }
    }

    private async handleFailure(
        jobId: string,
        attempt: number,
        maxAttempts: number,
        error: string,
    ): Promise<void> {
        if (attempt >= maxAttempts) {
            // Dead letter: job has exhausted all retries
            await prisma.job.update({
                where: { id: jobId },
                data: {
                    status: 'DEAD_LETTER',
                    attempts: attempt,
                    error,
                    completedAt: new Date(),
                    lockedAt: null,
                },
            });
            console.error(
                `[Queue Worker] Job ${jobId} moved to dead letter queue after ${attempt} attempts: ${error}`,
            );
        } else {
            // Schedule retry with exponential backoff
            const backoffMs = calculateBackoff(attempt);
            const runAt = new Date(Date.now() + backoffMs);

            await prisma.job.update({
                where: { id: jobId },
                data: {
                    status: 'PENDING',
                    attempts: attempt,
                    error,
                    runAt,
                    lockedAt: null,
                    progress: null,
                },
            });
            console.warn(
                `[Queue Worker] Job ${jobId} failed (attempt ${attempt}/${maxAttempts}), ` +
                    `retrying at ${runAt.toISOString()}: ${error}`,
            );
        }
    }
}
