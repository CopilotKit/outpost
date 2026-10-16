/**
 * PENDING_RESPONSE_SWEEP job handler.
 *
 * The backstop for the primary-AI-response state machine in
 * handlers/ai-response.ts. That machine drives PENDING -> DELIVERED | ESCALATED
 * entirely from the AI_RESPONSE job that owns the response: a failed delivery
 * leaves the row PENDING and relies on a retry to schedule a delayed takeover,
 * and a takeover that finds the row still PENDING summons a human.
 *
 * Every one of those steps needs the owning job to run again. AI_RESPONSE jobs
 * carry MAX_JOB_ATTEMPTS, and a platform delivery failure is exactly the kind of
 * error that exhausts them — so the job that owed the reporter a human can
 * dead-letter. Nothing else read responseState, which meant such a response sat
 * PENDING forever: no repost, no escalation, no human, and a reporter left in
 * silence. That is precisely the failure the state machine exists to prevent, so
 * the machine needs an owner of last resort that is not the job itself.
 *
 * This sweep is that owner. It runs on the scheduler, finds primary responses
 * stranded in PENDING with no live job left to advance them, and settles each
 * one the same way the owning job would have:
 *
 *   - an owed handoff    -> escalate to a human, keeping the reason the response
 *                           already recorded in escalationRequiredReason over
 *                           this sweep's generic one. First, because the promise
 *                           of a human is what kept the row PENDING: repairing
 *                           it to DELIVERED on the strength of the flag below
 *                           would drop that promise AND leave its marker on a
 *                           settled row, a pair no path can act on.
 *   - deliveryConfirmed  -> repair to DELIVERED. The platform post is a proven
 *                           fact; only the state write failed. Escalating here
 *                           would summon a human for an already-answered
 *                           reporter, so this precedence mirrors the owning
 *                           handler's prior-response gate exactly.
 *   - anything else      -> escalate to a human with this sweep's generic reason.
 *
 * It never regenerates and never reposts, so the one-response-per-ticket rule
 * holds. Escalation goes through enqueueEscalationAtomically — the single
 * escalation path — rather than a second hand-rolled transition.
 */

import { prisma } from '@copilotkit/outpost/db';
import {
    PRIMARY_AI_RESPONSE_KEY,
    RESPONSE_RECOVERY_AFTER_MS,
    enqueueEscalationAtomically,
    recoveredHandoffReason,
} from './ai-response.js';
import { JobType } from '../types.js';
import type { PendingResponseSweepPayload, JobResult, JobHandlerContext } from '../types.js';

/**
 * How old a PENDING primary response must be before this sweep will touch it.
 *
 * The number has to clear the owning job's own recovery mechanism, or the sweep
 * races it and the reporter gets escalated twice. The longest legitimate time a
 * response spends PENDING with a live owner is RESPONSE_RECOVERY_AFTER_MS — the
 * delay on the takeover job the owning handler schedules — plus that job's retry
 * ladder, which is seconds (BACKOFF_BASE_MS 1s doubling over MAX_JOB_ATTEMPTS 5,
 * so under a minute in total). Four times the takeover delay leaves roughly 15
 * minutes of headroom past the last moment a live owner could still act.
 *
 * Age alone is only the outer guard, and deliberately so: it is a heuristic over
 * wall-clock time and a slow queue could stretch past any constant. The
 * authoritative check is the live-owner test below, which reads the owning job's
 * status directly. Both must pass.
 */
export const STRANDED_RESPONSE_AFTER_MS = 4 * RESPONSE_RECOVERY_AFTER_MS;

/**
 * Cap on responses settled per run. A sweep that has fallen far behind should
 * make steady progress on a bounded amount of work rather than open one
 * unbounded transaction storm; the next scheduled run picks up the remainder.
 */
export const SWEEP_BATCH_SIZE = 200;

/** Job statuses that mean the owning job can still advance the response itself. */
const LIVE_JOB_STATUSES = ['PENDING', 'PROCESSING'] as const;

interface StrandedResponse {
    id: string;
    ticketId: string;
    responseJobId: string | null;
    responseError: string | null;
    escalationRequiredReason: string | null;
    deliveryConfirmed: boolean;
    ticket: { source: string };
}

/**
 * The set of responseJobIds whose job row is still PENDING or PROCESSING.
 *
 * A response whose owning job is live must be left completely alone — that job,
 * or the delayed takeover it scheduled, is about to settle the row, and this is
 * the check that makes "does not race the owning job" a fact rather than a bet
 * on the age threshold. Note which way the absence of a job row falls: no live
 * row means not live. A dead-lettered job, or one already reaped by JOB_CLEANUP,
 * both leave the response with no owner, which is the whole point of this sweep.
 */
async function findLiveOwnerJobIds(responses: StrandedResponse[]): Promise<Set<string>> {
    const ownerIds = [
        ...new Set(responses.flatMap((r) => (r.responseJobId ? [r.responseJobId] : []))),
    ];
    if (ownerIds.length === 0) return new Set();

    const liveJobs = await prisma.job.findMany({
        where: { id: { in: ownerIds }, status: { in: [...LIVE_JOB_STATUSES] } },
        select: { id: true },
    });
    return new Set(liveJobs.map((job) => job.id));
}

/**
 * Settle one stranded response, returning which bucket it landed in.
 *
 * `escalated: false` from enqueueEscalationAtomically is not an error on its own
 * — the compare-and-set legitimately reports no-op when the row left PENDING
 * between the sweep's read and its write, which is exactly what makes a second
 * sweep over the same response harmless. But it is only benign if the row
 * actually settled: DELIVERED with no owed-escalation marker or ESCALATED means
 * someone got there first. A retained marker on DELIVERED, a row still PENDING,
 * or an unreadable/missing row leaves this sweep's handoff unaccounted for.
 * Discarding that distinction would recreate the bug this handler exists to
 * fix, one level up.
 */
async function settleStrandedResponse(
    response: StrandedResponse,
): Promise<'repaired' | 'escalated' | 'alreadySettled' | 'failed'> {
    // Delivery proof only settles a row that owes nothing else. A response
    // still carrying its handoff marker is PENDING *because* of that marker, so
    // the repair below would answer the wrong question about it.
    if (!response.escalationRequiredReason && response.deliveryConfirmed) {
        await prisma.message.updateMany({
            where: {
                id: response.id,
                responseKey: PRIMARY_AI_RESPONSE_KEY,
                responseState: 'PENDING',
            },
            data: { responseState: 'DELIVERED', responseError: null },
        });
        return 'repaired';
    }

    const deliveryDetail = response.responseError
        ? `Last recorded error: ${response.responseError}.`
        : 'The job that owned it stopped before delivery became durable.';
    const reason = response.escalationRequiredReason
        ? // The owning handler composes this the same way, so a response that
          // reaches a human through the sweep instead of through a takeover
          // reads identically.
          recoveredHandoffReason({
              owedReason: response.escalationRequiredReason,
              ticketSource: response.ticket.source,
              deliveryConfirmed: response.deliveryConfirmed,
              responseError: response.responseError,
          })
        : `AI response for ${response.ticket.source} was left pending with no job left to finish it. ` +
          `${deliveryDetail} A human must verify the thread and answer if needed.`;

    const escalated = await enqueueEscalationAtomically(response.ticketId, response.id, reason);
    if (escalated) return 'escalated';

    const settled = await prisma.message.findUnique({
        where: { id: response.id },
        select: { responseState: true, escalationRequiredReason: true },
    });
    if (
        (settled?.responseState === 'DELIVERED' && settled.escalationRequiredReason === null) ||
        settled?.responseState === 'ESCALATED'
    ) {
        return 'alreadySettled';
    }

    console.error(
        `[PendingResponseSweep] Response ${response.id} on ticket ${response.ticketId} could not ` +
            `be escalated and did not settle — state is ${settled?.responseState ?? 'missing'}` +
            (settled?.escalationRequiredReason != null
                ? `; owed-escalation marker remains (${settled.escalationRequiredReason}) — needs manual attention`
                : ''),
    );
    return 'failed';
}

export async function handlePendingResponseSweep(
    _payload: PendingResponseSweepPayload,
    context: JobHandlerContext,
): Promise<JobResult> {
    await context.reportProgress(10);

    // The cutoff comes off the database clock, not this worker's, for the same
    // reason the delayed takeover in ai-response.ts takes its base time from
    // CURRENT_TIMESTAMP: a skewed worker must not be able to declare a response
    // stranded before its owner has had its full window.
    const [clock] = await prisma.$queryRaw<Array<{ now: Date }>>`
        SELECT CURRENT_TIMESTAMP AS "now"
    `;
    if (!clock) {
        return { success: false, error: 'PENDING_RESPONSE_SWEEP: database clock unavailable' };
    }
    const strandedBefore = new Date(clock.now.getTime() - STRANDED_RESPONSE_AFTER_MS);

    const candidates = (await prisma.message.findMany({
        where: {
            responseKey: PRIMARY_AI_RESPONSE_KEY,
            responseState: 'PENDING',
            createdAt: { lt: strandedBefore },
        },
        select: {
            id: true,
            ticketId: true,
            responseJobId: true,
            responseError: true,
            escalationRequiredReason: true,
            deliveryConfirmed: true,
            ticket: { select: { source: true } },
        },
        orderBy: { createdAt: 'asc' },
        take: SWEEP_BATCH_SIZE,
    })) as StrandedResponse[];

    await context.reportProgress(30);

    if (candidates.length === 0) {
        await context.reportProgress(100);
        return {
            success: true,
            data: { scanned: 0, skippedLiveOwner: 0, repaired: 0, escalated: 0, failed: 0 },
        };
    }

    const liveOwnerJobIds = await findLiveOwnerJobIds(candidates);

    let skippedLiveOwner = 0;
    let repaired = 0;
    let escalated = 0;
    let alreadySettled = 0;
    let failed = 0;

    for (const response of candidates) {
        if (response.responseJobId && liveOwnerJobIds.has(response.responseJobId)) {
            skippedLiveOwner += 1;
            continue;
        }

        // Per-response isolation: one unreachable row must not abandon the rest
        // of the batch, since every other stranded response is its own silent
        // reporter. The failure is counted and surfaced in the job result.
        try {
            const outcome = await settleStrandedResponse(response);
            if (outcome === 'repaired') repaired += 1;
            else if (outcome === 'escalated') escalated += 1;
            else if (outcome === 'alreadySettled') alreadySettled += 1;
            else failed += 1;
        } catch (error) {
            failed += 1;
            console.error(
                `[PendingResponseSweep] Failed to settle response ${response.id} on ticket ${response.ticketId}:`,
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    await context.reportProgress(100);

    console.log(
        `[PendingResponseSweep] Scanned ${candidates.length} stranded response(s): ` +
            `${escalated} escalated, ${repaired} repaired to DELIVERED, ` +
            `${alreadySettled} already settled, ${skippedLiveOwner} skipped (live owner), ${failed} failed`,
    );

    // Report failures so the queue retries the sweep. Retrying is safe: the
    // compare-and-set makes the responses this run already settled no-ops.
    if (failed > 0) {
        return {
            success: false,
            error:
                `${JobType.PENDING_RESPONSE_SWEEP}: ${failed} of ${candidates.length} stranded ` +
                `response(s) could not be settled — reporters are still owed a human`,
        };
    }

    return {
        success: true,
        data: {
            scanned: candidates.length,
            skippedLiveOwner,
            repaired,
            escalated,
            alreadySettled,
            failed,
        },
    };
}
