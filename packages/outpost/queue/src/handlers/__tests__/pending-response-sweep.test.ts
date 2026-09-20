/**
 * Tests for the PENDING_RESPONSE_SWEEP job handler.
 *
 * The sweep is the backstop for responses the owning AI_RESPONSE job can no
 * longer advance, so the interesting behaviour is all about NOT acting: it must
 * leave alone anything a live owner could still settle, and it must be safe to
 * run twice over the same response.
 *
 * Prisma is faked rather than stubbed per-call. The real
 * `enqueueEscalationAtomically` from ai-response.ts is exercised — it is the
 * single escalation path, and its compare-and-set on responseState IS the
 * idempotency mechanism, so a mock of it would test nothing about double
 * escalation. The fake therefore implements updateMany's where-clause matching
 * faithfully: an updateMany whose where does not match returns count 0, exactly
 * as Postgres would.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JobHandlerContext } from '../../types.js';

// ─── Fake Prisma ────────────────────────────────────────────────────────────

interface FakeMessage {
    id: string;
    ticketId: string;
    responseKey: string | null;
    responseState: string | null;
    responseJobId: string | null;
    responseError: string | null;
    escalationRequiredReason: string | null;
    deliveryConfirmed: boolean;
    createdAt: Date;
    ticketSource: string;
}

let messages: FakeMessage[] = [];
let jobs: Array<{ id: string; status: string }> = [];
let createdJobs: Array<{ type: string; payload: unknown }> = [];
let dbNow: Date;
/** Message ids whose updateMany should throw, to exercise per-row isolation. */
let failingUpdates: Set<string>;

/**
 * Generic where matching, so that DROPPING a filter in the handler means "this
 * row is now selected" rather than "the fake stops matching anything". A fake
 * that collapses when a clause disappears cannot tell a real guard from a typo.
 * Supports equality and the one operator the handler uses, `{ lt }`.
 */
function matchesWhere(row: FakeMessage, where: Record<string, unknown>): boolean {
    for (const [key, expected] of Object.entries(where)) {
        if (expected === undefined) continue;
        const actual = (row as unknown as Record<string, unknown>)[key];
        if (expected !== null && typeof expected === 'object' && 'lt' in expected) {
            const bound = (expected as { lt: Date }).lt;
            if (!(actual instanceof Date) || actual.getTime() >= bound.getTime()) return false;
            continue;
        }
        if (actual !== expected) return false;
    }
    return true;
}

const fakeMessage = {
    findMany: vi.fn(async (args: any) => {
        const take = args.take ?? Number.POSITIVE_INFINITY;
        return messages
            .filter((m) => matchesWhere(m, args.where))
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
            .slice(0, take)
            .map((m) => ({
                id: m.id,
                ticketId: m.ticketId,
                responseJobId: m.responseJobId,
                responseError: m.responseError,
                escalationRequiredReason: m.escalationRequiredReason,
                deliveryConfirmed: m.deliveryConfirmed,
                ticket: { source: m.ticketSource },
            }));
    }),
    updateMany: vi.fn(async (args: any) => {
        if (typeof args.where.id === 'string' && failingUpdates.has(args.where.id)) {
            throw new Error('simulated write failure');
        }
        const matched = messages.filter((m) => matchesWhere(m, args.where));
        for (const row of matched) Object.assign(row, args.data);
        return { count: matched.length };
    }),
    findUnique: vi.fn(async (args: { where: { id: string } }) => {
        const row = messages.find((m) => m.id === args.where.id);
        return row
            ? {
                  responseState: row.responseState,
                  escalationRequiredReason: row.escalationRequiredReason,
              }
            : null;
    }),
};

const fakeJob = {
    findMany: vi.fn(async (args: any) => {
        const ids: string[] = args.where.id.in;
        const statuses: string[] = args.where.status.in;
        return jobs
            .filter((j) => ids.includes(j.id) && statuses.includes(j.status))
            .map((j) => ({ id: j.id }));
    }),
    create: vi.fn(async (args: any) => {
        createdJobs.push({ type: args.data.type, payload: args.data.payload });
        return { id: `job-${createdJobs.length}` };
    }),
};

const fakePrisma = {
    message: fakeMessage,
    job: fakeJob,
    ticket: { findUnique: vi.fn(), update: vi.fn() },
    $queryRaw: vi.fn(async () => [{ now: dbNow }]),
    // Atomicity is a database property; what matters for these tests is that the
    // callback sees the same rows, so the transaction client is the same fake.
    $transaction: vi.fn(async (fn: any) => fn(fakePrisma)),
};

vi.mock('@copilotkit/outpost/db', () => ({ prisma: fakePrisma }));

vi.mock('@copilotkit/outpost/ai', () => ({
    AIPipeline: class {
        generateSupportResponse = vi.fn();
        classifyTicket = vi.fn();
        destroy = vi.fn();
    },
}));

vi.mock('@copilotkit/outpost/shared', () => ({
    AI_CONFIDENCE: { ESCALATE: 0.4 },
    MAX_JOB_ATTEMPTS: 5,
}));

vi.mock('@copilotkit/outpost/shared/platforms', () => ({
    hasAdapter: vi.fn().mockReturnValue(false),
    getAdapter: vi.fn(),
}));

vi.mock('../../feedback-calibration.js', () => ({
    getFeedbackCalibration: vi.fn().mockResolvedValue(0),
}));

const { handlePendingResponseSweep, STRANDED_RESPONSE_AFTER_MS, SWEEP_BATCH_SIZE } =
    await import('../pending-response-sweep.js');
const { RESPONSE_RECOVERY_AFTER_MS } = await import('../ai-response.js');

// ─── Helpers ────────────────────────────────────────────────────────────────

const NOW = new Date('2026-08-14T12:00:00.000Z');

function makeContext(): JobHandlerContext {
    return { jobId: 'sweep-job-1', reportProgress: vi.fn().mockResolvedValue(undefined) };
}

/** A timestamp this many milliseconds before the fixed "now". */
function ago(ms: number): Date {
    return new Date(NOW.getTime() - ms);
}

function addMessage(overrides: Partial<FakeMessage> = {}): FakeMessage {
    const row: FakeMessage = {
        id: `msg-${messages.length + 1}`,
        ticketId: 'tkt-1',
        responseKey: 'PRIMARY_AI_RESPONSE',
        responseState: 'PENDING',
        responseJobId: 'owner-job-1',
        responseError: null,
        escalationRequiredReason: null,
        deliveryConfirmed: false,
        // Comfortably past the threshold unless a test says otherwise.
        createdAt: ago(STRANDED_RESPONSE_AFTER_MS * 2),
        ticketSource: 'DISCORD',
        ...overrides,
    };
    messages.push(row);
    return row;
}

function escalationJobs() {
    return createdJobs.filter((j) => j.type === 'ESCALATION');
}

/** Move the stored row after the sweep reads its PENDING snapshot. */
function settleAfterRead(
    row: FakeMessage,
    responseState: 'DELIVERED' | 'ESCALATED',
    escalationRequiredReason: string | null = null,
): void {
    fakeMessage.findMany.mockImplementationOnce(async () => {
        const snapshot = [
            {
                id: row.id,
                ticketId: row.ticketId,
                responseJobId: row.responseJobId,
                responseError: row.responseError,
                escalationRequiredReason: row.escalationRequiredReason,
                deliveryConfirmed: row.deliveryConfirmed,
                ticket: { source: row.ticketSource },
            },
        ];
        row.responseState = responseState;
        row.escalationRequiredReason = escalationRequiredReason;
        return snapshot;
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    messages = [];
    jobs = [];
    createdJobs = [];
    failingUpdates = new Set();
    dbNow = NOW;
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('handlePendingResponseSweep', () => {
    it('escalates a stranded PENDING response whose owning job is gone', async () => {
        const row = addMessage();

        const result = await handlePendingResponseSweep({}, makeContext());

        expect(result.success).toBe(true);
        expect(result.data).toMatchObject({ scanned: 1, escalated: 1, repaired: 0, failed: 0 });
        expect(escalationJobs()).toHaveLength(1);
        expect(row.responseState).toBe('ESCALATED');
    });

    it('escalates a response whose owning job dead-lettered', async () => {
        addMessage({ responseJobId: 'owner-job-1' });
        jobs.push({ id: 'owner-job-1', status: 'DEAD_LETTER' });

        const result = await handlePendingResponseSweep({}, makeContext());

        expect(result.data).toMatchObject({ escalated: 1, skippedLiveOwner: 0 });
        expect(escalationJobs()).toHaveLength(1);
    });

    it('carries the reason the response already recorded, when it has one', async () => {
        addMessage({ escalationRequiredReason: 'Low AI confidence (12%) — automated escalation' });

        await handlePendingResponseSweep({}, makeContext());

        expect(escalationJobs()[0].payload).toMatchObject({
            ticketId: 'tkt-1',
            reason: 'Low AI confidence (12%) — automated escalation',
        });
    });

    it('reports the last delivery error in its own reason when none was recorded', async () => {
        addMessage({ responseError: 'discord 503', ticketSource: 'GITHUB_ISSUE' });

        await handlePendingResponseSweep({}, makeContext());

        const reason = (escalationJobs()[0].payload as { reason: string }).reason;
        expect(reason).toContain('GITHUB_ISSUE');
        expect(reason).toContain('discord 503');
    });

    // ── Leaving things alone ────────────────────────────────────────────────

    it('leaves a response younger than the stranded threshold alone', async () => {
        const row = addMessage({ createdAt: ago(STRANDED_RESPONSE_AFTER_MS - 60_000) });

        const result = await handlePendingResponseSweep({}, makeContext());

        expect(result.data).toMatchObject({ scanned: 0, escalated: 0 });
        expect(escalationJobs()).toHaveLength(0);
        expect(row.responseState).toBe('PENDING');
    });

    it('leaves a response inside the delayed-takeover window alone', async () => {
        // The window the owning job's retry schedules its takeover check in. A
        // sweep that fired here would double-escalate alongside that takeover.
        const row = addMessage({ createdAt: ago(RESPONSE_RECOVERY_AFTER_MS) });

        await handlePendingResponseSweep({}, makeContext());

        expect(escalationJobs()).toHaveLength(0);
        expect(row.responseState).toBe('PENDING');
    });

    it('has a threshold strictly beyond the takeover delay', () => {
        expect(STRANDED_RESPONSE_AFTER_MS).toBeGreaterThan(RESPONSE_RECOVERY_AFTER_MS);
    });

    it.each(['PENDING', 'PROCESSING'])(
        'leaves an old response alone while its owning job is still %s',
        async (status) => {
            const row = addMessage({ responseJobId: 'owner-job-7' });
            jobs.push({ id: 'owner-job-7', status });

            const result = await handlePendingResponseSweep({}, makeContext());

            expect(result.data).toMatchObject({ scanned: 1, skippedLiveOwner: 1, escalated: 0 });
            expect(escalationJobs()).toHaveLength(0);
            expect(row.responseState).toBe('PENDING');
        },
    );

    it.each(['DELIVERED', 'ESCALATED'])('never touches a %s response', async (state) => {
        const row = addMessage({ responseState: state });

        const result = await handlePendingResponseSweep({}, makeContext());

        expect(result.data).toMatchObject({ scanned: 0 });
        expect(escalationJobs()).toHaveLength(0);
        expect(row.responseState).toBe(state);
    });

    it('ignores AI responses that never claimed the primary-response slot', async () => {
        // Only the keyed primary response carries the state machine. A legacy or
        // non-primary row must not even be scanned — the escalation CAS also
        // filters on responseKey, so sweeping one in would look like a response
        // that refused to settle and would fail the whole sweep.
        const row = addMessage({ responseKey: null });

        const result = await handlePendingResponseSweep({}, makeContext());

        expect(result.success).toBe(true);
        expect(result.data).toMatchObject({ scanned: 0, failed: 0 });
        expect(escalationJobs()).toHaveLength(0);
        expect(row.responseState).toBe('PENDING');
    });

    // ── Confirmed delivery ──────────────────────────────────────────────────

    it('repairs a confirmed delivery to DELIVERED instead of summoning a human', async () => {
        const row = addMessage({
            deliveryConfirmed: true,
            responseError: 'Delivery succeeded but the DELIVERED state write failed: boom',
        });

        const result = await handlePendingResponseSweep({}, makeContext());

        expect(result.data).toMatchObject({ repaired: 1, escalated: 0 });
        expect(escalationJobs()).toHaveLength(0);
        expect(row.responseState).toBe('DELIVERED');
        expect(row.responseError).toBeNull();
    });

    // ── Idempotency ─────────────────────────────────────────────────────────

    it('escalates once across two consecutive sweeps', async () => {
        const row = addMessage();

        const first = await handlePendingResponseSweep({}, makeContext());
        const second = await handlePendingResponseSweep({}, makeContext());

        expect(first.data).toMatchObject({ escalated: 1 });
        // The first sweep moved the row out of PENDING, so the second sweep's
        // query does not even see it.
        expect(second.success).toBe(true);
        expect(second.data).toMatchObject({ scanned: 0, escalated: 0, failed: 0 });
        expect(escalationJobs()).toHaveLength(1);
        expect(row.responseState).toBe('ESCALATED');
    });

    it('does not double-escalate when the row settles between the read and the write', async () => {
        const row = addMessage();
        // Another actor escalates after this sweep has already read the row —
        // the compare-and-set must find the row outside PENDING and no-op.
        settleAfterRead(row, 'ESCALATED');

        const result = await handlePendingResponseSweep({}, makeContext());

        expect(result.success).toBe(true);
        expect(result.data).toMatchObject({ escalated: 0, alreadySettled: 1, failed: 0 });
        expect(escalationJobs()).toHaveLength(0);
    });

    it('fails when a no-op escalation finds DELIVERED with an owed-escalation marker', async () => {
        const reason = 'Low AI confidence (12%) — automated escalation';
        const row = addMessage({ escalationRequiredReason: reason });
        settleAfterRead(row, 'DELIVERED', reason);

        const result = await handlePendingResponseSweep({}, makeContext());

        expect(result.success).toBe(false);
        expect(result.error).toContain('could not be settled');
        expect(result.data).toBeUndefined();
        expect(escalationJobs()).toHaveLength(0);
        expect(row.escalationRequiredReason).toBe(reason);
        expect(fakeMessage.findUnique).toHaveBeenCalledWith({
            where: { id: row.id },
            select: { responseState: true, escalationRequiredReason: true },
        });
    });

    it('accepts a no-op escalation when DELIVERED has no owed-escalation marker', async () => {
        const row = addMessage({
            escalationRequiredReason: 'Low AI confidence (12%) — automated escalation',
        });
        settleAfterRead(row, 'DELIVERED');

        const result = await handlePendingResponseSweep({}, makeContext());

        expect(result.success).toBe(true);
        expect(result.data).toMatchObject({ escalated: 0, alreadySettled: 1, failed: 0 });
        expect(escalationJobs()).toHaveLength(0);
    });

    // ── Failure handling ────────────────────────────────────────────────────

    it('fails the job when a stranded response could not be settled', async () => {
        const row = addMessage();
        // The compare-and-set reports no-op but the row is still PENDING: the
        // promised human handoff was never made, so this must not be swallowed.
        fakeMessage.updateMany.mockResolvedValueOnce({ count: 0 } as never);

        const result = await handlePendingResponseSweep({}, makeContext());

        expect(result.success).toBe(false);
        expect(result.error).toContain('could not be settled');
        expect(row.responseState).toBe('PENDING');
    });

    it('settles the rest of the batch when one response throws', async () => {
        const doomed = addMessage({ createdAt: ago(STRANDED_RESPONSE_AFTER_MS * 3) });
        const healthy = addMessage({ ticketId: 'tkt-2' });
        failingUpdates.add(doomed.id);

        const result = await handlePendingResponseSweep({}, makeContext());

        expect(result.success).toBe(false);
        expect(result.data).toBeUndefined();
        expect(healthy.responseState).toBe('ESCALATED');
        expect(escalationJobs()).toHaveLength(1);
    });

    it('succeeds with an empty summary when nothing is stranded', async () => {
        const result = await handlePendingResponseSweep({}, makeContext());

        expect(result.success).toBe(true);
        expect(result.data).toMatchObject({ scanned: 0, escalated: 0, repaired: 0 });
        expect(fakeJob.findMany).not.toHaveBeenCalled();
    });

    it('fails loudly when the database clock is unavailable', async () => {
        fakePrisma.$queryRaw.mockResolvedValueOnce([] as never);

        const result = await handlePendingResponseSweep({}, makeContext());

        expect(result.success).toBe(false);
        expect(result.error).toContain('database clock unavailable');
    });

    it('measures the cutoff from the database clock, not the worker clock', async () => {
        // A worker whose clock runs an hour fast must not be able to declare a
        // fresh response stranded.
        dbNow = NOW;
        const row = addMessage({ createdAt: ago(60_000) });

        await handlePendingResponseSweep({}, makeContext());

        expect(fakePrisma.$queryRaw).toHaveBeenCalled();
        expect(row.responseState).toBe('PENDING');
    });

    it('bounds each run to the batch size', async () => {
        for (let i = 0; i < SWEEP_BATCH_SIZE + 5; i += 1) {
            addMessage({ ticketId: `tkt-${i}` });
        }

        const result = await handlePendingResponseSweep({}, makeContext());

        expect(result.data).toMatchObject({ scanned: SWEEP_BATCH_SIZE });
        expect(escalationJobs()).toHaveLength(SWEEP_BATCH_SIZE);
    });
});
