import { describe, it, expect } from 'vitest';
import type { WorkerHealthStatus } from '@copilotkit/outpost/queue';
import {
    buildHealthResponse,
    classifyFatalError,
    resolveDurationMs,
    resolvePort,
    summarizeBootError,
    CLAIM_STALL_MS,
    STALE_POLL_MS,
    type BootState,
} from '../health.js';

const NOW = new Date('2026-08-12T22:00:00.000Z').getTime();

// Typed as the real contract, so a rename or removal in WorkerHealthStatus fails
// this file instead of leaving it green against a shape /health never serves.
const WORKER_HEALTH: WorkerHealthStatus = {
    running: true,
    activeJobCount: 2,
    activeJobsByType: { AI_RESPONSE: 2 },
    lastPollTime: new Date(NOW - 1_000),
    pollStartedAt: null,
    lastPollCompletedAt: new Date(NOW - 1_000),
    overdueJobCount: 0,
    lastJobSettledAt: new Date(NOW - 1_000),
    pollFailingSince: null,
    consecutivePollFailures: 0,
    registeredHandlers: ['AI_RESPONSE', 'TRACKER_SYNC'],
    upSince: new Date(NOW - 3_600_000),
};

// The fixtures below are computed as `CONSTANT ± 1`, so they re-derive from
// whatever the constant says and can never disagree with it. These pin the
// literals, because the sizing is the thing that was wrong twice: 60s against a
// 300s job timeout is what got the first attempt reverted, and a bound ten times
// too lenient would ship green under fixtures alone.
describe('the bounds themselves', () => {
    it('sizes the between-polls bound for a loop that reschedules every second', () => {
        expect(STALE_POLL_MS).toBe(60_000);
    });

    it('sizes the claim bound for a claim query, not for a poll', () => {
        expect(CLAIM_STALL_MS).toBe(60_000);
    });
});

describe('buildHealthResponse', () => {
    it('reports 200 with the worker snapshot once boot is ready and the worker is polling', () => {
        const { statusCode, body } = buildHealthResponse({ phase: 'ready' }, WORKER_HEALTH, NOW);

        expect(statusCode).toBe(200);
        expect(body).toMatchObject({ status: 'ok', running: true, activeJobCount: 2 });
    });

    // `status` is the envelope's field. Spreading the snapshot over it would let a
    // future WorkerHealthStatus.status redefine "ok" for every probe silently.
    it('keeps its own status field even if the snapshot carries one', () => {
        const shadowed = { ...WORKER_HEALTH, status: 'degraded' } as unknown as WorkerHealthStatus;

        const { body } = buildHealthResponse({ phase: 'ready' }, shadowed, NOW);

        expect(body.status).toBe('ok');
    });

    // The regression this pins: the worker used to await the database at module
    // scope, above the health server, so a boot failure exited the process before
    // anything bound the port. Railway could only say "1/1 replicas never became
    // healthy" — indistinguishable from a broken image, and it hid a missing
    // SystemConfig table for nine days. A failed boot must now answer, and the
    // answer must carry the reason.
    it('reports 503 AND the reason when boot failed', () => {
        const boot: BootState = {
            phase: 'failed',
            error: 'P2021: missing database object `public.SystemConfig`',
        };

        const { statusCode, body } = buildHealthResponse(boot, null, NOW);

        expect(statusCode).toBe(503);
        expect(body.status).toBe('failed');
        expect(body.error).toContain('SystemConfig');
    });

    it('reports 503 with a reason while boot is still in progress', () => {
        const { statusCode, body } = buildHealthResponse({ phase: 'starting' }, null, NOW);

        expect(statusCode).toBe(503);
        expect(body.status).toBe('starting');
        expect(body.error).toBeTruthy();
    });

    // Fail-fast is retained on purpose: a worker whose sync mappings could not be
    // read must never be routed to, because it would write wrong statuses to
    // Linear. This pins that a failed boot is not quietly downgraded to healthy.
    it('never returns 200 for a failed boot, even with a worker snapshot present', () => {
        const boot: BootState = { phase: 'failed', error: 'connection refused' };

        const { statusCode, body } = buildHealthResponse(boot, WORKER_HEALTH, NOW);

        expect(statusCode).toBe(503);
        expect(body.error).toBe('connection refused');
    });

    // The gap that actually reaches production. Worker.stop() sets running=false
    // without exiting the process — including from Worker's OWN signal handlers —
    // so gating the 200 on the snapshot's existence alone answered
    // 200 {"status":"ok","running":false} for a worker processing nothing.
    it('does not report 200 for a worker that has stopped', () => {
        const stopped: WorkerHealthStatus = { ...WORKER_HEALTH, running: false, upSince: null };

        const { statusCode, body } = buildHealthResponse({ phase: 'ready' }, stopped, NOW);

        expect(statusCode).toBe(503);
        expect(body.status).toBe('stopped');
        expect(body.error).toContain('not running');
    });

    // Worker.poll() catches every error and reschedules, so a poll blocked on a
    // hung database call leaves running=true forever with lastPollTime frozen.
    it('does not report 200 for a worker whose poll loop has stalled', () => {
        const stalled: WorkerHealthStatus = {
            ...WORKER_HEALTH,
            pollStartedAt: null,
            activeJobCount: 0,
            lastPollTime: new Date(NOW - STALE_POLL_MS - 1),
            lastPollCompletedAt: new Date(NOW - STALE_POLL_MS - 1),
        };

        const { statusCode, body } = buildHealthResponse({ phase: 'ready' }, stalled, NOW);

        expect(statusCode).toBe(503);
        expect(body.status).toBe('stalled');
    });

    it('does not report 200 for a worker that has never polled', () => {
        const neverPolled: WorkerHealthStatus = {
            ...WORKER_HEALTH,
            lastPollTime: null,
            lastPollCompletedAt: null,
        };

        const { statusCode } = buildHealthResponse({ phase: 'ready' }, neverPolled, NOW);

        expect(statusCode).toBe(503);
    });

    // ─── busy is not stalled ───────────────────────────────────────────────
    //
    // THE REGRESSION THIS MODEL EXISTS FOR, and the one that got the previous
    // attempt reverted. Two facts together: poll() stamps lastPollTime and then
    // awaits its jobs, and claimJobsByType awaits each TYPE's batch sequentially
    // (worker.ts) — so a single poll may legitimately run the SUM of every
    // registered type's timeout. Against the config in index.ts that is 930s.
    //
    // Both earlier bounds were therefore wrong: `now - lastPollTime > 60s`, and
    // its replacement `pollDuration > max(jobTimeouts) + 60s` = 360s. Either one
    // reports a healthy worker stalled, and the container probe kills it mid-job
    // ~90s later. So poll duration is not the signal at all — the worker reports
    // per-job overrun instead, and that needs no scheduling arithmetic.
    describe('a long-running poll is busy, not stalled', () => {
        const midPoll = (pollAgeMs: number, over: Partial<WorkerHealthStatus> = {}) => ({
            ...WORKER_HEALTH,
            pollStartedAt: new Date(NOW - pollAgeMs),
            lastPollTime: new Date(NOW - pollAgeMs),
            lastPollCompletedAt: new Date(NOW - pollAgeMs - 1_000),
            activeJobCount: 1,
            ...over,
        });

        // 930_000 is the real sequential worst case for the ten registered types.
        it.each([61_000, 360_001, 600_000, 930_000, 1_200_000])(
            'reports 200 after %ims of polling while jobs are in flight and none is overdue',
            (pollAgeMs) => {
                const { statusCode, body } = buildHealthResponse(
                    { phase: 'ready' },
                    midPoll(pollAgeMs),
                    NOW,
                );

                expect(statusCode).toBe(200);
                expect(body.status).toBe('busy');
            },
        );

        // The worker judges each job against ITS OWN timeout, so this is the
        // signal that a long poll has stopped being honest work.
        it('reports 503 when the worker says a job has outlived its own timeout', () => {
            const overdue = midPoll(600_000, { overdueJobCount: 1 });

            const { statusCode, body } = buildHealthResponse({ phase: 'ready' }, overdue, NOW);

            expect(statusCode).toBe(503);
            expect(body.status).toBe('stalled');
            expect(body.error).toContain('outlived their own timeout');
        });

        // Ordering test: overdue is checked BEFORE any timing branch, so a
        // snapshot whose every timing signal looks healthy still reports 503 when
        // the worker says its jobs are not progressing. Whether the worker can
        // currently produce fresh poll stamps while saturated is beside the point
        // — the health check must not depend on that being impossible.
        it('lets overdue jobs override otherwise-healthy timing signals', () => {
            const wedgedAtCapacity: WorkerHealthStatus = {
                ...WORKER_HEALTH,
                activeJobCount: 10,
                pollStartedAt: null,
                lastPollCompletedAt: new Date(NOW - 500),
                lastPollTime: new Date(NOW - 500),
                lastJobSettledAt: new Date(NOW - 7_200_000),
                overdueJobCount: 10,
            };

            const { statusCode, body } = buildHealthResponse(
                { phase: 'ready' },
                wedgedAtCapacity,
                NOW,
            );

            expect(statusCode).toBe(503);
            expect(body.status).toBe('stalled');
        });

        // A poll with nothing claimed is doing one bounded thing. Long silence
        // there is a blocked claim query, and no job can be blamed for it.
        it('reports 503 when a poll runs long with no job in flight', () => {
            const claimBlocked = midPoll(CLAIM_STALL_MS + 1, {
                activeJobCount: 0,
                // Nothing has settled inside this poll, so the whole poll really
                // has been spent claiming.
                lastJobSettledAt: new Date(NOW - CLAIM_STALL_MS - 10_000),
            });

            const { statusCode, body } = buildHealthResponse({ phase: 'ready' }, claimBlocked, NOW);

            expect(statusCode).toBe(503);
            expect(body.status).toBe('stalled');
            expect(body.error).toContain('blocked claiming');
        });

        it('still reports 200 for a short poll with nothing claimed yet', () => {
            const justStarted = midPoll(CLAIM_STALL_MS - 1, { activeJobCount: 0 });

            expect(buildHealthResponse({ phase: 'ready' }, justStarted, NOW).statusCode).toBe(200);
        });

        it('does not let an in-flight poll mask a stopped worker', () => {
            const stoppedMidPoll = midPoll(1_000, { running: false });

            const { statusCode, body } = buildHealthResponse(
                { phase: 'ready' },
                stoppedMidPoll,
                NOW,
            );

            expect(statusCode).toBe(503);
            expect(body.status).toBe('stopped');
        });
    });

    // ─── the gap BETWEEN polls ─────────────────────────────────────────────
    //
    // With no poll in flight, the loop should have rescheduled itself within
    // pollIntervalMs. A long silence here means it stopped rescheduling, which is
    // the genuine wedge the old bound was trying to catch.
    it('reports 503 when no poll is in flight and none has completed inside the bound', () => {
        const notRescheduling: WorkerHealthStatus = {
            ...WORKER_HEALTH,
            pollStartedAt: null,
            lastPollCompletedAt: new Date(NOW - STALE_POLL_MS - 1),
        };

        const { statusCode, body } = buildHealthResponse({ phase: 'ready' }, notRescheduling, NOW);

        expect(statusCode).toBe(503);
        expect(body.status).toBe('stalled');
        expect(body.error).toContain('rescheduling');
    });

    it('measures the gap from the completion stamp, not the start stamp', () => {
        // A poll that STARTED long ago but completed a second ago is healthy. Under
        // the old single-stamp reading this was the killed-mid-job case.
        const longPollJustFinished: WorkerHealthStatus = {
            ...WORKER_HEALTH,
            pollStartedAt: null,
            lastPollTime: new Date(NOW - 290_000),
            lastPollCompletedAt: new Date(NOW - 1_000),
        };

        expect(buildHealthResponse({ phase: 'ready' }, longPollJustFinished, NOW).statusCode).toBe(
            200,
        );
    });

    // A half-booted worker must not be reported healthy just because the phase
    // flag says ready — and the 503 must still explain itself rather than
    // answering {"status":"ready","error":null}, which is the reasonless body
    // this endpoint exists to eliminate.
    it('reports 503 with a reason when the phase is ready but no worker exists', () => {
        const { statusCode, body } = buildHealthResponse({ phase: 'ready' }, null, NOW);

        expect(statusCode).toBe(503);
        expect(body.status).toBe('no-worker');
        expect(body.error).toContain('boot sequence');
    });

    it('serves a body that survives JSON serialization', () => {
        const { body } = buildHealthResponse({ phase: 'ready' }, WORKER_HEALTH, NOW);

        expect(() => JSON.stringify(body)).not.toThrow();
        expect(JSON.parse(JSON.stringify(body))).toMatchObject({ status: 'ok', running: true });
    });
});

// /health is unauthenticated, so whatever lands in boot.error is published.
// Prisma's connectivity errors quote the database host, port and user; its
// schema errors arrive as a multi-line blob whose preamble carries an absolute
// container path and a source code frame. Only the object name may survive.
describe('summarizeBootError', () => {
    // The shape Prisma actually throws — not a hand-built single-line message.
    const realisticP2021 = Object.assign(
        new Error(
            'Invalid `prisma.systemConfig.findUnique()` invocation in\n' +
                '/app/packages/outpost/shared/dist/sync/config.js:34:56\n\n' +
                '  31 const existing = await db.systemConfig.findUnique({\n\n' +
                'The table `public.SystemConfig` does not exist in the current database.',
        ),
        { code: 'P2021' },
    );

    it('names the missing object without leaking container paths or the code frame', () => {
        const summary = summarizeBootError(realisticP2021);

        expect(summary).toContain('P2021');
        expect(summary).toContain('public.SystemConfig');
        expect(summary).not.toContain('/app/');
        expect(summary).not.toContain('findUnique');
    });

    it('covers P2022 missing-column drift, not just P2021', () => {
        const error = Object.assign(
            new Error(
                'The column `public.SystemConfig.updatedAt` does not exist in the current database.',
            ),
            { code: 'P2022' },
        );

        expect(summarizeBootError(error)).toContain('P2022');
        expect(summarizeBootError(error)).toContain('SystemConfig.updatedAt');
    });

    it('redacts the host and user out of a connectivity error', () => {
        const error = Object.assign(
            new Error("Can't reach database server at `db.internal.railway.app:5432`"),
            { code: 'P1001' },
        );

        const summary = summarizeBootError(error);

        expect(summary).toContain('P1001');
        expect(summary).not.toContain('db.internal.railway.app');
        expect(summary).not.toContain('5432');
    });

    // PrismaClientInitializationError carries `errorCode`, not `code` — the real
    // shape observed from a live boot against an unreachable database.
    it('reads errorCode as well as code', () => {
        const error = Object.assign(
            new Error('Timed out fetching a new connection from the pool'),
            {
                errorCode: 'P2024',
            },
        );

        expect(summarizeBootError(error)).toContain('P2024');
    });

    it('falls back to the error class when no code is present at all', () => {
        const error = new Error("Can't reach database server at `127.0.0.1:59999`");
        error.name = 'PrismaClientInitializationError';

        const summary = summarizeBootError(error);

        expect(summary).toContain('PrismaClientInitializationError');
        expect(summary).not.toContain('127.0.0.1');
    });

    it('redacts credentials out of a plain error', () => {
        const summary = summarizeBootError(new Error('postgres://user:hunter2@host/db refused'));

        expect(summary).not.toContain('hunter2');
    });

    it('handles thrown non-Error values', () => {
        expect(summarizeBootError('boom')).toBeTruthy();
        expect(summarizeBootError(null)).toBeTruthy();
        expect(summarizeBootError(undefined)).toBeTruthy();
    });

    // A plain object carrying a safe code is the one case the echo branch exists
    // for; String(obj) would render "[object Object]".
    it('reads .message off a non-Error object carrying a safe code', () => {
        const summary = summarizeBootError({
            code: 'P2021',
            message: 'The table `public.SystemConfig` does not exist in the current database.',
        });

        expect(summary).toContain('public.SystemConfig');
        expect(summary).not.toContain('[object Object]');
    });

    it('bounds the length of anything it serves', () => {
        const error = Object.assign(
            new Error(`The table \`${'x'.repeat(5_000)}\` does not exist.`),
            {
                code: 'P2021',
            },
        );

        expect(summarizeBootError(error).length).toBeLessThanOrEqual(200);
    });
});

// An invalid port used to reach server.listen() as NaN, which throws
// ERR_SOCKET_BAD_PORT synchronously at module scope — killing the process before
// anything bound, the exact opaque failure the health server exists to prevent.
describe('resolvePort', () => {
    it('prefers PORT, then HEALTH_PORT, then the default', () => {
        expect(resolvePort({ PORT: '8080', HEALTH_PORT: '3005' })).toMatchObject({
            port: 8080,
            source: 'PORT',
        });
        expect(resolvePort({ HEALTH_PORT: '3005' })).toMatchObject({
            port: 3005,
            source: 'HEALTH_PORT',
        });
        expect(resolvePort({})).toMatchObject({ port: 3003, source: 'default' });
    });

    // The reported trigger: `??` only falls through on null/undefined, so a
    // cleared platform variable arrives as '' and parses to NaN.
    it('falls back with a warning on an empty PORT rather than yielding NaN', () => {
        const resolved = resolvePort({ PORT: '', HEALTH_PORT: '3005' });

        expect(resolved.port).toBe(3005);
        expect(resolved.source).toBe('HEALTH_PORT');
    });

    it('falls back with a warning on a non-numeric or out-of-range PORT', () => {
        for (const bad of ['tcp://host:5432', 'abc', '70000', '-1']) {
            const resolved = resolvePort({ PORT: bad });

            expect(resolved.port).toBe(3003);
            expect(resolved.warning).toContain(bad);
            expect(Number.isInteger(resolved.port)).toBe(true);
        }
    });
});

// The bug class this resolver exists for is the same one that produced the
// SHADOW_MODE fail-open: `??` guards undefined and null, and a platform variable
// that has been CLEARED is neither — it is the empty string. `Number('')` is 0,
// not NaN, so the coercion succeeds and silently disables whatever the duration
// was guarding.
describe('resolveDurationMs', () => {
    it('falls back when the variable is unset', () => {
        expect(resolveDurationMs(undefined, 'X_MS', 1_000)).toEqual({ ms: 1_000, warning: null });
    });

    it.each(['', '   '])(
        'falls back on a cleared variable (%j) instead of collapsing to 0',
        (raw) => {
            const { ms, warning } = resolveDurationMs(raw, 'SHUTDOWN_WATCHDOG_MS', 330_000);

            expect(ms).toBe(330_000);
            // Nothing to warn about: a cleared variable is indistinguishable from an
            // absent one, and both are ordinary.
            expect(warning).toBeNull();
        },
    );

    it('reads a valid value', () => {
        expect(resolveDurationMs('5000', 'X_MS', 1_000).ms).toBe(5_000);
    });

    it.each(['nonsense', '0', '-1', 'NaN', 'Infinity'])(
        'falls back on the unusable value %j and says so',
        (raw) => {
            const { ms, warning } = resolveDurationMs(raw, 'BOOT_FAILURE_LINGER_MS', 120_000);

            expect(ms).toBe(120_000);
            expect(warning).toContain('BOOT_FAILURE_LINGER_MS');
            expect(warning).toContain(raw);
        },
    );

    // A zero-length watchdog fires immediately, forcing exit(1) on every SIGTERM
    // mid-drain — the concrete incident behind the '0' case above.
    // setTimeout clamps anything above 2**31-1 to 1ms, so an operator reaching
    // for "effectively never" gets the exact opposite: a watchdog that fires
    // immediately and forces exit(1) on every SIGTERM mid-drain, or a linger
    // window that ends before it publishes its reason. The lower bound alone
    // does not catch this.
    it.each(['2147483648', '9999999999', '1e12'])(
        'falls back on %j, which setTimeout would clamp to 1ms',
        (raw) => {
            const { ms, warning } = resolveDurationMs(raw, 'SHUTDOWN_WATCHDOG_MS', 330_000);

            expect(ms).toBe(330_000);
            expect(warning).toContain('SHUTDOWN_WATCHDOG_MS');
        },
    );

    // Number() accepts hex and exponent forms, so `0x10` is a 16ms watchdog that
    // forces exit(1) on every SIGTERM mid-drain and `3e2` is 300ms — the same
    // coercion-leniency class as the Number('') === 0 trap this function exists
    // to close. resolvePort guards it with a digits-only test; so does this.
    it.each(['0x10', '3e2', '1_000', '+500', '5.5'])(
        'falls back on the non-decimal form %j',
        (raw) => {
            const { ms, warning } = resolveDurationMs(raw, 'SHUTDOWN_WATCHDOG_MS', 330_000);

            expect(ms).toBe(330_000);
            expect(warning).toContain('SHUTDOWN_WATCHDOG_MS');
        },
    );

    it('accepts the largest value setTimeout honours', () => {
        expect(resolveDurationMs('2147483647', 'X_MS', 500).ms).toBe(2_147_483_647);
    });

    it('never returns 0, whatever the input', () => {
        for (const raw of ['0', '-5', '', 'x', undefined]) {
            expect(resolveDurationMs(raw, 'X_MS', 500).ms).toBeGreaterThan(0);
        }
    });
});

// A crash after boot is not a failed boot. The failed-boot log advice points at
// schema.prisma and the drift guard, so reporting a handler's stray rejection
// under 'failed' sends whoever is paged to audit migrations.
describe('buildHealthResponse — crashed vs failed', () => {
    it('distinguishes a post-boot crash from a boot failure', () => {
        const crashed = buildHealthResponse(
            { phase: 'crashed', error: 'UNHANDLED REJECTION: Error' },
            null,
            NOW,
        );

        expect(crashed.statusCode).toBe(503);
        expect(crashed.body.status).toBe('crashed');

        const failed = buildHealthResponse(
            { phase: 'failed', error: 'P2021: missing database object' },
            null,
            NOW,
        );

        expect(failed.body.status).toBe('failed');
    });
});

// Config warnings are logged once at boot and then never mentioned again, which
// is precisely where this module exists to stop leaving diagnoses. The watchdog
// one is the sharpest: it prints at boot and bites at the next deploy.
describe('buildHealthResponse — config warnings on the probe', () => {
    const warnings = ['invalid SHUTDOWN_WATCHDOG_MS="" (expected 1-2147483647 ms)'];

    it('publishes warnings on a healthy response', () => {
        const { statusCode, body } = buildHealthResponse(
            { phase: 'ready' },
            WORKER_HEALTH,
            NOW,
            warnings,
        );

        expect(statusCode).toBe(200);
        expect(body.configWarnings).toEqual(warnings);
    });

    it('publishes warnings on a failed boot too', () => {
        const { body } = buildHealthResponse(
            { phase: 'failed', error: 'boom' },
            null,
            NOW,
            warnings,
        );

        expect(body.configWarnings).toEqual(warnings);
    });

    it('omits the key entirely when there is nothing to report', () => {
        const { body } = buildHealthResponse({ phase: 'ready' }, WORKER_HEALTH, NOW);

        expect(body).not.toHaveProperty('configWarnings');
    });
});

describe('resolvePort — values that used to pass silently', () => {
    // Number.parseInt reads a numeric PREFIX, so each of these bound a port the
    // operator never asked for, with warning: null.
    it.each([
        ['0', 'an OS-assigned ephemeral port nothing probes'],
        ['3003abc', 'a truncated parse'],
        ['80.9', 'a truncated parse that needs root'],
        ['1e4', 'a truncated parse of 1'],
        ['70000', 'out of range'],
        ['-1', 'out of range'],
        ['abc', 'not a number'],
        ['tcp://host:5432', 'a whole URL'],
    ])('rejects PORT=%j (%s) and marks it fatal', (raw) => {
        const { port, source, warning, fatal } = resolvePort({ PORT: raw });

        expect(port).toBe(3003);
        expect(source).toBe('default');
        expect(warning).toContain(raw);
        // Falling back is worse than failing: the container healthcheck probes
        // the value as given, so nothing would ever reach the port being served.
        expect(fatal).toBe(true);
    });

    it.each(['1', '3003', '65535'])('accepts the valid port %j', (raw) => {
        const { port, warning, fatal } = resolvePort({ PORT: raw });

        expect(port).toBe(Number(raw));
        expect(warning).toBeNull();
        expect(fatal).toBe(false);
    });

    // The container healthcheck probes ${PORT:-...} verbatim, so a padded value
    // makes wget request an invalid URL every time while this process binds the
    // trimmed port and answers 200 to anything that reaches it — the exact
    // unprobeable-by-construction failure the fatal branch exists to prevent.
    it.each([' 3000', '3000 ', ' 3000 '])('treats the padded port %j as fatal', (raw) => {
        const { fatal, warning } = resolvePort({ PORT: raw });

        expect(fatal).toBe(true);
        expect(warning).toContain(raw);
    });

    it('is not fatal when nothing is set', () => {
        expect(resolvePort({})).toEqual({
            port: 3003,
            source: 'default',
            warning: null,
            fatal: false,
        });
    });
});

describe('classifyFatalError', () => {
    it('records a post-boot crash as crashed, not failed', () => {
        const { next, shouldExit } = classifyFatalError(
            'UNHANDLED REJECTION',
            new Error('handler blew up'),
            { phase: 'ready' },
        );

        // Distinct from 'failed' because the operator advice differs: a failed
        // boot means the database does not match schema.prisma, while this means
        // a handler threw. Reporting one as the other sends whoever is paged to
        // audit migrations for a bug in an AI handler.
        expect(next?.phase).toBe('crashed');
        expect(shouldExit).toBe(true);
    });

    it('classifies a crash during boot as crashed too', () => {
        const { next } = classifyFatalError('UNCAUGHT EXCEPTION', new Error('x'), {
            phase: 'starting',
        });

        expect(next?.phase).toBe('crashed');
    });

    // A failed boot owns its own 120s exit timer. A second 5s timer scheduled
    // here would win and cut the window that publishes the boot reason to 5s.
    it('leaves an already-failed boot alone and schedules no second exit', () => {
        const { next, shouldExit } = classifyFatalError('UNHANDLED REJECTION', new Error('y'), {
            phase: 'failed',
            error: 'P2021: missing database object `SystemConfig`',
        });

        expect(next).toBeNull();
        expect(shouldExit).toBe(false);
    });
});

// A poll that THROWS is not a poll that found nothing. `completePoll()` runs on
// the error path too — deliberately, so a dead loop is not reported as busy
// forever — which stamps `lastPollCompletedAt` and makes a failing poll
// indistinguishable from an idle one.
//
// The failure this closes: the schema drifts and `Job` is missing, or
// credentials rotate, or Postgres refuses connections. buildSyncEngine reads
// only SystemConfig, so boot SUCCEEDS and the worker settles into throwing once
// a second forever. Every timing signal looks perfect and the probe answered 200
// the whole way. Fast-failing is the more common Postgres failure by far, and it
// was the one hole left open by bounding only the HUNG call.
describe('a poll that keeps failing is not healthy', () => {
    const failing = (sinceMs: number, failures: number): WorkerHealthStatus => ({
        ...WORKER_HEALTH,
        activeJobCount: 0,
        pollStartedAt: null,
        // The catch path stamps these exactly as a successful poll would.
        lastPollTime: new Date(NOW - 500),
        lastPollCompletedAt: new Date(NOW - 500),
        pollFailingSince: new Date(NOW - sinceMs),
        consecutivePollFailures: failures,
    });

    it('reports 503 once polls have been failing longer than the stale bound', () => {
        const { statusCode, body } = buildHealthResponse(
            { phase: 'ready' },
            failing(STALE_POLL_MS + 1, 61),
            NOW,
        );

        expect(statusCode).toBe(503);
        expect(body.status).toBe('stalled');
        expect(String(body.error)).toMatch(/fail/i);
    });

    // A single blip during a failover must not flap the probe, which is why this
    // is a window rather than a count.
    it('stays 200 for a brief run of failures inside the window', () => {
        expect(buildHealthResponse({ phase: 'ready' }, failing(5_000, 5), NOW).statusCode).toBe(
            200,
        );
    });

    it('is healthy again once a poll succeeds and clears the window', () => {
        const recovered: WorkerHealthStatus = {
            ...failing(STALE_POLL_MS + 1, 61),
            pollFailingSince: null,
            consecutivePollFailures: 0,
        };

        expect(buildHealthResponse({ phase: 'ready' }, recovered, NOW).statusCode).toBe(200);
    });
});

// The claim clock runs from the later of "this poll started" and "a job last
// settled". claimJobsByType awaits each type's batch sequentially, so after a
// long batch finishes, the remaining claim queries each run with
// activeJobCount === 0 while pollDuration already carries that batch. Measuring
// the whole poll reported a healthy worker stalled — the reverted defect, moved
// rather than removed.
describe('a settled job resets the claim clock', () => {
    it('stays 200 when a batch settled recently, however long the poll has run', () => {
        const afterLongBatch: WorkerHealthStatus = {
            ...WORKER_HEALTH,
            activeJobCount: 0,
            pollStartedAt: new Date(NOW - 118_000),
            lastPollTime: new Date(NOW - 118_000),
            // The AI_RESPONSE batch finished a moment ago; the poll is now
            // issuing the next type's claim query.
            lastJobSettledAt: new Date(NOW - 200),
        };

        const { statusCode, body } = buildHealthResponse({ phase: 'ready' }, afterLongBatch, NOW);

        expect(statusCode).toBe(200);
        expect(body.status).toBe('busy');
    });

    it('reports 503 once nothing has settled for longer than the bound', () => {
        const nothingSettling: WorkerHealthStatus = {
            ...WORKER_HEALTH,
            activeJobCount: 0,
            pollStartedAt: new Date(NOW - 300_000),
            lastPollTime: new Date(NOW - 300_000),
            lastJobSettledAt: new Date(NOW - CLAIM_STALL_MS - 1),
        };

        expect(buildHealthResponse({ phase: 'ready' }, nothingSettling, NOW).statusCode).toBe(503);
    });
});
