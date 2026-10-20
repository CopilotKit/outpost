/**
 * Boot state, health payload construction, and port resolution — split out from
 * index.ts so they are testable.
 *
 * index.ts is a top-level-await module with side effects on import (it binds a
 * port and starts polling), so its boot behaviour cannot be exercised directly
 * from a test. Everything here is pure and pinned by tests: an unbooted, failed,
 * stopped or stalled worker must report 503 WITH a reason, and only a worker
 * that is actually polling reports 200.
 */

import type { WorkerHealthStatus } from '@copilotkit/outpost/queue';

/**
 * Discriminated so the failed-without-a-reason state is unrepresentable. A 503
 * carrying `error: null` is the exact signal-quality bug this module exists to
 * remove; making it a type error is cheaper than remembering to assign `error`
 * before `phase` on every future edit.
 */
export type BootState =
    | { phase: 'starting' }
    | { phase: 'ready' }
    | { phase: 'failed'; error: string }
    // Booted, then died. Kept distinct from 'failed' because the operator advice
    // differs completely: a failed boot means the database does not match
    // schema.prisma, while a crash after boot means a handler threw. Reporting
    // the latter as the former sends whoever is paged to audit migrations for a
    // bug in an AI handler.
    | { phase: 'crashed'; error: string };

export interface HealthResponse {
    statusCode: number;
    body: Record<string, unknown>;
}

/**
 * Misconfiguration notices to publish alongside the health verdict.
 *
 * A rejected PORT or a rejected duration is logged once at boot and then never
 * mentioned again, which puts it exactly where this module exists to stop
 * putting things: a container log nobody has reason to suspect. The watchdog case
 * is the sharpest — it prints at boot but only bites at the next deploy, weeks
 * later. A degraded-but-serving worker should be able to say so on the probe.
 */
function configWarnings(warnings: readonly string[]): Record<string, unknown> {
    return warnings.length > 0 ? { configWarnings: warnings } : {};
}

/**
 * Prisma error codes whose failure names a schema object rather than a
 * connection. P2021 is a missing table, P2022 a missing column — the drift class
 * this endpoint exists to surface. Only the object name is echoed, never the
 * message (see summarizeBootError).
 */
const SAFE_TO_ECHO_CODES = new Set(['P2021', 'P2022']);

/**
 * How long the poll loop may be idle between polls before it is wedged.
 *
 * This bounds the gap BETWEEN polls, never the duration of one. Worker.poll()
 * reschedules every 1s when idle, so a minute of silence with no poll running
 * means the loop is dead.
 *
 * The earlier version of this module compared `now - lastPollTime` against this
 * bound, which was wrong in the dangerous direction: poll() stamps lastPollTime
 * and then awaits Promise.allSettled over every job it claimed, and jobTimeouts
 * allow a single job 300s. So any long job froze the stamp well past 60s and the
 * probe reported a HEALTHY worker as stalled — with the container healthcheck
 * killing it mid-job after 90s. "Busy" and "wedged" have to be different
 * questions, which is why WorkerHealthStatus now carries pollStartedAt.
 */
export const STALE_POLL_MS = 60_000;

/**
 * How long a poll may run with NOTHING in flight before it is wedged.
 *
 * A poll with zero active jobs is doing one thing: claiming. That is a bounded
 * query, so a poll that has not returned in a minute with no job to blame is
 * blocked on the database rather than working.
 *
 * Deliberately NOT a bound on poll duration in general. claimJobsByType awaits
 * each type's batch sequentially, so one poll can legitimately run the sum of
 * every registered type's timeout — 930s against the real worker config. An
 * earlier version of this module bounded the whole poll at
 * `max(jobTimeouts) + 60s` = 360s and reported a healthy worker stalled, which
 * is what got the previous attempt at this endpoint reverted. Whether the jobs
 * themselves are overdue is the worker's own question to answer, and it answers
 * it per job in `overdueJobCount`.
 */
export const CLAIM_STALL_MS = 60_000;

/** Upper bound on any reason string served to an unauthenticated probe. */
const MAX_REASON_LENGTH = 200;

/** Whether this value carries a Prisma error code we can act on. */
function hasPrismaCode(error: unknown): boolean {
    const raw = (error ?? {}) as { code?: unknown; errorCode?: unknown };
    return typeof raw.code === 'string' || typeof raw.errorCode === 'string';
}

function messageOf(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (
        typeof error === 'object' &&
        error !== null &&
        typeof (error as { message?: unknown }).message === 'string'
    ) {
        return (error as { message: string }).message;
    }
    return String(error);
}

/**
 * Reduce a boot exception to a reason that can be served on /health.
 *
 * /health is unauthenticated. Prisma's connectivity errors quote the database
 * host, port and user (P1001 names host:port, P1000 names the user), and even
 * the "safe" schema errors arrive as a multi-line blob whose preamble carries
 * an absolute container path and a source code frame:
 *
 *     Invalid `prisma.systemConfig.findUnique()` invocation in
 *     /app/packages/outpost/shared/dist/sync/config.js:34:56
 *       31 const existing = await db.systemConfig.findUnique({
 *     The table `public.SystemConfig` does not exist in the current database.
 *
 * So nothing is echoed verbatim. For the schema codes the backticked object name
 * is lifted out of the final line — that name is the entire diagnostic payload —
 * and everything else degrades to error class plus code, with the full text left
 * to the logs.
 */
export function summarizeBootError(error: unknown): string {
    // Loaders wrap Prisma failures (`failed to load status map: <prisma message>`),
    // which strands the code on the cause and would otherwise degrade the whole
    // diagnosis to a bare "Error". The missing-table name IS the payload here.
    const cause = (error as { cause?: unknown } | null)?.cause;
    if (cause !== undefined && cause !== null && !hasPrismaCode(error) && hasPrismaCode(cause)) {
        return summarizeBootError(cause);
    }

    const raw = (error ?? {}) as { code?: unknown; errorCode?: unknown };
    // PrismaClientKnownRequestError carries `code`; PrismaClientInitializationError
    // carries `errorCode` (frequently undefined, hence the class-name fallback).
    const code =
        typeof raw.code === 'string'
            ? raw.code
            : typeof raw.errorCode === 'string'
              ? raw.errorCode
              : null;

    if (code && SAFE_TO_ECHO_CODES.has(code)) {
        // Matched against the diagnostic sentence itself rather than "the last
        // non-empty line". Prisma does not guarantee the sentence comes last, and
        // when a code frame does, `([^`]+)` lifts a backticked token straight
        // out of source — publishing whatever happens to be quoted in that line
        // to an unauthenticated probe.
        // Scoped to the diagnostic sentence. Matching the whole blob returns the
        // FIRST backticked token, which on a message carrying a code frame is a
        // source token rather than the object name — published verbatim to an
        // unauthenticated probe.
        const sentence = messageOf(error)
            .split('\n')
            .find((line) => /does not exist/i.test(line));
        const object = sentence
            ? /(?:table|column|model)\s+`([^`]+)`/i.exec(sentence)?.[1]
            : undefined;
        if (object) {
            return truncate(
                `${code}: missing database object \`${object}\` — the database does not match schema.prisma`,
            );
        }
    }

    // Class name and code only. Both are stable, neither quotes the connection.
    const label = [error instanceof Error ? error.name : 'Error', code].filter(Boolean).join(' ');
    return truncate(`${label} — see the worker logs for the full error`);
}

function truncate(reason: string): string {
    return reason.length <= MAX_REASON_LENGTH
        ? reason
        : `${reason.slice(0, MAX_REASON_LENGTH - 1)}…`;
}

/**
 * Resolve the health-server port from the environment.
 *
 * `??` is not enough: an empty or non-numeric PORT (a cleared platform variable,
 * or a reference variable that failed to resolve) parses to NaN, and
 * `server.listen(NaN)` throws ERR_SOCKET_BAD_PORT synchronously at module scope
 * — killing the process before anything binds, which is precisely the opaque
 * "replicas never became healthy" failure this whole module exists to prevent.
 * An invalid value falls back to the default and says so.
 */
export function resolvePort(
    env: { PORT?: string; HEALTH_PORT?: string },
    fallback = 3003,
): { port: number; source: string; warning: string | null; fatal: boolean } {
    const candidates: Array<[string, string | undefined]> = [
        ['PORT', env.PORT],
        ['HEALTH_PORT', env.HEALTH_PORT],
    ];

    for (const [source, raw] of candidates) {
        if (raw === undefined || raw.trim() === '') continue;

        // Validated against the RAW value, not a trimmed one. The container
        // healthcheck probes `${PORT:-...}` verbatim, so `PORT=" 3000"` makes
        // wget request `http://127.0.0.1: 3000/health` — an invalid URL that
        // fails every time — while this process binds 3000 and answers 200 to
        // anything that reaches it. Trimming here would make the one input class
        // that actually produces that failure non-fatal.
        const trimmed = raw;
        // Number.parseInt is lenient in a way that matters here: it reads a
        // numeric PREFIX, so "3003abc" becomes 3003, "80.9" becomes 80 and "1e4"
        // becomes 1 — each a silent bind to a port the operator did not ask for.
        const numeric = /^\d+$/.test(trimmed);
        const parsed = numeric ? Number(trimmed) : Number.NaN;

        // 0 is the trap worth naming: server.listen(0) is valid and binds an
        // OS-assigned ephemeral port, so the server comes up somewhere nothing
        // probes and logs a confident "listening on port 0".
        if (numeric && parsed >= 1 && parsed <= 65535) {
            return { port: parsed, source, warning: null, fatal: false };
        }

        // Falling back would be worse than failing. The container healthcheck in
        // apps/worker/Dockerfile probes ${PORT:-${HEALTH_PORT:-3003}}, and
        // shell :- substitutes only for unset or EMPTY — so PORT="abc" leaves
        // wget asking for http://127.0.0.1:abc/health while this process serves
        // happily on 3003. The probe can never succeed, the container dies in
        // ~90s, and /health answered 200 the whole way: the opaque "replicas
        // never became healthy" signal this module exists to delete. A wrong
        // port is unreportable over that port by construction, so it is fatal
        // for the same reason EADDRINUSE is.
        return {
            port: fallback,
            source: 'default',
            warning: `invalid ${source}="${raw}" (expected an integer 1-65535)`,
            fatal: true,
        };
    }

    return { port: fallback, source: 'default', warning: null, fatal: false };
}

/**
 * Largest delay setTimeout accepts. Anything above it is clamped to 1ms, so an
 * operator reaching for "effectively never" gets the opposite: a watchdog that
 * fires immediately and forces exit(1) on every SIGTERM mid-drain, or a
 * boot-failure linger window that ends before it publishes its reason. The
 * lower bound alone does not catch it.
 */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Resolve a millisecond duration from the environment.
 *
 * `Number(process.env.X ?? default)` is the trap this replaces, and it fails in
 * the worst possible direction: a platform variable that exists but is empty
 * defeats `??` (which only guards undefined and null), and `Number('')` is 0 —
 * not NaN. So a cleared SHUTDOWN_WATCHDOG_MS silently became a 0ms watchdog that
 * fires immediately, forcing exit(1) on every SIGTERM mid-drain, and a cleared
 * BOOT_FAILURE_LINGER_MS disabled the linger window that is the whole point of
 * staying up to explain a failed boot. Both were written one file away from a
 * docblock explaining why `??` is insufficient for exactly this.
 *
 * Anything unusable falls back to the default and says so, rather than being
 * silently coerced into a number that happens to parse.
 */
export function resolveDurationMs(
    raw: string | undefined,
    name: string,
    fallback: number,
): { ms: number; warning: string | null } {
    if (raw === undefined || raw.trim() === '') return { ms: fallback, warning: null };

    // Digits only, for the reason resolvePort gives twelve lines up: `Number()`
    // accepts hex and exponent forms, so `SHUTDOWN_WATCHDOG_MS=0x10` is a 16ms
    // watchdog that forces exit(1) on every SIGTERM mid-drain, and `3e2` is
    // 300ms. Same coercion-leniency class as the `Number('') === 0` trap this
    // function was written to close.
    const parsed = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_TIMER_MS) {
        return {
            ms: fallback,
            warning: `invalid ${name}="${raw}" (expected 1-${MAX_TIMER_MS} ms), falling back to ${fallback}`,
        };
    }

    return { ms: parsed, warning: null };
}

/**
 * Decide what a post-boot fatal error should do to the published state.
 *
 * Extracted from index.ts's last-resort handlers because both halves are
 * load-bearing and neither is reachable from a test inside a top-level-await
 * module with import-time side effects.
 *
 * `null` for `next` means leave the state alone: a boot that already failed owns
 * its own exit timer (BOOT_FAILURE_LINGER_MS), and overwriting the reason — or
 * scheduling a second, shorter exit — would cut the window that publishes it
 * from 120s to 5s. A failed boot is a likely source of follow-on rejections, so
 * this is the common case, not a corner.
 */
export function classifyFatalError(
    kind: string,
    error: unknown,
    current: BootState,
): { next: BootState | null; shouldExit: boolean } {
    if (current.phase === 'failed') return { next: null, shouldExit: false };

    // 'crashed', not 'failed'. The failed-boot advice points at schema.prisma and
    // the drift guard, so filing a handler's stray rejection under it sends
    // whoever is paged to audit migrations for a bug in an AI handler.
    return {
        next: { phase: 'crashed', error: `${kind}: ${summarizeBootError(error)}` },
        shouldExit: true,
    };
}

/**
 * Build the /health response.
 *
 * `workerHealth` is the worker's own snapshot, or null when the worker has not
 * been constructed. It is passed rather than read so this stays pure.
 *
 * Every non-200 answer carries a reason. The value added over simply exiting is
 * that body: a probe alone explains the failure. Exiting before binding the port
 * is what made a missing SystemConfig table look identical to a broken image for
 * nine days.
 *
 * 200 requires the worker to be *polling*, not merely constructed. Worker.stop()
 * sets running=false without exiting the process, and a poll loop that has
 * stopped rescheduling itself leaves a worker that processes nothing while
 * looking alive — the honesty gap tracked by #138.
 *
 * The inverse matters just as much: a worker grinding through a 300s job is
 * healthy, and saying otherwise gets it killed mid-job. So a running poll answers
 * 200 "busy" until it overruns what the worker's own job timeouts can account
 * for, and only the gap between polls is measured against STALE_POLL_MS.
 */
export function buildHealthResponse(
    boot: BootState,
    workerHealth: WorkerHealthStatus | null,
    now: number = Date.now(),
    warnings: readonly string[] = [],
): HealthResponse {
    if (boot.phase === 'failed') {
        return {
            statusCode: 503,
            body: { status: 'failed', error: boot.error, ...configWarnings(warnings) },
        };
    }

    if (boot.phase === 'crashed') {
        return {
            statusCode: 503,
            body: { status: 'crashed', error: boot.error, ...configWarnings(warnings) },
        };
    }

    if (boot.phase === 'starting') {
        return {
            statusCode: 503,
            body: {
                status: 'starting',
                error: 'boot has not finished',
                ...configWarnings(warnings),
            },
        };
    }

    if (!workerHealth) {
        return {
            statusCode: 503,
            body: {
                status: 'no-worker',
                error: 'boot reported ready but no worker was constructed — this is a bug in the boot sequence, not a database problem',
                ...configWarnings(warnings),
            },
        };
    }

    if (!workerHealth.running) {
        return {
            statusCode: 503,
            body: {
                ...workerHealth,
                status: 'stopped',
                error: 'worker is not running — it was stopped without the process exiting',
                ...configWarnings(warnings),
            },
        };
    }

    // A job that has outlived its OWN timeout means the timeout machinery failed
    // — the handler is orphaned, or the untimed status write after it is hanging
    // and the job's `finally` never ran. Either way the worker is not making
    // progress, and it can look maximally busy while doing so: with every slot
    // held, poll() returns instantly at capacity and keeps refreshing its
    // completion stamp once a second.
    //
    // Checked before the in-flight branch, because this is exactly the state
    // that would otherwise answer 200 "busy" indefinitely.
    if (workerHealth.overdueJobCount > 0) {
        return {
            statusCode: 503,
            body: {
                ...workerHealth,
                status: 'stalled',
                ...configWarnings(warnings),
                error: `${workerHealth.overdueJobCount} in-flight job(s) have outlived their own timeout — the worker is holding slots for work that is not progressing`,
            },
        };
    }

    // Running, and every poll is throwing. Checked here with the overdue branch
    // because both answer the same question — the worker is up and doing no work
    // — and because every timing signal below looks perfect in this state: the
    // error path stamps `lastPollCompletedAt` exactly as success does.
    //
    // A window, not a count: a Postgres failover produces a burst of failures and
    // then recovers, and flapping the probe through that is worse than waiting.
    if (workerHealth.pollFailingSince) {
        const failingFor = now - workerHealth.pollFailingSince.getTime();
        if (failingFor > STALE_POLL_MS) {
            return {
                statusCode: 503,
                body: {
                    ...workerHealth,
                    status: 'stalled',
                    ...configWarnings(warnings),
                    error: `every poll has failed for ${failingFor}ms (${workerHealth.consecutivePollFailures} in a row) — the worker is running but claiming nothing; see the worker logs for the underlying error`,
                },
            };
        }
    }

    if (workerHealth.pollStartedAt) {
        // Nothing claimed and still not back: the claim query itself is blocked.
        // With jobs in flight the duration says nothing, since a poll waits out
        // every type's batch in turn.
        // Measured from the later of "this poll started" and "a job last
        // settled", NOT from the start of the poll. claimJobsByType awaits each
        // type's batch sequentially, so after a 118s batch of AI_RESPONSE jobs
        // finishes, the nine remaining claim queries each run with
        // activeJobCount === 0 and a pollDuration already carrying those 118s.
        // Bounding the whole poll reported a healthy worker as stalled — the
        // same mistake that got the previous two attempts reverted, moved rather
        // than removed.
        const claimingSince = Math.max(
            workerHealth.pollStartedAt.getTime(),
            workerHealth.lastJobSettledAt?.getTime() ?? 0,
        );
        const claimingFor = now - claimingSince;
        if (workerHealth.activeJobCount === 0 && claimingFor > CLAIM_STALL_MS) {
            return {
                statusCode: 503,
                body: {
                    ...workerHealth,
                    status: 'stalled',
                    ...configWarnings(warnings),
                    error: `no job has been in flight for ${claimingFor}ms of this poll — it is blocked claiming, most likely on a hung database call`,
                },
            };
        }

        return {
            statusCode: 200,
            body: { ...workerHealth, status: 'busy', ...configWarnings(warnings) },
        };
    }

    // No poll in flight, so the gap since the last one finished is the honest
    // measure of whether the loop is still turning.
    const reference = workerHealth.lastPollCompletedAt ?? workerHealth.lastPollTime;
    const sincePoll = reference ? now - reference.getTime() : null;
    if (sincePoll === null || sincePoll > STALE_POLL_MS) {
        return {
            statusCode: 503,
            body: {
                ...workerHealth,
                status: 'stalled',
                ...configWarnings(warnings),
                error: `no poll has been in flight and none has completed for ${sincePoll ?? 'any'}ms — the poll loop has stopped rescheduling itself`,
            },
        };
    }

    // `status` last on purpose: it is the envelope's own field, and spreading the
    // snapshot over it would let a future WorkerHealthStatus.status silently
    // redefine what "ok" means to every probe.
    return {
        statusCode: 200,
        body: { ...workerHealth, status: 'ok', ...configWarnings(warnings) },
    };
}
