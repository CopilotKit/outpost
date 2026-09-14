/**
 * Outpost Worker Process
 *
 * The background job processor for Outpost. Boots a Worker (which polls
 * the Postgres job queue) and a Scheduler (which creates recurring jobs
 * on fixed intervals), then exposes a /health endpoint for Railway.
 *
 * Job types and their handlers:
 *   - AI_RESPONSE:      Generate AI support response (pipeline + classification)
 *   - ESCALATION:       Route ticket to a human, post notification
 *   - SLA_CHECK:        Periodic compliance check, flag breaches
 *   - ONBOARDING_DIGEST: Daily new-member digest
 *   - ACCOUNT_SCORING:  Sentiment + engagement analysis
 *   - HUBSPOT_SYNC:     CRM sync
 *   - TRACKER_SYNC:     Push changes to external trackers
 *   - JOB_CLEANUP:      Periodic cleanup of old jobs and sync events
 *   - GITHUB_REACTION_POLL: Poll GitHub reactions on AI comments (no webhook exists)
 *   - PENDING_RESPONSE_SWEEP: Settle AI responses stranded in PENDING by a dead job
 *
 * BOOT ORDER: /health starts listening before any database QUERY runs, so a boot
 * failure is reported rather than merely fatal. See the boot-state block below.
 * Two classes still escape it, both by construction: the `prisma` import below
 * constructs a PrismaClient at module scope (it throws for an ungenerated client
 * or an unparseable DATABASE_URL), and a failure to bind the port itself cannot
 * be reported over the port. Both are handled loudly rather than silently — see
 * the health-server error handler and the last-resort handlers at the bottom.
 */

import http from 'node:http';
import { prisma } from '@copilotkit/outpost/db';
import {
    Worker,
    Scheduler,
    JobType,
    handleAiResponse,
    handleEscalation,
    handleSlaCheck,
    handleOnboardingDigest,
    handleAccountScoring,
    handleHubSpotSync,
    createTrackerSyncHandler,
    handleJobCleanup,
    handleGithubReactionPoll,
    handlePendingResponseSweep,
} from '@copilotkit/outpost/queue';
import { buildSyncEngine } from './build-sync-engine.js';
import {
    buildHealthResponse,
    classifyFatalError,
    resolveDurationMs,
    resolvePort,
    summarizeBootError,
    type BootState,
} from './health.js';

// ─── Boot state ───────────────────────────────────────────────────────────

// Fail-fast on a bad boot is still the intent: a worker running with silently
// defaulted sync mappings would write wrong statuses to Linear, so it must not
// report itself healthy. What changed is that failing is no longer SILENT.
//
// This used to be a top-level `await buildSyncEngine()` above the health server,
// so any boot-time database problem killed the process before anything bound the
// port. Railway could only report "1/1 replicas never became healthy", which is
// indistinguishable from a broken image. That cost nine days of undiagnosed
// deploy failures when SystemConfig turned out to be missing from the production
// database: every deploy from 2026-08-07 failed with no usable signal.
//
// Now the port binds first and /health answers 503 with the reason while the boot
// is unfinished or failed, so the reason is one probe away instead of buried in
// container logs nobody had reason to suspect.
//
// A failed boot does NOT park here forever. Railway's healthcheckPath gates a NEW
// DEPLOYMENT; it does not continuously probe and restart an already-running
// service, and restartPolicyType="ALWAYS" is a restart-on-exit policy that can
// never fire on a process that never exits. Staying up indefinitely would mean a
// 20-second Postgres failover during an ordinary container restart wedges the
// worker with zero jobs processed until a human notices — strictly worse than the
// crash-loop it replaced. So the reason is published for BOOT_FAILURE_LINGER_MS
// (long enough for the deploy probe and any log scrape to read it) and then the
// process exits non-zero so the restart policy retries. Diagnosable AND
// self-healing; the two were never actually in tension.
let boot: BootState = { phase: 'starting' };

/**
 * Read `boot` without control-flow narrowing.
 *
 * TypeScript narrows the module-level `boot` to its initializer and cannot see
 * that failFatally reassigns it from a process-level handler while an await is
 * pending, so a direct `boot.phase === 'crashed'` reads as an impossible
 * comparison.
 */
const currentBoot = (): BootState => boot;

let worker: Worker | null = null;
let scheduler: Scheduler | null = null;

// ─── Health Server ────────────────────────────────────────────────────────

// Published on /health as well as logged. A boot-time log line is exactly the
// place this module exists to stop leaving diagnoses.
const configWarningList: string[] = [];

const {
    port,
    source: portSource,
    warning: portWarning,
    fatal: portFatal,
} = resolvePort(process.env);
if (portWarning) {
    console.error(`[Worker] ${portWarning}`);
    configWarningList.push(portWarning);
}

// An explicitly-set but unusable PORT is fatal rather than defaulted. The
// container healthcheck probes ${PORT:-${HEALTH_PORT:-3003}} and shell :-
// substitutes only for unset or EMPTY, so serving on the fallback would leave
// the probe asking for a port nothing listens on — a container that dies in
// ~90s while /health answered 200 the whole way. That is the opaque failure this
// module exists to delete, so a wrong port is fatal for the same reason
// EADDRINUSE is: it cannot be reported over the port it broke.
if (portFatal) {
    console.error(
        `[Worker] FATAL: refusing to start on a fallback port. ${portWarning} — ` +
            `the container healthcheck probes the value as given, so nothing would ever reach /health. ` +
            `Fix PORT/HEALTH_PORT, or unset it to accept the default.`,
    );
    process.exit(1);
}

const healthServer = http.createServer((req, res) => {
    // A probe must never be able to kill the process it exists to observe:
    // worker.healthCheck() and JSON.stringify both run in this callback, and an
    // exception in an http listener is an uncaught exception.
    try {
        const path =
            new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '') || '/';
        if (path !== '/health') {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
            return;
        }

        const { statusCode, body } = buildHealthResponse(
            boot,
            worker ? worker.healthCheck() : null,
            Date.now(),
            configWarningList,
        );
        // Serialized BEFORE the headers are committed. With writeHead first,
        // res.headersSent is already true, so the catch below would throw
        // ERR_HTTP_HEADERS_SENT — an uncaught exception inside an http listener,
        // which is a probe killing the process it exists to observe.
        const payload = JSON.stringify(body);
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(payload);
    } catch (error) {
        console.error('[Worker] /health handler threw:', error);
        if (res.headersSent) {
            res.end();
            return;
        }
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
            JSON.stringify({
                status: 'error',
                error: 'health handler failed — see the worker logs',
            }),
        );
    }
});

// listen() reports bind failures asynchronously through 'error'. With no listener
// that is an uncaught exception: the port never binds and the process dies to a
// bare stack trace — the same opaque signal as the original incident, arriving
// through the one step everything else now depends on. It is also the single
// failure that genuinely cannot be reported over /health, so it must be loud in
// the logs and must exit rather than linger pretending to serve.
healthServer.on('error', (error: NodeJS.ErrnoException) => {
    console.error(
        `[Worker] FATAL: could not bind the health server to port ${port} (${error.code ?? 'unknown'}, from ${portSource}). ` +
            `Nothing can report this process's state without it. Check PORT/HEALTH_PORT and whether another process holds the port.`,
        error,
    );
    process.exit(1);
});

healthServer.listen(port, () => {
    console.log(
        `[Worker] Health server listening on port ${port} (from ${portSource}, boot: ${boot.phase})`,
    );
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────

// Registered BEFORE the boot await, not after it. Boot is the slowest thing this
// process does, which is exactly when Railway tears a bad deploy down — and a
// SIGTERM arriving while module evaluation is still suspended would find no
// handler and kill the process outright.
//
// Note there is a SECOND registrar: Worker.start() installs its own SIGTERM /
// SIGINT handlers that call worker.stop() unawaited. Both fire. That is safe
// only because Worker.stop() early-returns on !running and this handler runs
// first, so ordering here is load-bearing — do not move this registration below
// startWorker().
let shuttingDown = false;

// Longer than the largest entry in jobTimeouts below (300s), because
// Worker.stop() waits for in-flight jobs to finish. A watchdog shorter than the
// drain it guards would turn every deploy that lands mid-job into a forced
// exit(1) — guarding the hang while breaking the normal path.
const { ms: SHUTDOWN_WATCHDOG_MS, warning: watchdogWarning } = resolveDurationMs(
    process.env.SHUTDOWN_WATCHDOG_MS,
    'SHUTDOWN_WATCHDOG_MS',
    330_000,
);
if (watchdogWarning) {
    console.error(`[Worker] ${watchdogWarning}`);
    configWarningList.push(watchdogWarning);
}

async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Worker] Received ${signal} in boot phase '${boot.phase}', shutting down...`);

    // NOT unref'd. The motivating case is a $disconnect() that never settles
    // after the server is closed — precisely when no other referenced handle
    // remains, so an unref'd timer would let Node exit 0 (reporting a clean stop
    // for a shutdown that never completed) and this line would never print.
    // Every path below ends in process.exit, so a referenced timer costs nothing.
    const watchdog = setTimeout(() => {
        console.error(
            `[Worker] Shutdown did not finish in ${SHUTDOWN_WATCHDOG_MS}ms, exiting anyway`,
        );
        process.exit(1);
    }, SHUTDOWN_WATCHDOG_MS);

    try {
        // Close the listener FIRST. Worker.stop() blocks until in-flight jobs
        // finish (up to 300s), and advertising a healthy /health for the whole
        // drain window tells the platform to keep routing to a replica that has
        // already committed to dying.
        // Closed FIRST, which inverts main's order deliberately. worker.stop()
        // blocks until in-flight jobs finish — up to the watchdog — and answering
        // 200 for that whole window tells the platform to keep routing to a
        // replica that has already committed to dying. The cost is that /health
        // is unreachable during the drain, which is a real loss: the drain is
        // when an operator most wants to ask what the worker is doing. The logs
        // carry that instead, and routing work to a dying replica is the worse
        // of the two.
        healthServer.close();
        scheduler?.stop();
        await worker?.stop();
        await prisma.$disconnect();
        console.log('[Worker] Shutdown complete');
        process.exit(0);
    } catch (error) {
        // Observed: signalled mid-boot, $disconnect() rejects while tearing down
        // a pool that never filled ("Timed out fetching a new connection from the
        // connection pool"). Without this the rejection is unhandled and the
        // process dies to a stack trace mid-shutdown instead of reporting a
        // failed stop.
        console.error('[Worker] Shutdown failed:', error);
        process.exit(1);
    }
}

// `void` because an unhandled rejection here would be the very failure the catch
// above exists to prevent.
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// ─── Last-Resort Handlers ─────────────────────────────────────────────────

// The whole design rests on this process staying up to explain itself, and under
// Node's defaults a single unhandled rejection ends it with a bare stack trace —
// back to the undiagnosable behaviour. Worker.poll() is fired unawaited from a
// timer and Worker's own signal handler calls stop() unawaited, so the paths
// exist. Mark the process unhealthy so /health tells the platform to stop routing
// to it, publish the reason, and then exit so the restart policy retries rather
// than leaving a wedged replica behind.
function failFatally(kind: string, error: unknown): void {
    console.error(`[Worker] ${kind}:`, error);

    const { next, shouldExit } = classifyFatalError(kind, error, boot);
    if (next) boot = next;

    if (!shouldExit || shuttingDown) return;

    // Stop claiming BEFORE exiting. The scheduler's setInterval timers and the
    // worker's poll loop both keep running otherwise, so every job claimed
    // between here and process.exit is abandoned mid-flight and left
    // status='PROCESSING' — and nothing requeues a stale lockedAt, so those jobs
    // are lost rather than retried. Same hazard the boot-after-shutdown guard in
    // startWorker() exists to prevent, reached by a different path.
    scheduler?.stop();
    void worker?.stop().catch((stopError) => {
        console.error('[Worker] Failed to stop the worker after a fatal error:', stopError);
    });

    setTimeout(() => process.exit(1), 5_000);
}

process.on('unhandledRejection', (reason) => failFatally('UNHANDLED REJECTION', reason));
process.on('uncaughtException', (error) => failFatally('UNCAUGHT EXCEPTION', error));

// ─── Boot ─────────────────────────────────────────────────────────────────

// Everything that can throw at boot lives in here: buildSyncEngine's three
// database reads (the persisted status / priority / label mapping configs), the
// Worker construction, and the scheduler/worker start. Anything that escapes
// leaves boot.phase === 'failed' and the process ALIVE but unhealthy, so the
// reason reaches /health instead of vanishing with the process.
async function startWorker(): Promise<void> {
    const syncEngine = await buildSyncEngine();
    const handleTrackerSync = createTrackerSyncHandler(syncEngine);

    const started = new Worker({
        maxConcurrency: 10,
        pollIntervalMs: 1000,
        concurrencyByType: {
            [JobType.AI_RESPONSE]: 4,
            [JobType.ESCALATION]: 2,
            [JobType.SLA_CHECK]: 1,
            [JobType.ONBOARDING_DIGEST]: 1,
            [JobType.ACCOUNT_SCORING]: 1,
            [JobType.HUBSPOT_SYNC]: 1,
            [JobType.TRACKER_SYNC]: 1,
            [JobType.JOB_CLEANUP]: 1,
            [JobType.GITHUB_REACTION_POLL]: 1,
            [JobType.PENDING_RESPONSE_SWEEP]: 1,
        },
        jobTimeouts: {
            [JobType.AI_RESPONSE]: 120_000, // 2 minutes — AI pipeline is slow
            [JobType.HUBSPOT_SYNC]: 300_000, // 5 minutes — full sync can be large
            [JobType.ACCOUNT_SCORING]: 300_000, // 5 minutes — many accounts
        },
    });

    // ─── Register Handlers ────────────────────────────────────────────────
    started.on(JobType.AI_RESPONSE, handleAiResponse);
    started.on(JobType.ESCALATION, handleEscalation);
    started.on(JobType.SLA_CHECK, handleSlaCheck);
    started.on(JobType.ONBOARDING_DIGEST, handleOnboardingDigest);
    started.on(JobType.ACCOUNT_SCORING, handleAccountScoring);
    started.on(JobType.HUBSPOT_SYNC, handleHubSpotSync);
    started.on(JobType.TRACKER_SYNC, handleTrackerSync);
    started.on(JobType.JOB_CLEANUP, handleJobCleanup);
    started.on(JobType.GITHUB_REACTION_POLL, handleGithubReactionPoll);
    started.on(JobType.PENDING_RESPONSE_SWEEP, handlePendingResponseSweep);

    // A SIGTERM can land while buildSyncEngine() is still awaiting. shutdown()
    // then runs to completion against null handles and heads for process.exit,
    // and without this check the boot would resume behind it: Scheduler.start()
    // ticks every definition immediately (enqueueing jobs) and Worker.start()
    // begins claiming them, so the exit strands freshly-claimed rows in
    // PROCESSING. Nothing sequences the two promise chains, so the flag is what
    // sequences them.
    if (shuttingDown) {
        console.log('[Worker] Boot completed after shutdown began — not starting the worker');
        return;
    }

    // Published before start() so a probe landing mid-start sees the real worker,
    // and so shutdown can stop it if a signal arrives during boot.
    const nextScheduler = new Scheduler();
    worker = started;
    scheduler = nextScheduler;

    try {
        nextScheduler.start();
        started.start();
    } catch (error) {
        // Scheduler.start() ticks every definition immediately and installs
        // setInterval timers, so a throw between it and worker.start() would
        // otherwise leave a process that reports itself failed while still
        // enqueueing jobs nothing will consume. Torn down through the locals —
        // the module-level handles are narrowed to null at the outer catch.
        nextScheduler.stop();
        await started.stop().catch(() => {});
        worker = null;
        scheduler = null;
        throw error;
    }
}

// NOTHING IS RETHROWN HERE, deliberately. This is a top-level-await entry
// module: an exception escaping module evaluation rejects its evaluation
// promise, which Node reports as an uncaught exception and exits on — a
// listening HTTP server does not keep the process alive. Rethrowing would kill
// the health server before it could answer a single probe and hand Railway the
// same bare "1/1 replicas never became healthy" that hid a missing SystemConfig
// table for nine days. Staying up and answering 503 IS the fix.
//
// Fail-fast is still the intent: a worker whose sync mappings could not be read
// must never be reported healthy, because TRACKER_SYNC would write wrong
// statuses to Linear. Railway fails the deploy on the failing healthcheck and
// keeps the previous replica serving — same outcome, with a reason attached.
// How long a failed boot keeps answering 503 with its reason before exiting so
// restartPolicyType="ALWAYS" retries. Long enough for a deploy healthcheck and a
// log scrape to read it; short enough that a transient database outage recovers
// on its own rather than waiting for a human.
const { ms: BOOT_FAILURE_LINGER_MS, warning: lingerWarning } = resolveDurationMs(
    process.env.BOOT_FAILURE_LINGER_MS,
    'BOOT_FAILURE_LINGER_MS',
    120_000,
);
if (lingerWarning) {
    console.error(`[Worker] ${lingerWarning}`);
    configWarningList.push(lingerWarning);
}

// How long boot may sit in `starting` before it is treated as failed.
//
// BOOT_FAILURE_LINGER_MS arms inside the catch, so it only ever watches a boot
// that THREW. A boot that HANGS never reaches it: buildSyncEngine() does three
// database reads and Prisma applies no query timeout, so a Postgres that accepts
// the connection and then stops answering — a failover, a saturated pool, a
// partition that drops packets without resetting — leaves that await pending
// forever. The process then sits at 503 `starting` processing nothing, and
// restartPolicyType="ALWAYS" cannot fire because nothing exits.
//
// That is the indefinite wedge the header above argues is unacceptable, reached
// through the one path the linger timer does not watch. Sized well above a cold
// boot's three reads so a slow-but-fine start is never cut short.
const { ms: BOOT_DEADLINE_MS, warning: deadlineWarning } = resolveDurationMs(
    process.env.BOOT_DEADLINE_MS,
    'BOOT_DEADLINE_MS',
    180_000,
);
if (deadlineWarning) {
    console.error(`[Worker] ${deadlineWarning}`);
    configWarningList.push(deadlineWarning);
}

const bootDeadline = setTimeout(() => {
    if (currentBoot().phase !== 'starting' || shuttingDown) return;
    boot = {
        phase: 'failed',
        error: `boot did not finish within ${BOOT_DEADLINE_MS}ms — it is hung rather than failed, most likely on a database read that never returned`,
    };
    console.error(`[Worker] BOOT HUNG: ${boot.error}`);
    console.error(
        '[Worker] Exiting 1 so the restart policy retries; staying up would wedge this replica at zero jobs.',
    );
    // Exits immediately rather than lingering: unlike a thrown boot there is no
    // error to publish that a reader has not already had the whole window to see.
    process.exit(1);
}, BOOT_DEADLINE_MS);

try {
    await startWorker();
    clearTimeout(bootDeadline);
    if (!shuttingDown) {
        // Not if the process has already committed to dying. failFatally may have
        // set `crashed` and armed exit(1) while boot was still finishing, and 200
        // is the one answer that makes a load balancer send work.
        if (currentBoot().phase === 'crashed') {
            console.error('[Worker] Boot finished after a fatal error; not reporting ready.');
        } else {
            boot = { phase: 'ready' };
            console.log('[Worker] Worker process started');
        }
    }
} catch (error) {
    clearTimeout(bootDeadline);
    // startWorker() has already torn down anything it managed to start, so by
    // here the process holds no timers and no poll loop — only the health server.
    //
    // The full error goes to the logs only — /health carries the redacted form,
    // since Prisma's errors quote the database host, port, user and container paths.
    boot = { phase: 'failed', error: summarizeBootError(error) };
    console.error('[Worker] BOOT FAILED:', error);
    console.error(
        `[Worker] /health on ${port} reports 503 ("${boot.error}") for ${BOOT_FAILURE_LINGER_MS}ms, ` +
            `then this process exits 1 so Railway's restart policy retries. ` +
            `A missing table or column here means the database does not match schema.prisma — ` +
            `check the schema-drift guard in apps/worker/start.sh.`,
    );
    setTimeout(() => {
        console.error(
            '[Worker] Exiting after the boot-failure linger window; restart policy takes over.',
        );
        process.exit(1);
    }, BOOT_FAILURE_LINGER_MS);
}
