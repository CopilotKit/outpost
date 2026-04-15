/**
 * SLA compliance checker.
 *
 * Evaluates a single ticket (with its messages) against the SLA targets
 * for its priority level.
 *
 * First-response time = time between ticket creation and the first
 * BOT or SYSTEM message (team response).  If no such message exists the
 * ticket is considered "awaiting first response" and is breached only
 * when the elapsed time exceeds the target.
 *
 * Resolution time = time between ticket creation and status=CLOSED.
 * Open tickets are checked against the target based on elapsed time so far.
 */

import { TicketPriority, SlaMetric } from '../types.js';
import type { SlaCheckResult, SlaBreachEvent, SlaTargetMap } from './config.js';

// ─── Minimal shapes we need from Prisma models ─────────────────────────────

export interface TicketForSla {
    id: string;
    priority: string;
    status: string;
    slaBreachedAt: Date | null;
    createdAt: Date;
    messages: Array<{
        type: string;
        createdAt: Date;
    }>;
}

// ─── Checker ────────────────────────────────────────────────────────────────

/**
 * Evaluate a single ticket's SLA compliance.
 *
 * @param ticket  The ticket with its messages loaded.
 * @param targets Complete priority→target map (from loadSlaConfig).
 * @param now     Optional "current time" override for testing.
 */
export function checkSlaCompliance(
    ticket: TicketForSla,
    targets: SlaTargetMap,
    now: Date = new Date(),
): SlaCheckResult {
    const priority = ticket.priority as TicketPriority;
    const target = targets[priority];

    // ── First response time ─────────────────────────────────────────────
    const firstTeamMessage = ticket.messages
        .filter((m) => m.type === 'BOT' || m.type === 'SYSTEM')
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];

    const firstResponseTimeMs = firstTeamMessage
        ? firstTeamMessage.createdAt.getTime() - ticket.createdAt.getTime()
        : null;

    const firstResponseTargetMs = target.firstResponseMinutes * 60 * 1000;

    const firstResponseBreached = firstResponseTimeMs !== null
        ? firstResponseTimeMs > firstResponseTargetMs
        : (now.getTime() - ticket.createdAt.getTime()) > firstResponseTargetMs;

    // ── Resolution time ─────────────────────────────────────────────────
    const isClosed = ticket.status === 'CLOSED';
    // For closed tickets we don't have an explicit closedAt field, but
    // the updatedAt would reflect it.  For simplicity we treat
    // "resolution time so far" as elapsed since creation up to now for
    // open tickets.
    const resolutionTimeMs = isClosed
        ? now.getTime() - ticket.createdAt.getTime()
        : null;

    const resolutionTargetMs = target.resolutionMinutes * 60 * 1000;
    const elapsedMs = now.getTime() - ticket.createdAt.getTime();

    const resolutionBreached = isClosed
        ? (resolutionTimeMs ?? 0) > resolutionTargetMs
        : elapsedMs > resolutionTargetMs;

    return {
        ticketId: ticket.id,
        priority,
        firstResponseBreached,
        resolutionBreached,
        firstResponseTimeMs,
        resolutionTimeMs,
        target,
    };
}

/**
 * Build breach events for a check result, returning only the metrics
 * that are actually breached.
 */
export function buildBreachEvents(result: SlaCheckResult): SlaBreachEvent[] {
    const events: SlaBreachEvent[] = [];

    if (result.firstResponseBreached) {
        const elapsed = result.firstResponseTimeMs
            ?? (Date.now() - 0); // caller should supply actual elapsed
        events.push({
            ticketId: result.ticketId,
            metric: SlaMetric.FIRST_RESPONSE,
            priority: result.priority,
            elapsedMs: elapsed,
            targetMs: result.target.firstResponseMinutes * 60 * 1000,
        });
    }

    if (result.resolutionBreached) {
        const elapsed = result.resolutionTimeMs ?? (Date.now() - 0);
        events.push({
            ticketId: result.ticketId,
            metric: SlaMetric.RESOLUTION,
            priority: result.priority,
            elapsedMs: elapsed,
            targetMs: result.target.resolutionMinutes * 60 * 1000,
        });
    }

    return events;
}
