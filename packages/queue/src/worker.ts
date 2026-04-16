import { prisma } from '@outpost/db';
import { calculateBackoff } from '@outpost/shared';
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
 * - Configurable concurrency
 * - Health check endpoint
 */
export class Worker {
    private handlers = new Map<string, JobHandler<JobType>>();
    private running = false;
    private shuttingDown = false;
    private pollIntervalMs: number;
    private batchSize: number;
    private maxConcurrency: number;
    private jobTimeouts: Partial<Record<JobType, number>>;
    private defaultTimeoutMs: number;
    private pollTimer: ReturnType<typeof setTimeout> | null = null;
    private activeJobs = new Set<string>();
    private lastPollTime: Date | null = null;
    private upSince: Date | null = null;
    private shutdownResolve: (() => void) | null = null;
    private signalHandlers: { signal: string; handler: () => void }[] = [];

    constructor(options?: WorkerOptions) {
        this.pollIntervalMs = options?.pollIntervalMs ?? 1000;
        this.batchSize = options?.batchSize ?? 10;
        this.maxConcurrency = options?.maxConcurrency ?? 5;
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

        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }

        this.removeSignalHandlers();

        // Wait for active jobs to finish
        if (this.activeJobs.size > 0) {
            console.log(`[Queue Worker] Waiting for ${this.activeJobs.size} active jobs to complete...`);
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
            lastPollTime: this.lastPollTime,
            registeredHandlers: Array.from(this.handlers.keys()),
            upSince: this.upSince,
        };
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

        try {
            this.lastPollTime = new Date();
            const availableSlots = this.maxConcurrency - this.activeJobs.size;

            if (availableSlots <= 0) {
                // At capacity, wait and retry
                this.pollTimer = setTimeout(() => this.poll(), this.pollIntervalMs);
                return;
            }

            const processedCount = await this.claimAndProcessJobs(
                Math.min(availableSlots, this.batchSize),
            );

            // If we processed jobs, poll immediately for more
            const nextPollDelay = processedCount > 0 ? 0 : this.pollIntervalMs;
            this.pollTimer = setTimeout(() => this.poll(), nextPollDelay);
        } catch (error) {
            console.error('[Queue Worker] Poll error:', error);
            this.pollTimer = setTimeout(() => this.poll(), this.pollIntervalMs);
        }
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

        // Process jobs concurrently (each tracked in activeJobs)
        const promises = jobs.map((job: { id: string; type: string; payload: unknown; attempts: number; maxAttempts: number }) => this.processJob(job));
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
                    await this.handleFailure(job.id, attempt, job.maxAttempts, result.error ?? 'Unknown error');
                }
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                await this.handleFailure(job.id, attempt, job.maxAttempts, errorMessage);
            }
        } finally {
            this.activeJobs.delete(job.id);
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
            timer = setTimeout(() => reject(new Error(`Job timed out after ${timeoutMs}ms`)), timeoutMs);
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
