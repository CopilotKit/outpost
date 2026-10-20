/**
 * AI_RESPONSE job handler.
 *
 * The most critical handler in Outpost. Processes AI_RESPONSE jobs by:
 *   1.  Loading the ticket and its messages from the database
 *   1b. Finishing immediately, as a success, if the ticket already holds an AI
 *       response — one response per ticket (see the gate below)
 *   2.  Running the AI pipeline to generate a support response
 *   3.  Classifying the ticket inline (priority, type, tags)
 *   4.  Formatting the response for the source platform
 *   5.  Persisting the AI response as a Message record, and the formatted text
 *       on the ticket as suggestedResponse
 *   5b. Posting the response back to the source platform through its adapter —
 *       except under SHADOW_MODE=true, where the response is instead logged as a
 *       SYSTEM message on the ticket and nothing is posted anywhere
 *   6.  Enqueuing an ESCALATION job if confidence is too low, if the pipeline
 *       suppressed an ungrounded draft, or if the response never reached the
 *       reporter because platform delivery failed
 *
 * The BOT Message starts in PENDING before any external post. Successful
 * delivery with no human handoff marks it DELIVERED; a response that requires
 * escalation stays PENDING until that job is durable, then becomes ESCALATED.
 * If delivery itself ends PENDING, a retry schedules a delayed check. That
 * check pulls in a human only if the response remains pending, preserving the
 * one-post rule without racing the original handler.
 *
 * Every transition above is driven by the job that owns the response, so none of
 * it survives that job dead-lettering. PENDING_RESPONSE_SWEEP
 * (handlers/pending-response-sweep.ts) is the backstop that does: it sweeps
 * responses left PENDING with no live owner and settles them.
 *
 * The pipeline itself handles Pathfinder retrieval, Claude generation,
 * confidence scoring, platform-specific formatting, and the groundedness gate —
 * so what it hands back is always safe to publish (see SUPPRESSED_RESPONSE_TEXT
 * in packages/outpost/ai/src/pipeline.ts). This handler does not re-check it.
 */

import { prisma } from '@copilotkit/outpost/db';
import { AIPipeline } from '@copilotkit/outpost/ai';
import { AI_CONFIDENCE, MAX_JOB_ATTEMPTS } from '@copilotkit/outpost/shared';
import type { PlatformTarget, TicketSource } from '@copilotkit/outpost/shared';
import {
    hasAdapter,
    getAdapter,
    readSlackMirrorConfig,
    isSlackMirrorEnabled,
    isMirrorableSource,
} from '@copilotkit/outpost/shared/platforms';
import { createJob } from '../create-job.js';
import { getFeedbackCalibration } from '../feedback-calibration.js';
import { JobType } from '../types.js';
import type {
    AiResponsePayload,
    JobResult,
    JobHandlerContext,
    SlackMirrorDelivery,
} from '../types.js';

export const PRIMARY_AI_RESPONSE_KEY = 'PRIMARY_AI_RESPONSE';
/**
 * How long after a PENDING delivery the owning job's retry schedules its
 * delayed takeover check. Exported because the PENDING_RESPONSE_SWEEP handler
 * derives its "stranded" threshold from it: the sweeper must never fire while a
 * takeover this mechanism already scheduled is still owed a chance to run.
 */
export const RESPONSE_RECOVERY_AFTER_MS = 5 * 60 * 1000;

interface StoredAiResponse {
    id: string;
    type: string;
    isAiGenerated: boolean;
    responseKey?: string | null;
    responseState?: string | null;
    responseJobId?: string | null;
    responseError?: string | null;
    deliveryConfirmed?: boolean | null;
    escalationRequiredReason?: string | null;
}

/**
 * Identify the unique-key collision raised when another handler wins the
 * per-ticket primary-response slot. Keep this narrow: an unrelated P2002 must
 * still fail the job rather than being mislabeled as a harmless duplicate.
 */
function isPrimaryAiResponseConflict(error: unknown): boolean {
    if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        (error as { code?: unknown }).code !== 'P2002'
    ) {
        return false;
    }

    const target = (error as { meta?: { target?: unknown } }).meta?.target;
    if (Array.isArray(target)) {
        return target.includes('ticketId') && target.includes('responseKey');
    }

    return (
        typeof target === 'string' &&
        (target === 'Message_ticketId_responseKey_key' ||
            (target.includes('ticketId') && target.includes('responseKey')))
    );
}

/**
 * True when the platform post is a proven fact even though responseState never
 * made it out of PENDING. A dedicated flag rather than a prefix in
 * responseError: that column is read as error text, and "the reporter has their
 * answer" is the opposite of an error.
 */
function hasConfirmedDelivery(response: StoredAiResponse): boolean {
    return response.deliveryConfirmed === true;
}

/**
 * Commit the PENDING -> ESCALATED transition and its queue row together.
 *
 * updateMany is the compare-and-set. PostgreSQL serializes concurrent updates
 * to the same message row, so exactly one transaction observes PENDING. Creating
 * the job after that CAS inside the same transaction means an insert failure
 * rolls the state change back and leaves the response retryable.
 *
 * This is the ONE escalation path for a primary AI response — the
 * PENDING_RESPONSE_SWEEP handler calls it too rather than transitioning the row
 * itself, which is also what makes repeated sweeps idempotent: the second caller
 * finds the row outside PENDING and gets `false`. A `false` return is therefore
 * a legitimate, expected outcome and never a silent success; every caller must
 * inspect the state the row settled in before reporting the handoff handled.
 */
export async function enqueueEscalationAtomically(
    ticketId: string,
    responseId: string,
    reason: string,
): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
        const transition = await tx.message.updateMany({
            where: {
                id: responseId,
                responseKey: PRIMARY_AI_RESPONSE_KEY,
                responseState: 'PENDING',
            },
            // The handoff is durable as of this transaction, so the "owed"
            // marker is cleared with it.
            //
            // responseError is deliberately LEFT ALONE. The escalation that most
            // needs a diagnostic is the one caused by a delivery failure, and
            // that failure text was written to responseError moments earlier by
            // the delivery path — clearing it here destroyed the only record of
            // WHY the reporter never got an answer, at exactly the moment a
            // human is asked to pick the thread up. The schema documents the
            // column as "last real delivery/bookkeeping error text" for retry
            // recovery, recoverPendingResponse renders it into the escalation
            // reason, and no code path reads it as lifecycle state (proven by
            // the spoofed-marker tests), so keeping it costs nothing and losing
            // it costs the diagnostic.
            data: {
                responseState: 'ESCALATED',
                escalationRequiredReason: null,
            },
        });

        if (transition.count !== 1) return false;

        await tx.job.create({
            data: {
                type: JobType.ESCALATION,
                payload: JSON.parse(JSON.stringify({ ticketId, reason })),
                maxAttempts: MAX_JOB_ATTEMPTS,
                // Omit runAt so the database's now() default, rather than the
                // worker clock, makes the job immediately eligible.
            },
        });
        return true;
    });
}

/**
 * The human handoff this response promised but has not yet made durable.
 *
 * One nullable column carries both the fact and its payload, so the flag and the
 * reason cannot drift apart: non-null means "escalation owed", and the value is
 * the reason to enqueue. It is deliberately not a MessageResponseState value —
 * the response is still PENDING, which is the outcome the enum records.
 */
function requiredEscalationReason(response: StoredAiResponse): string | null {
    if (
        response.responseKey !== PRIMARY_AI_RESPONSE_KEY ||
        response.responseState !== 'PENDING' ||
        !response.escalationRequiredReason
    ) {
        return null;
    }
    return response.escalationRequiredReason;
}

/**
 * Decide what a recovery attempt reports when its escalation compare-and-set
 * queued nothing.
 *
 * `enqueueEscalationAtomically` returns false — it does not throw — when the CAS
 * matched no rows, which means NO escalation job was created. Reporting the raw
 * boolean as `escalated` and still returning success drops the owed human
 * handoff silently, so the row's own responseState decides instead, exactly as
 * the main enqueue site does:
 *
 *   - DELIVERED — the reporter has a durable answer and no handoff was owed.
 *     Honest success, and the premise of both recovery paths (a response stuck
 *     PENDING) no longer holds, so neither `escalated` nor `deliveryFailed` may
 *     be asserted and the outcome is reported as an ordinary already-answered
 *     skip.
 *   - ESCALATED — another actor already summoned the human. Success with
 *     `escalated: true`; the recovery reason still describes what was repaired.
 *   - anything else (still PENDING, row gone, state unreadable) — a reporter was
 *     promised a human who was never summoned. Fail loudly.
 *
 * Failing is safe here even though these are already retry paths: the worker
 * caps every job at maxAttempts (MAX_JOB_ATTEMPTS) and then moves it to
 * DEAD_LETTER with the error text attached, so a permanently unqueueable
 * escalation surfaces as a visible dead-lettered job instead of looping forever.
 * A silent `success: true` is the one outcome with no bound on the damage —
 * nothing retries it and nothing records that the handoff is missing.
 */
async function reportSkippedRecoveryEscalation(options: {
    ticketId: string;
    response: StoredAiResponse;
    reason: string;
    /** `data.reason` to report when the handoff turns out to be durable. */
    recoveredReason: string;
    /** `data.deliveryFailed` for that same case. */
    deliveryFailed: boolean;
    context: JobHandlerContext;
}): Promise<JobResult> {
    const { ticketId, response, reason, recoveredReason, deliveryFailed, context } = options;

    let settledState: string | null = null;
    let stateReadError: string | null = null;
    try {
        const settled = await prisma.message.findUnique({
            where: { id: response.id },
            select: { responseState: true },
        });
        settledState = settled?.responseState ?? null;
    } catch (error) {
        stateReadError = error instanceof Error ? error.message : String(error);
    }

    console.warn(
        `[AI Response] Ticket ${ticketId}: recovery escalation (${reason}) was not queued — ` +
            `response row state is ${settledState ?? 'unavailable'}` +
            `${stateReadError ? ` (${stateReadError})` : ''}`,
    );

    if (settledState !== 'ESCALATED' && settledState !== 'DELIVERED') {
        const observed = stateReadError
            ? `unreadable (${stateReadError})`
            : (settledState ?? 'missing');
        return {
            success: false,
            error:
                `Ticket ${ticketId}: required escalation (${reason}) was not queued — ` +
                `response state is ${observed} — needs manual attention`,
        };
    }

    await context.reportProgress(100);
    if (settledState === 'DELIVERED') {
        return {
            success: true,
            data: {
                ticketId,
                skipped: true,
                escalated: false,
                deliveryFailed: false,
                reason: 'already_answered',
            },
        };
    }
    return {
        success: true,
        data: {
            ticketId,
            skipped: true,
            escalated: true,
            deliveryFailed,
            reason: recoveredReason,
        },
    };
}

async function recoverRequiredEscalation(
    ticketId: string,
    response: StoredAiResponse,
    reason: string,
    context: JobHandlerContext,
): Promise<JobResult> {
    let escalationEnqueued: boolean;
    try {
        escalationEnqueued = await enqueueEscalationAtomically(ticketId, response.id, reason);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            success: false,
            error: `Ticket ${ticketId}: required escalation retry could not enqueue (${message})`,
        };
    }

    if (!escalationEnqueued) {
        return reportSkippedRecoveryEscalation({
            ticketId,
            response,
            reason,
            recoveredReason: 'escalation_recovered',
            deliveryFailed: false,
            context,
        });
    }

    await context.reportProgress(100);
    return {
        success: true,
        data: {
            ticketId,
            skipped: true,
            escalated: true,
            deliveryFailed: false,
            reason: 'escalation_recovered',
        },
    };
}

async function recoverPendingResponse(
    ticketId: string,
    ticketSource: string,
    response: StoredAiResponse,
    context: JobHandlerContext,
): Promise<JobResult> {
    const deliveryDetail = response.responseError
        ? `Last delivery error: ${response.responseError}.`
        : 'The previous attempt ended before delivery became durable.';
    const reason =
        `AI response for ${ticketSource} is pending after an interrupted attempt. ` +
        `${deliveryDetail} A human must verify the thread and answer if needed.`;

    let escalationEnqueued: boolean;
    try {
        escalationEnqueued = await enqueueEscalationAtomically(ticketId, response.id, reason);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            success: false,
            error: `Ticket ${ticketId}: pending AI response recovery could not enqueue escalation (${message})`,
        };
    }

    if (!escalationEnqueued) {
        return reportSkippedRecoveryEscalation({
            ticketId,
            response,
            reason,
            recoveredReason: 'delivery_recovered',
            deliveryFailed: true,
            context,
        });
    }

    await context.reportProgress(100);
    return {
        success: true,
        data: {
            ticketId,
            skipped: true,
            escalated: true,
            deliveryFailed: true,
            reason: 'delivery_recovered',
        },
    };
}

async function schedulePendingResponseRecovery(
    payload: AiResponsePayload,
    response: StoredAiResponse,
    context: JobHandlerContext,
): Promise<JobResult> {
    let recoveryJobId: string;
    try {
        recoveryJobId = await prisma.$transaction(async (tx) => {
            const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`
                SELECT CURRENT_TIMESTAMP AS "now"
            `;
            if (!clock) throw new Error('database clock unavailable');

            const recoveryPayload: AiResponsePayload = {
                ...payload,
                pendingResponseRecovery: { messageId: response.id },
            };
            const recoveryJob = await tx.job.create({
                data: {
                    type: JobType.AI_RESPONSE,
                    payload: JSON.parse(JSON.stringify(recoveryPayload)),
                    maxAttempts: MAX_JOB_ATTEMPTS,
                    runAt: new Date(clock.now.getTime() + RESPONSE_RECOVERY_AFTER_MS),
                },
            });

            const transfer = await tx.message.updateMany({
                where: {
                    id: response.id,
                    responseKey: PRIMARY_AI_RESPONSE_KEY,
                    responseState: 'PENDING',
                    responseJobId: context.jobId,
                },
                data: { responseJobId: recoveryJob.id },
            });
            if (transfer.count !== 1) {
                // Throwing rolls the just-created recovery job back too.
                throw new PendingRecoveryClaimLostError();
            }
            return recoveryJob.id;
        });
    } catch (error) {
        if (error instanceof PendingRecoveryClaimLostError) {
            await context.reportProgress(100);
            return {
                success: true,
                data: { ticketId: payload.ticketId, skipped: true, reason: 'already_answered' },
            };
        }
        const message = error instanceof Error ? error.message : String(error);
        return {
            success: false,
            error: `Ticket ${payload.ticketId}: delayed AI response recovery could not be scheduled (${message})`,
        };
    }

    await context.reportProgress(100);
    return {
        success: true,
        data: {
            ticketId: payload.ticketId,
            skipped: true,
            recoveryScheduled: true,
            recoveryJobId,
            reason: 'delivery_recovery_scheduled',
        },
    };
}

class PendingRecoveryClaimLostError extends Error {}

/**
 * Map from TicketSource enum values (stored in DB) to PlatformTarget
 * strings used by the AI formatter. TicketSource uses uppercase enums
 * (e.g. 'DISCORD') while PlatformTarget uses lowercase literals
 * (e.g. 'discord').
 */
function toPlatformTarget(source: string): PlatformTarget {
    const mapping: Record<string, PlatformTarget> = {
        DISCORD: 'discord',
        GITHUB_ISSUE: 'github',
        GITHUB_DISCUSSION: 'github',
        SLACK: 'slack',
        TEAMS: 'teams',
        WEB: 'web',
        EMAIL: 'web',
        LINEAR: 'web',
        MANUAL: 'web',
        ORCA: 'web',
    };
    return mapping[source] ?? 'web';
}

export async function handleAiResponse(
    payload: AiResponsePayload,
    context: JobHandlerContext,
): Promise<JobResult> {
    const { ticketId } = payload;

    await context.reportProgress(10);

    // 1. Load ticket with account, user, and messages
    const ticket = await prisma.ticket.findUnique({
        where: { id: ticketId },
        include: {
            account: true,
            user: true,
            messages: { orderBy: { createdAt: 'asc' } },
        },
    });

    if (!ticket) {
        return {
            success: false,
            error: `Ticket ${ticketId} not found`,
        };
    }

    await context.reportProgress(20);

    // 1b. ONE RESPONSE PER TICKET — RE-ANSWER guard.
    //
    // Outpost answers exactly one message per ticket: the one that opened it.
    // Every later message in that thread gets no AI reply, no matter who sent
    // it — the original reporter, a third party, or a team member. The agent is
    // a first line of defence and a human owns the thread from the moment the
    // first response lands.
    //
    // What this gate does and does not do, because the distinction matters:
    //
    // The invariant is enforced at the enqueue sites, not here. Three of them
    // exist — InboundHandler.handleNewTicket (Discord, Slack and Teams all
    // funnel through it), handleShadowThreadCreate in the Discord bot's
    // shadow-mode path, and the Postmark webhook's new-email branch — and every
    // one enqueues only for a message that opens a ticket. Their refusal to
    // enqueue for anything else is what holds the rule.
    //
    // This gate catches the second answer to a ticket that already has one: a
    // retried job, a manual re-enqueue, or a caller added later that does not
    // respect the rule. It CANNOT stand in for those refusals, so do not lean
    // on it as if it could. It only sees messages on the ticket, so it cannot
    // tell a first answer from a first answer to the wrong message: a ticket
    // freshly minted around a mid-thread reply carries no prior AI response and
    // sails straight through here. That case (an orphaned reply, no ticket found
    // for the thread) is refused where the ticket is created — see
    // InboundHandler.handleReply.
    //
    // Success, not failure: the job did what it should — nothing. Returning an
    // error would put it through the retry ladder for a decision that will
    // never change.
    const generatedResponses = ticket.messages.filter(
        (m: StoredAiResponse) => m.type === 'BOT' && m.isAiGenerated,
    ) as StoredAiResponse[];
    // Recovery metadata lives on the keyed primary response. Older AI BOT rows
    // predate responseKey and still prove the ticket was answered, but must not
    // shadow a newer primary row whose delivery/escalation state needs repair.
    const priorAiResponse =
        generatedResponses.find((m) => m.responseKey === PRIMARY_AI_RESPONSE_KEY) ??
        generatedResponses[0];
    if (priorAiResponse) {
        // Order matters. The two PENDING sub-states now live in independent
        // columns, so nothing at the type level stops a row carrying both. An
        // owed human handoff is checked first because dropping it is the worse
        // failure: its transition also ends the PENDING state, and neither branch
        // ever reposts to the reporter.
        const escalationRetryReason = requiredEscalationReason(priorAiResponse);
        if (escalationRetryReason) {
            return recoverRequiredEscalation(
                ticketId,
                priorAiResponse,
                escalationRetryReason,
                context,
            );
        }

        // The responseKey guard matches the two branches below it: every
        // recovery in this gate repairs THE ticket's one primary response, and
        // priorAiResponse can be a non-primary AI BOT row (the `??
        // generatedResponses[0]` fallback above). Unreachable today — only this
        // handler writes deliveryConfirmed/responseState, and only ever on the
        // keyed primary row, so a legacy or non-primary BOT row carries the
        // column defaults (false/null) and cannot satisfy this condition — but a
        // future writer of those columns must not be able to get a non-primary
        // row promoted to "the ticket is answered, repair its state".
        if (
            priorAiResponse.responseKey === PRIMARY_AI_RESPONSE_KEY &&
            priorAiResponse.responseState === 'PENDING' &&
            hasConfirmedDelivery(priorAiResponse)
        ) {
            // The platform post succeeded; only the state mirror failed. Repair
            // it when possible, but never route an already-answered reporter to
            // a human merely because this bookkeeping write is still unhealthy.
            try {
                await prisma.message.update({
                    where: { id: priorAiResponse.id },
                    data: { responseState: 'DELIVERED', responseError: null },
                });
            } catch (error) {
                console.error(
                    `[AI Response] Confirmed delivery state still could not be repaired for ticket ${ticketId}:`,
                    error instanceof Error ? error.message : String(error),
                );
            }
            await context.reportProgress(100);
            return {
                success: true,
                data: { ticketId, skipped: true, reason: 'already_answered' },
            };
        }

        if (
            priorAiResponse.responseKey === PRIMARY_AI_RESPONSE_KEY &&
            priorAiResponse.responseState === 'PENDING' &&
            payload.pendingResponseRecovery?.messageId === priorAiResponse.id &&
            priorAiResponse.responseJobId === context.jobId
        ) {
            return recoverPendingResponse(ticketId, ticket.source, priorAiResponse, context);
        }
        if (
            priorAiResponse.responseKey === PRIMARY_AI_RESPONSE_KEY &&
            priorAiResponse.responseState === 'PENDING' &&
            priorAiResponse.responseJobId === context.jobId
        ) {
            return schedulePendingResponseRecovery(payload, priorAiResponse, context);
        }

        console.log(
            `[AI Response] Ticket ${ticketId} already answered — skipping. ` +
                `Outpost posts one response per ticket; a human owns this thread now.`,
        );
        // Walk the ladder to 100 like every other successful exit. This job
        // succeeded — it decided to do nothing — so anything reading job
        // progress (dashboard, ops query) must see it finished, not parked at
        // 20% looking hung. Failure exits deliberately leave progress where it
        // stopped: the job row records status FAILED next to it, so a partial
        // number is the honest reading there.
        await context.reportProgress(100);
        return {
            success: true,
            data: { ticketId, skipped: true, reason: 'already_answered' },
        };
    }

    // The question is the message that OPENED the ticket — the same message the
    // one-response-per-ticket invariant above says we get to answer.
    const openingUserMessage = ticket.messages.find((m: { type: string }) => m.type === 'USER');

    // 2. Build conversation context from every other non-SYSTEM message.
    //
    // AIPipeline ultimately appends `question` after `conversationHistory`, so
    // including the opening row here would send that question twice. Keep later
    // follow-ups as context, but let the explicit question carry the opener once.
    const conversationHistory = ticket.messages
        .filter((m: { type: string }) => m.type !== 'SYSTEM' && m !== openingUserMessage)
        .map((m: { type: string; content: string }) => ({
            role: (m.type === 'USER' ? 'user' : 'assistant') as 'user' | 'assistant',
            content: m.content,
        }));

    // `ticket.messages` is loaded `orderBy: { createdAt: 'asc' }`, so the FIRST
    // USER row is the opening message. Scanning from the other end and taking
    // the LATEST USER row was wrong: replies are still persisted as USER
    // messages (correctly — they belong in the thread's history), so a reporter
    // who splits a thought across two Discord messages in the seconds between
    // ticket creation and this job running had the ticket's one and only answer
    // aimed at the follow-up fragment instead of the question that opened it.
    // One shot, spent on the wrong sentence.
    //
    // The interim follow-up deliberately STAYS in `conversationHistory`. Those
    // two inputs answer different questions: `question` is what to respond to,
    // `conversationHistory` is what the responder knows. A follow-up is usually
    // the same thought continued — a stack trace, a version number, "on Next 15"
    // — and it is exactly the detail that makes the single answer good, so
    // dropping it would trade one bug for a worse answer. Suppressing it would
    // also need a second policy for the non-USER rows after the opening, with no
    // evidence behind it.
    const question = openingUserMessage?.content ?? ticket.description ?? ticket.title;

    // Determine platform target for formatting
    const platform = payload.source ?? toPlatformTarget(ticket.source);

    // 3. Run AI pipeline to generate response
    let pipeline: AIPipeline;
    try {
        pipeline = new AIPipeline();
    } catch (error) {
        return {
            success: false,
            error: `AI pipeline initialization failed: ${error instanceof Error ? error.message : String(error)}`,
        };
    }

    // Read the aggregate feedback calibration; never fail generation because
    // the tally couldn't be read (single fail-soft site).
    let confidenceCalibration = 0;
    try {
        confidenceCalibration = await getFeedbackCalibration(prisma);
    } catch (error) {
        console.error(
            `[AI Response] Failed to read feedback calibration, defaulting to 0: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    console.log(`[AI Response] Confidence calibration: ${confidenceCalibration.toFixed(4)}`);

    // Why the response never reached the reporter, when it didn't. Set by the
    // post-back arm below and consumed by the escalation step. If this attempt
    // cannot durably enqueue that escalation, the PENDING response lets its
    // retry schedule a safe delayed handoff without risking a second post.
    let deliveryFailure: string | null = null;
    // Set when any required ESCALATION enqueue fails. Delivery failures,
    // suppression, and low confidence all promise a human handoff, so none may
    // report success until that handoff is durable.
    let escalationEnqueueError: string | null = null;
    let escalationReason: string | null = null;
    // Whether this attempt's ESCALATION actually committed, and — when the
    // compare-and-set found the response row already outside PENDING — which
    // state it settled in. Read after the pipeline is torn down so the returned
    // `escalated` reports what happened to the row instead of restating the
    // local conditions that asked for an escalation.
    let escalationEnqueued = false;
    let escalationSkippedState: string | null = null;
    let escalationStateReadError: string | null = null;
    // Whether this attempt persisted an "escalation owed" marker on the response
    // row, and — if the row then turned out to be DELIVERED — whether clearing
    // that now-unactionable marker failed.
    let requiredEscalationRecorded = false;
    let orphanedEscalationMarkerError: string | null = null;

    let pipelineResult;
    try {
        try {
            pipelineResult = await pipeline.generateSupportResponse(question, {
                source: platform,
                conversationHistory,
                confidenceCalibration,
            });
        } catch (error) {
            return {
                success: false,
                error: `AI pipeline generation failed: ${error instanceof Error ? error.message : String(error)}`,
            };
        }

        await context.reportProgress(50);

        // 4. Classify ticket inline.
        //
        // Joined from the parts that exist rather than concatenated: `description`
        // is nullable, and `title + '\n' + ticket.description` stringified a null
        // into the literal text "null", which then went to the classifier as if
        // the reporter had typed it. An absent description contributes nothing.
        try {
            const classificationInput = [ticket.title, ticket.description]
                .filter((part): part is string => typeof part === 'string' && part.length > 0)
                .join('\n');
            const classification = await pipeline.classifyTicket(classificationInput);

            await prisma.ticket.update({
                where: { id: ticket.id },
                data: {
                    priority: classification.priority,
                    type: classification.type,
                },
            });
        } catch (error) {
            // Classification failure is non-fatal; log and continue
            console.error(
                `[AI Response] Classification failed for ticket ${ticketId}:`,
                error instanceof Error ? error.message : String(error),
            );
        }

        await context.reportProgress(70);

        // 5. Persist the AI-generated response and atomically claim this
        // ticket's one primary-response slot. The history check above avoids
        // unnecessary model work in the common case, but it cannot serialize
        // overlapping jobs: both can read the same no-response snapshot. The
        // database unique key on (ticketId, responseKey) elects exactly one
        // winner before either invocation reaches platform post-back.
        let aiMessage;
        try {
            const aiMessageData = {
                ticketId: ticket.id,
                content: pipelineResult.response,
                type: 'BOT' as const,
                author: 'Outpost AI',
                isAiGenerated: true,
                confidenceScore: pipelineResult.confidenceScore,
                confidenceLevel: pipelineResult.confidenceLevel,
                responseKey: PRIMARY_AI_RESPONSE_KEY,
                responseState: 'PENDING' as const,
                responseJobId: context.jobId,
                responseError: null,
            };
            aiMessage = await prisma.message.create({
                data: aiMessageData,
            });
        } catch (error) {
            if (!isPrimaryAiResponseConflict(error)) throw error;

            console.log(
                `[AI Response] Ticket ${ticketId} was answered by a concurrent job — skipping platform post-back.`,
            );
            await context.reportProgress(100);
            return {
                success: true,
                data: { ticketId, skipped: true, reason: 'already_answered' },
            };
        }

        // Store the formatted response on the ticket for bots to pick up.
        //
        // Non-fatal on purpose. The BOT Message row is already committed above,
        // so aborting here would turn the retry into delayed human recovery
        // rather than giving this attempt the chance to complete its intended
        // delivery. Log it, remember it, and keep going so delivery can happen.
        let suggestedResponseError: string | null = null;
        try {
            await prisma.ticket.update({
                where: { id: ticket.id },
                data: {
                    suggestedResponse: pipelineResult.formatted.text,
                },
            });
        } catch (error) {
            suggestedResponseError = error instanceof Error ? error.message : String(error);
            console.error(
                `[AI Response] Failed to store suggestedResponse for ticket ${ticketId}:`,
                suggestedResponseError,
            );
        }

        // 5b. Post the response back to the source platform — unconditionally.
        //
        // No suppression check here on purpose. The pipeline withholds an
        // ungrounded draft at the boundary: `pipelineResult.formatted` already
        // carries safe replacement copy whenever `suppressed` is true (see
        // SUPPRESSED_RESPONSE_TEXT in packages/outpost/ai/src/pipeline.ts), so
        // posting it is always correct. Re-gating it here is what previously made
        // shadow mode drop the very records worth studying — the suppressed arm ran
        // before the SHADOW_MODE arm, so nothing was logged. The draft itself is
        // persisted as the BOT Message in step 5 for the human to edit (while
        // suggestedResponse holds the publishable text bots pick up), and step 6
        // below escalates on suppression regardless of score.
        const ticketSource = ticket.source as TicketSource;
        // What became of `aiMessage.content`, recorded at the branch that knows.
        // The Slack mirror renders this verbatim, so an internal reader is never
        // told the community saw a draft that was withheld, only logged, or lost
        // to a failed post. Starts as the no-adapter case: if no branch below
        // claims it, nothing was ever attempted.
        let delivery: SlackMirrorDelivery = 'no-adapter';
        if (pipelineResult.suppressed) {
            console.warn(
                `[AI Response] Ungrounded draft withheld for ticket ${ticketId} — ` +
                    `${pipelineResult.groundedness.reasons.join('; ')}. ` +
                    `Publishing the safe replacement and escalating to a human.`,
            );
        }

        let responseDelivered = false;
        if (process.env.SHADOW_MODE === 'true') {
            // Shadow mode is a fact about this run, independent of whether the
            // shadow Message row below persists — claim it before the try.
            delivery = 'shadow';
            try {
                await prisma.message.create({
                    data: {
                        ticketId: ticket.id,
                        author: 'outpost-shadow',
                        content: pipelineResult.formatted.text,
                        type: 'SYSTEM',
                        isAiGenerated: true,
                        attachments: {
                            shadowMode: true,
                            latencyMs: pipelineResult.latencyMs,
                            generatedAt: new Date().toISOString(),
                        },
                    },
                });
                console.log(
                    `[AI Response] Shadow mode — logged response for ticket ${ticketId}, skipping platform post-back`,
                );
            } catch (error) {
                console.error(
                    `[AI Response] Shadow mode — failed to log response for ticket ${ticketId}:`,
                    error instanceof Error ? error.message : String(error),
                );
            }
            // Shadow mode's intended sink is the SYSTEM row. Preserve its
            // historical fail-soft behavior even if that diagnostic write fails.
            responseDelivered = true;
        } else if (hasAdapter(ticketSource)) {
            let adapter;
            try {
                adapter = getAdapter(ticketSource);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                console.error(
                    `[AI Response] Platform adapter misconfigured for ${ticket.source} on ticket ${ticketId}:`,
                    message,
                );
                // Don't attempt postResponse — adapter init failed (permanent error)
                adapter = null;
                deliveryFailure = `platform adapter misconfigured: ${message}`;
            }

            if (adapter) {
                let externalCommentId: string | undefined;
                try {
                    externalCommentId = await adapter.postResponse(
                        {
                            id: ticket.id,
                            sourceId: ticket.sourceId,
                            channel: ticket.channel,
                            source: ticketSource,
                        },
                        pipelineResult.formatted,
                    );
                    console.log(
                        `[AI Response] Posted response to ${ticket.source} for ticket ${ticketId}`,
                    );
                    responseDelivered = true;
                    // A suppressed run posts safe replacement copy, not the draft
                    // stored on aiMessage — so the draft itself still never reached
                    // anyone, even though the post succeeded. The mirror has to say
                    // which of those happened rather than guess.
                    delivery = pipelineResult.suppressed ? 'withheld' : 'delivered';
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    console.error(
                        `[AI Response] Failed to post response to ${ticket.source} for ticket ${ticketId}:`,
                        message,
                    );
                    deliveryFailure = message;
                    delivery = 'post-failed';
                }

                // Recording the external comment ID is bookkeeping for an
                // already-delivered response, so it gets its own try: a failure
                // here must not be mistaken for a delivery failure.
                if (externalCommentId) {
                    try {
                        await prisma.message.update({
                            where: { id: aiMessage.id },
                            data: { externalCommentId },
                        });
                    } catch (error) {
                        console.error(
                            `[AI Response] Failed to record externalCommentId for ticket ${ticketId}:`,
                            error instanceof Error ? error.message : String(error),
                        );
                    }
                }
            }
        } else {
            // For sources without adapters, suggestedResponse is the durable sink.
            if (suggestedResponseError) {
                deliveryFailure = `no platform adapter for ${ticket.source} and suggestedResponse could not be stored: ${suggestedResponseError}`;
            } else {
                responseDelivered = true;
            }
        }

        const nonDeliveryEscalationReason = pipelineResult.suppressed
            ? `AI response withheld (${pipelineResult.groundedness.reasons.join('; ')}) — needs a human answer`
            : pipelineResult.confidenceScore < AI_CONFIDENCE.ESCALATE
              ? `Low AI confidence (${(pipelineResult.confidenceScore * 100).toFixed(0)}%) — automated escalation`
              : null;

        if (responseDelivered) {
            if (nonDeliveryEscalationReason) {
                // Keep the response PENDING until its promised human handoff is
                // durable. A failed enqueue then retries this reason through the
                // prior-response gate without regenerating or reposting.
                try {
                    await prisma.message.update({
                        where: { id: aiMessage.id },
                        data: { escalationRequiredReason: nonDeliveryEscalationReason },
                    });
                    requiredEscalationRecorded = true;
                } catch (error) {
                    console.error(
                        `[AI Response] Failed to record required escalation for ticket ${ticketId}:`,
                        error instanceof Error ? error.message : String(error),
                    );
                }
            } else {
                try {
                    await prisma.message.update({
                        where: { id: aiMessage.id },
                        data: { responseState: 'DELIVERED', responseError: null },
                    });
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    console.error(
                        `[AI Response] Failed to record durable delivery for ticket ${ticketId}:`,
                        message,
                    );
                    // Delivery is already a fact. Persist it on its own flag so a
                    // retry can repair the state without reposting or escalating
                    // an already-answered reporter. The write failure itself is a
                    // genuine error, so it — and only it — goes in responseError.
                    try {
                        await prisma.message.update({
                            where: { id: aiMessage.id },
                            data: {
                                deliveryConfirmed: true,
                                responseError: `Delivery succeeded but the DELIVERED state write failed: ${message}`,
                            },
                        });
                    } catch (markerError) {
                        console.error(
                            `[AI Response] Failed to record delivery confirmation for ticket ${ticketId}:`,
                            markerError instanceof Error
                                ? markerError.message
                                : String(markerError),
                        );
                    }
                }
            }
        }

        if (deliveryFailure) {
            try {
                await prisma.message.update({
                    where: { id: aiMessage.id },
                    data: { responseError: deliveryFailure },
                });
            } catch (error) {
                console.error(
                    `[AI Response] Failed to record delivery error for ticket ${ticketId}:`,
                    error instanceof Error ? error.message : String(error),
                );
            }
        }

        await context.reportProgress(85);

        // 5c. Mirror the AI reply into the internal Slack thread for this
        // ticket. Enqueued regardless of whether the draft was delivered — an
        // answer the community never saw is precisely what the team needs to
        // notice — but labelled with which of those happened.
        if (isMirrorableSource(ticket.source) && isSlackMirrorEnabled(readSlackMirrorConfig())) {
            try {
                await createJob(JobType.SLACK_MIRROR, {
                    ticketId: ticket.id,
                    // The ticket's own source, not the job payload's optional
                    // hint — the inbound producer sends a resolved value and the
                    // two must agree.
                    source: toPlatformTarget(ticketSource),
                    kind: 'reply',
                    messageId: aiMessage.id,
                    delivery,
                });
            } catch (error) {
                console.error(
                    `[AI Response] Failed to enqueue Slack mirror for ticket ${ticketId}:`,
                    error instanceof Error ? error.message : String(error),
                );
            }
        }

        // 6. Enqueue ESCALATION when platform delivery failed, when the response
        // was withheld, or when confidence is below threshold — in the first two
        // cases nothing useful reached the reporter, so a human has to pick it up
        // regardless of what the score says. Delivery failure wins the reason slot
        // because it is the most actionable: the answer exists but is undelivered.
        // A stale-recovery job will escalate a response left PENDING, never
        // post it again.
        escalationReason = deliveryFailure
            ? `AI response generated but not delivered to ${ticket.source} (${deliveryFailure}) — needs a human to answer the reporter`
            : nonDeliveryEscalationReason;

        if (escalationReason) {
            try {
                escalationEnqueued = await enqueueEscalationAtomically(
                    ticket.id,
                    aiMessage.id,
                    escalationReason,
                );
            } catch (error) {
                escalationEnqueueError = error instanceof Error ? error.message : String(error);
                console.error(
                    `[AI Response] Failed to create escalation job for ticket ${ticketId}:`,
                    escalationEnqueueError,
                );
            }

            if (!escalationEnqueued && !escalationEnqueueError) {
                // The compare-and-set found the row outside PENDING, so nothing
                // was queued. Read the state it settled in before deciding what
                // to report: DELIVERED means the answer is durable and no
                // handoff was owed, ESCALATED means another actor already
                // summoned the human. Anything else leaves the promised handoff
                // unaccounted for and must not be reported as handled. Both
                // terminal states are final in this handler, so reading them
                // after the transaction cannot observe a third value.
                try {
                    const settled = await prisma.message.findUnique({
                        where: { id: aiMessage.id },
                        select: { responseState: true },
                    });
                    escalationSkippedState = settled?.responseState ?? null;
                } catch (error) {
                    escalationStateReadError =
                        error instanceof Error ? error.message : String(error);
                }
                console.warn(
                    `[AI Response] Ticket ${ticketId}: escalation (${escalationReason}) was not ` +
                        `queued — response row state is ${escalationSkippedState ?? 'unavailable'}` +
                        `${escalationStateReadError ? ` (${escalationStateReadError})` : ''}`,
                );

                // DELIVERED is accepted below as "no handoff was owed". Accepting
                // it while this attempt's escalationRequiredReason is still on the
                // row would leave a row that says "a human is required" next to a
                // state that says delivered — and nothing can ever act on that
                // pair, because requiredEscalationReason only reads a PENDING row.
                // Clear the marker with the acceptance so the two never contradict
                // each other.
                if (escalationSkippedState === 'DELIVERED' && requiredEscalationRecorded) {
                    try {
                        await prisma.message.update({
                            where: { id: aiMessage.id },
                            data: { escalationRequiredReason: null },
                        });
                    } catch (error) {
                        orphanedEscalationMarkerError =
                            error instanceof Error ? error.message : String(error);
                        console.error(
                            `[AI Response] Failed to clear the owed-escalation marker on a ` +
                                `delivered response for ticket ${ticketId}:`,
                            orphanedEscalationMarkerError,
                        );
                    }
                }
            }
        }
    } finally {
        pipeline.destroy();
    }

    console.log(
        `[AI Response] Ticket ${ticketId}: confidence=${pipelineResult.confidenceLevel} ` +
            `(${(pipelineResult.confidenceScore * 100).toFixed(0)}%), latency=${pipelineResult.latencyMs}ms` +
            `${pipelineResult.suppressed ? ', ungrounded draft withheld' : ''}` +
            `${deliveryFailure ? `, delivery failed (${deliveryFailure})` : ''}`,
    );

    // A human was summoned only if this attempt's escalation committed, or if the
    // row shows another actor already committed one. `escalationReason !== null`
    // is exactly the old local-condition test (delivery failure, suppression, or
    // sub-threshold confidence); what is new is that it no longer stands alone.
    const escalationHandoffDurable = escalationEnqueued || escalationSkippedState === 'ESCALATED';
    const escalated = escalationReason !== null && escalationHandoffDurable;

    // A promised human handoff is part of successful completion even when the AI
    // response reached the reporter. Report enqueue failure so the queue retries:
    // delivered low-confidence/suppressed responses carry their reason through
    // the prior-response gate, while delivery failures use the pending-response
    // recovery path. Neither route posts the AI response again.
    if (escalationReason && escalationEnqueueError) {
        return {
            success: false,
            error:
                `Ticket ${ticketId}: required escalation (${escalationReason}) ` +
                `could not be enqueued (${escalationEnqueueError}) — needs manual attention`,
        };
    }

    // The enqueue reported no-op rather than throwing. DELIVERED is the one
    // unremarkable explanation — the response is durably answered, so no handoff
    // was owed and `escalated: false` matches the row. Every other state (still
    // PENDING, row gone, or unreadable) means a reporter was promised a human who
    // was never summoned: fail so the queue retries through the prior-response
    // gate, which escalates without regenerating or reposting.
    if (escalationReason && !escalationHandoffDurable && escalationSkippedState !== 'DELIVERED') {
        const observed = escalationStateReadError
            ? `unreadable (${escalationStateReadError})`
            : (escalationSkippedState ?? 'missing');
        return {
            success: false,
            error:
                `Ticket ${ticketId}: required escalation (${escalationReason}) was not queued — ` +
                `response state is ${observed} — needs manual attention`,
        };
    }

    // The row settled DELIVERED, which is only clean once the owed-handoff marker
    // this attempt wrote is gone. It could not be cleared, so the contradiction
    // stands: report it rather than returning a success that hides it. Retries
    // skip through the prior-response gate without regenerating or reposting.
    if (orphanedEscalationMarkerError) {
        return {
            success: false,
            error:
                `Ticket ${ticketId}: response is DELIVERED but its owed-escalation marker ` +
                `could not be cleared (${orphanedEscalationMarkerError}) — needs manual attention`,
        };
    }

    await context.reportProgress(100);

    return {
        success: true,
        data: {
            ticketId,
            confidenceLevel: pipelineResult.confidenceLevel,
            confidenceScore: pipelineResult.confidenceScore,
            latencyMs: pipelineResult.latencyMs,
            escalated,
            suppressed: pipelineResult.suppressed,
            // Not `delivered` — shadow mode deliberately posts nothing, so only
            // the failure is a fact worth reporting.
            deliveryFailed: deliveryFailure !== null,
        },
    };
}
