import { prisma } from '@copilotkit/outpost/db';
import { BACKOFF_BASE_MS, BACKOFF_MAX_MS, calculateBackoff } from '@copilotkit/outpost/shared';
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
 * Margin added on top of a claim's own deadline before the sweep calls it dead.
 *
 * The normal timeout path has to be given a chance to release its own claim
 * first; without this, a handler that times out at exactly `lockUntil` races the
 * sweep that is about to reclaim it. Also the amount `warnIfLegacyCeilingTooLow`
 * adds to the longest configured timeout when checking the legacy ceiling.
 */
const STALE_RECOVERY_GRACE_MS = 30_000;

/**
 * How long a `PROCESSING` row with no `lockUntil` is left alone.
 *
 * Only reachable for rows a pre-`lockUntil` worker claimed, i.e. during the one
 * deploy that rolls this out. We genuinely do not know what deadline those were
 * granted, so the ceiling is a fixed value set well above the largest configured
 * timeout rather than derived from the observing worker's config — that
 * derivation is exactly the bug `lockUntil` exists to remove, so it must not come
 * back through this door. (At the time of writing the longest are `HUBSPOT_SYNC`
 * and `ACCOUNT_SCORING`, tied at 300s; `warnIfLegacyCeilingTooLow` below is what
 * keeps that honest, so treat the guard rather than this sentence as the source
 * of truth.)
 *
 * Being fixed means it does not follow `jobTimeouts` upward. A timeout raised
 * past this ceiling would make the legacy branch reclaim live claims for the
 * length of one rollout, so the constructor checks the two against each other
 * and says so rather than letting it pass silently.
 */
const LEGACY_RECLAIM_CEILING_MS = 900_000;

/**
 * Report a fenced write.
 *
 * `count === 0` on any of these updates is the event the claim token exists to
 * produce, and it must never be inferred from the absence of a log. The pre-fence
 * code always logged on these paths; suppressing the log when the fence fires
 * would make the interesting case the quiet one.
 *
 * What it proves is narrower than it first looks: the row no longer matches
 * `(id, PROCESSING, claimToken)`. That means the claim was lost — the reclaim
 * sweep took the row — but not necessarily that a second execution has happened.
 * The sweep sets `claimToken = NULL` and may have landed on DEAD_LETTER, in which
 * case nothing will run again. The message says what is known and what is at
 * risk, rather than asserting a concurrent run that may not exist.
 */
function warnIfFenced(
    count: number,
    job: Pick<ClaimedJob, 'id' | 'type' | 'claimToken'>,
    what: string,
): void {
    if (count > 0) return;
    console.warn(
        `[Queue Worker] ${what} write for job ${job.id} (${job.type}) was fenced: ` +
            `claim ${job.claimToken} no longer owns the row, so this claim was ` +
            `reclaimed while still live. The row has since been retried or ` +
            `dead-lettered, and any external side effect of this execution may ` +
            `already have been repeated.`,
    );
}

interface ClaimedJob {
    id: string;
    type: string;
    payload: unknown;
    attempts: number;
    maxAttempts: number;
    claimToken: string;
}

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
    private pollPromise: Promise<void> | null = null;
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
    private stopPromise: Promise<void> | null = null;
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
        this.warnIfLegacyCeilingTooLow();
    }

    /**
     * Say so when a configured timeout outgrows `LEGACY_RECLAIM_CEILING_MS`.
     *
     * The legacy branch only runs against rows claimed before `lockUntil`
     * existed, so this is a one-rollout concern — but during that rollout a
     * timeout above the ceiling means the sweep calls a still-running claim
     * abandoned, and the original execution's completion is then fenced out and
     * discarded. Checked here rather than left to a comment because the ceiling
     * and the timeouts live in different packages, so nothing else would notice
     * them drifting apart. Once every `PROCESSING` row carries a `lockUntil`,
     * the branch is unreachable and this is only advisory.
     */
    private warnIfLegacyCeilingTooLow(): void {
        const configured = Object.values(this.jobTimeouts).filter(
            (ms): ms is number => typeof ms === 'number',
        );
        const longest = Math.max(this.defaultTimeoutMs, ...configured);
        const needed = longest + STALE_RECOVERY_GRACE_MS;
        if (needed <= LEGACY_RECLAIM_CEILING_MS) return;
        console.warn(
            `[Queue Worker] Longest job timeout (${longest}ms) plus the recovery grace ` +
                `(${STALE_RECOVERY_GRACE_MS}ms) exceeds LEGACY_RECLAIM_CEILING_MS ` +
                `(${LEGACY_RECLAIM_CEILING_MS}ms). Rows claimed before "lockUntil" existed ` +
                `can be reclaimed while still running. Raise the ceiling above ${needed}ms.`,
        );
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
        this.stopPromise = null;
        this.upSince = new Date();
        console.log('[Queue Worker] Started');
        this.registerSignalHandlers();
        this.runPoll();
    }

    /**
     * Stop processing jobs gracefully.
     * Waits for all active jobs to complete before resolving.
     */
    async stop(): Promise<void> {
        // Signal handlers and the worker app can both request shutdown. Share
        // the same drain promise so a second caller cannot observe
        // `running=false`, return early, and disconnect Prisma/exit while the
        // first caller is still waiting for active jobs.
        if (this.stopPromise) return this.stopPromise;
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

        this.stopPromise = (async () => {
            // A poll may be between its running check and its atomic claim. Let
            // that cycle finish before deciding whether the active set is
            // drained, otherwise stop() can resolve just before it claims work.
            await this.pollPromise;

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
        })();

        return this.stopPromise;
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

    private runPoll(): void {
        const currentPoll = this.poll();
        this.pollPromise = currentPoll;
        void currentPoll.finally(() => {
            if (this.pollPromise === currentPoll) this.pollPromise = null;
        });
    }

    private schedulePoll(delayMs: number): void {
        if (!this.running) return;
        this.pollTimer = setTimeout(() => this.runPoll(), delayMs);
    }

    private async poll(): Promise<void> {
        if (!this.running) return;

        this.pollStartedAt = new Date();
        try {
            this.lastPollTime = this.pollStartedAt;

            // Ahead of the capacity check, not behind it. Reclaiming is a global
            // sweep over abandoned rows and has nothing to do with this replica's
            // spare capacity, so gating it on free slots would stop recovery
            // exactly when the backlog that produced the abandoned rows is
            // largest. Latent while `availableSlots` can never reach 0 (the poll
            // awaits its whole batch, so `activeJobs` is empty here), and live the
            // moment that changes.
            //
            // Isolated on purpose. It sits ahead of every claim in the same try,
            // and `lastPollTime` is already set, so a failing reclaim would stop
            // all claiming while the process stayed up. Note the health server in
            // `apps/worker/src/index.ts` answers 200 unconditionally and never
            // consults `healthCheck()`, so nothing would have restarted it either —
            // that half is the /health rework's problem, not this catch's.
            // Recovering abandoned work is a nice-to-have; claiming new work is the
            // job.
            try {
                await this.reclaimStaleJobs();
            } catch (error) {
                console.error('[Queue Worker] Reclaim sweep failed, continuing:', error);
            }
            if (!this.running) {
                this.completePoll();
                return;
            }

            const availableSlots = this.maxConcurrency - this.activeJobs.size;

            if (availableSlots <= 0) {
                // At capacity, wait and retry
                this.completePoll();
                this.schedulePoll(this.pollIntervalMs);
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
            this.schedulePoll(nextPollDelay);
        } catch (error) {
            console.error('[Queue Worker] Poll error:', error);
            this.consecutivePollFailures++;
            this.pollFailingSince ??= new Date();
            this.completePoll();
            this.schedulePoll(this.pollIntervalMs);
        }
    }

    /**
     * Mark the in-flight poll finished. Called on every exit path out of poll()
     * — including the error path, because a poll that threw has still stopped
     * running, and leaving pollStartedAt set would report a dead loop as busy
     * forever.
     */
    private completePoll(): void {
        this.pollStartedAt = null;
        this.lastPollCompletedAt = new Date();
    }

    /** The database answered a claim, so any open failure window is closed. */
    private recordPollSuccess(): void {
        this.pollFailingSince = null;
        this.consecutivePollFailures = 0;
    }

    /**
     * Return abandoned PROCESSING jobs to the pending queue before claiming work.
     *
     * `lockUntil` is written with the database clock at claim time, so the stale
     * comparison also uses the database clock, and it is the *claiming* worker's
     * deadline rather than a window re-derived here. A recovery grace is still
     * added on top: the normal timeout path must have time to release its own
     * claim before another worker calls it crash-abandoned. A true abandonment
     * consumes an attempt, clears its claim token, and moves toward DEAD_LETTER
     * like every other failed execution — spaced by the same backoff.
     *
     * Deliberately not filtered to types this worker registers. `lockUntil` makes
     * the row self-describing, so there is no longer anything a worker needs to
     * know about a type in order to tell that its claim has expired — and the old
     * type predicate meant a crashed claim of a type this replica does not handle
     * stayed PROCESSING forever, never reclaimed and never dead-lettered.
     *
     * The deadline test is a disjunction rather than a `CASE` over `lockUntil`,
     * because a `CASE` over the column is not sargable: the planner would take the
     * `status` prefix of `Job_status_lockUntil_idx` and then filter every
     * `PROCESSING` row. In the first arm `lockUntil` is kept bare with the interval
     * arithmetic on the right, which is what lets the index's second column do any
     * work at all.
     *
     * The legacy arm cannot use the index the same way — it discriminates on
     * `lockedAt`, which is not in it — so it rides the `status` + `lockUntil IS
     * NULL` prefix and filters. That is fine: the arm is dead after one rollout.
     */
    private async reclaimStaleJobs(): Promise<void> {
        // `runAt` mirrors `calculateBackoff` in shared/utils.ts — base * 2^attempt
        // plus jitter under a ceiling — because a reclaim and a handler failure
        // both mean "this attempt did not finish, try again later" and must space
        // retries the same way. Setting NOW() here let a crash-looping worker burn
        // every attempt on a job back to back and drive it to DEAD_LETTER at full
        // speed. The attempt number is the one being scheduled, `attempts + 1`,
        // matching `handleFailure`.
        const reclaimed = await prisma.$executeRaw`
            UPDATE "Job" AS job
            SET status = CASE
                    WHEN job."attempts" + 1 >= job."maxAttempts"
                    THEN 'DEAD_LETTER'::"JobStatus"
                    ELSE 'PENDING'::"JobStatus"
                END,
                "attempts" = job."attempts" + 1,
                "lockedAt" = NULL,
                "lockUntil" = NULL,
                "claimToken" = NULL,
                progress = NULL,
                error = 'Worker claim was abandoned before completion'
                    || COALESCE(' (previous error: ' || left(job.error, 200) || ')', ''),
                "completedAt" = CASE
                    WHEN job."attempts" + 1 >= job."maxAttempts" THEN NOW()
                    ELSE NULL
                END,
                "runAt" = CASE
                    WHEN job."attempts" + 1 >= job."maxAttempts" THEN job."runAt"
                    ELSE NOW() + (
                        LEAST(
                            ${BACKOFF_BASE_MS} * POWER(2, LEAST(job."attempts" + 1, 30))
                                + random() * ${BACKOFF_BASE_MS},
                            ${BACKOFF_MAX_MS}
                        ) * INTERVAL '1 millisecond'
                    )
                END,
                "updatedAt" = NOW()
            WHERE job.status = 'PROCESSING'
            AND (
                (
                    job."lockUntil" IS NOT NULL
                    AND job."lockUntil"
                        < NOW() - (${STALE_RECOVERY_GRACE_MS} * INTERVAL '1 millisecond')
                )
                OR (
                    job."lockUntil" IS NULL
                    AND job."lockedAt"
                        < NOW() - (${LEGACY_RECLAIM_CEILING_MS} * INTERVAL '1 millisecond')
                )
                OR (
                    job."lockUntil" IS NULL
                    AND job."lockedAt" IS NULL
                    AND job."updatedAt"
                        < NOW() - (${LEGACY_RECLAIM_CEILING_MS} * INTERVAL '1 millisecond')
                )
            )
        `;

        // Every row this moved is a claim some worker took and never released —
        // a crash, an OOM kill, an evicted container. It is the earliest signal
        // that replicas are dying, and it was being computed once per poll and
        // thrown away. Only spoken when non-zero: the healthy case is silence.
        if (reclaimed > 0) {
            console.warn(
                `[Queue Worker] Reclaim sweep returned ${reclaimed} abandoned ` +
                    `PROCESSING job(s) to the queue. Each is a claim a worker took ` +
                    `and never released — check for crashed or OOM-killed replicas.`,
            );
        }
    }

    /**
     * This worker's per-type claim durations, as a jsonb object for the claim SQL.
     *
     * Written onto the row at claim time so the deadline belongs to the execution
     * that owns the claim. Deriving it at reclaim time from the *observing*
     * worker's config meant a replica on an older revision — one without an entry
     * for a long-running type, so falling back to `defaultTimeoutMs` — would
     * reclaim a claim that was still live, and the original handler's eventual
     * success would then be fenced out and silently discarded while the job ran
     * a second time.
     */
    private timeoutMapJson(): string {
        return JSON.stringify(this.jobTimeouts);
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
                await this.processClaimedJobs(jobs);
                totalProcessed += jobs.length;
                remainingGlobalSlots -= jobs.length;
            }
        }

        return totalProcessed;
    }

    /**
     * Claim pending jobs of a specific type using SKIP LOCKED.
     */
    private async claimJobsForType(type: string, limit: number): Promise<Array<ClaimedJob>> {
        return prisma.$queryRaw<Array<ClaimedJob>>`
            UPDATE "Job"
            SET status = 'PROCESSING', "lockedAt" = NOW(),
                "lockUntil" = NOW() + (
                    COALESCE(
                        (${this.timeoutMapJson()}::jsonb ->> "Job".type)::double precision,
                        ${this.defaultTimeoutMs}
                    ) * INTERVAL '1 millisecond'
                ),
                "claimToken" = gen_random_uuid()::text, "updatedAt" = NOW()
            WHERE id IN (
                SELECT id FROM "Job"
                WHERE status = 'PENDING'
                AND type = ${type}
                AND "runAt" <= NOW()
                ORDER BY "runAt" ASC
                LIMIT ${limit}
                FOR UPDATE SKIP LOCKED
            )
            RETURNING id, type, payload, attempts, "maxAttempts", "claimToken"
        `;
    }

    private async claimAndProcessJobs(limit: number): Promise<number> {
        // Use raw query with SKIP LOCKED for safe concurrent job processing.
        // This atomically selects and locks pending jobs that are ready to run.
        const jobs = await prisma.$queryRaw<Array<ClaimedJob>>`
            UPDATE "Job"
            SET status = 'PROCESSING', "lockedAt" = NOW(),
                "lockUntil" = NOW() + (
                    COALESCE(
                        (${this.timeoutMapJson()}::jsonb ->> "Job".type)::double precision,
                        ${this.defaultTimeoutMs}
                    ) * INTERVAL '1 millisecond'
                ),
                "claimToken" = gen_random_uuid()::text, "updatedAt" = NOW()
            WHERE id IN (
                SELECT id FROM "Job"
                WHERE status = 'PENDING'
                AND "runAt" <= NOW()
                ORDER BY "runAt" ASC
                LIMIT ${limit}
                FOR UPDATE SKIP LOCKED
            )
            RETURNING id, type, payload, attempts, "maxAttempts", "claimToken"
        `;
        this.recordPollSuccess();

        await this.processClaimedJobs(jobs);

        return jobs.length;
    }

    /**
     * Run a claimed batch concurrently, and say something when one of them dies.
     *
     * `processJob` has a `finally` but no `catch`, so anything thrown outside its
     * inner try — a Prisma error on the no-handler tombstone, on the dead-letter
     * write, on the retry write — propagates out. `Promise.allSettled` then
     * absorbs it and returns a result object nobody was reading, so a database
     * blip could take out the whole failure-recording path and produce no output
     * at all: not the Prisma error, and not the handler failure it was recording.
     * The row survives (it stays PROCESSING for the sweep); the explanation did not.
     */
    private async processClaimedJobs(jobs: ClaimedJob[]): Promise<void> {
        const settled = await Promise.allSettled(jobs.map((job) => this.processJob(job)));
        settled.forEach((outcome, i) => {
            if (outcome.status !== 'rejected') return;
            const job = jobs[i];
            console.error(
                `[Queue Worker] processJob threw for job ${job.id} (${job.type}). ` +
                    `The row is left PROCESSING for the reclaim sweep:`,
                outcome.reason,
            );
        });
    }

    private async processJob(job: ClaimedJob): Promise<void> {
        // `ClaimedJob.claimToken` is typed `string`, but it arrives from
        // `$queryRaw`, which validates nothing — the type is an assertion about a
        // column the schema declares nullable. That matters more than it reads:
        // Prisma's `updateMany` silently DROPS a `where` key whose value is
        // `undefined`, so a token that ever went missing would turn every fenced
        // write below into an unfenced update-by-id, and the exactly-once
        // mechanism would disappear with no error and no log. Refuse the row
        // instead. It stays PROCESSING with its `lockUntil` intact, so the sweep
        // recovers it on the normal deadline rather than it being lost.
        if (!job.claimToken) {
            console.error(
                `[Queue Worker] Refusing job ${job.id} (${job.type}): the claim ` +
                    `returned no token, so its writes could not be fenced. Leaving ` +
                    `the row for the reclaim sweep. This is a bug in the claim query.`,
            );
            return;
        }

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
                const tombstone = await prisma.job.updateMany({
                    where: {
                        id: job.id,
                        status: 'PROCESSING',
                        claimToken: job.claimToken,
                    },
                    data: {
                        status: 'FAILED',
                        // Every other terminal path records the attempt it used.
                        // Without this the row reads `attempts: 0` for a job that
                        // was claimed and dispatched.
                        attempts: job.attempts + 1,
                        error: `No handler registered for job type: ${job.type}`,
                        completedAt: new Date(),
                        lockedAt: null,
                        lockUntil: null,
                        claimToken: null,
                    },
                });
                warnIfFenced(tombstone.count, job, 'no-handler failure');
                return;
            }

            const attempt = job.attempts + 1;
            const timeoutMs = this.jobTimeouts[job.type as JobType] ?? this.defaultTimeoutMs;

            // Build handler context
            const context: JobHandlerContext = {
                jobId: job.id,
                reportProgress: (percent: number) =>
                    updateJobProgress(job.id, percent, job.claimToken),
            };

            // The handler's own try. Only what the handler does belongs in here:
            // a throw from the bookkeeping below is a different kind of event and
            // must not be laundered into "the job failed".
            let result: JobResult;
            try {
                result = await this.runWithTimeout(
                    handler(job.payload as Record<string, never>, context),
                    timeoutMs,
                );
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                await this.handleFailure(
                    job.id,
                    job.type,
                    job.claimToken,
                    attempt,
                    job.maxAttempts,
                    errorMessage,
                );
                return;
            }

            if (!result.success) {
                // A handler that reports `retryable: false` has told us the
                // failure cannot succeed on a retry (malformed payload, missing
                // referenced row, permanent API rejection). Retrying it burns
                // every attempt and leaves a dead-letter trail that reads like a
                // transient fault.
                await this.handleFailure(
                    job.id,
                    job.type,
                    job.claimToken,
                    attempt,
                    job.maxAttempts,
                    result.error ?? 'Unknown error',
                    result.retryable === false,
                );
                return;
            }

            // The work succeeded and its side effects have already happened. A
            // throw from here is the database failing to record that, which is
            // emphatically not a job failure: routing it through `handleFailure`
            // set the row back to PENDING carrying a Prisma error as the job's
            // error, and the retry re-ran every one of those side effects. So the
            // row is left PROCESSING for the sweep instead — still a re-run, but
            // one that is logged as what it is rather than recorded as a fault in
            // the handler.
            try {
                const completion = await prisma.job.updateMany({
                    where: {
                        id: job.id,
                        status: 'PROCESSING',
                        claimToken: job.claimToken,
                    },
                    data: {
                        status: 'COMPLETED',
                        attempts: attempt,
                        progress: 100,
                        completedAt: new Date(),
                        lockedAt: null,
                        lockUntil: null,
                        claimToken: null,
                    },
                });
                // The single most important thing this fence can tell us: the work
                // finished, and the row no longer accepts this claim. It was
                // reclaimed while still live, so this success is being discarded
                // and the row has been re-queued or dead-lettered. Whether the side
                // effects actually ran twice depends on which of those happened,
                // which is why the message says "may".
                warnIfFenced(completion.count, job, 'completion');
            } catch (error) {
                console.error(
                    `[Queue Worker] Job ${job.id} (${job.type}) succeeded but its ` +
                        `COMPLETED write failed. The row stays PROCESSING and the ` +
                        `reclaim sweep will re-queue it, which WILL run the handler ` +
                        `again and repeat its side effects:`,
                    error,
                );
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
        jobType: string,
        claimToken: string,
        attempt: number,
        maxAttempts: number,
        error: string,
        /**
         * The handler declared this failure permanent. Dead-letter it now, but
         * record the TRUE attempt count — writing `maxAttempts` here would
         * fabricate an exhausted-retry trail for a job that ran once, and an
         * operator requeueing it could not tell the two cases apart.
         */
        permanent = false,
    ): Promise<void> {
        if (permanent || attempt >= maxAttempts) {
            // Dead letter: job has exhausted all retries
            const result = await prisma.job.updateMany({
                where: { id: jobId, status: 'PROCESSING', claimToken },
                data: {
                    status: 'DEAD_LETTER',
                    attempts: attempt,
                    error,
                    completedAt: new Date(),
                    lockedAt: null,
                    lockUntil: null,
                    claimToken: null,
                },
            });
            if (result.count > 0) {
                console.error(
                    `[Queue Worker] Job ${jobId} (${jobType}) moved to dead letter queue ` +
                        `after ${attempt} attempt(s)` +
                        `${permanent ? ' (handler reported the failure as permanent)' : ''}: ${error}`,
                );
            } else {
                // Pre-fence this always logged. Staying silent here would lose both
                // the fence rejection and the failure that caused it.
                console.warn(
                    `[Queue Worker] Job ${jobId} (${jobType}) dead-letter write was fenced ` +
                        `(claim ${claimToken} no longer owns the row); ` +
                        `the failure it was recording was: ${error}`,
                );
            }
        } else {
            // Schedule retry with exponential backoff
            const backoffMs = calculateBackoff(attempt);
            const runAt = new Date(Date.now() + backoffMs);

            const result = await prisma.job.updateMany({
                where: { id: jobId, status: 'PROCESSING', claimToken },
                data: {
                    status: 'PENDING',
                    attempts: attempt,
                    error,
                    runAt,
                    lockedAt: null,
                    lockUntil: null,
                    claimToken: null,
                    progress: null,
                },
            });
            if (result.count > 0) {
                console.warn(
                    `[Queue Worker] Job ${jobId} (${jobType}) failed (attempt ${attempt}/${maxAttempts}), ` +
                        `retrying at ${runAt.toISOString()}: ${error}`,
                );
            } else {
                console.warn(
                    `[Queue Worker] Job ${jobId} (${jobType}) retry write was fenced ` +
                        `(claim ${claimToken} no longer owns the row); ` +
                        `the failure it was recording was: ${error}`,
                );
            }
        }
    }
}
