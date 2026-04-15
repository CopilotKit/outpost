/**
 * SLA metrics aggregator.
 *
 * Produces dashboard-ready aggregate statistics about SLA performance
 * over a given date range, including breach counts, average response
 * times, breach rates by priority, and period-over-period trends.
 */

import { TicketPriority } from '../types.js';
import { loadSlaConfig } from './config.js';
import { checkSlaCompliance } from './checker.js';
import type { SlaTargetMap, SlaCheckResult, SlaConfigClient } from './config.js';
import type { TicketForSla } from './checker.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DateRange {
    from: Date;
    to: Date;
}

export interface PriorityBreachRate {
    priority: TicketPriority;
    total: number;
    breached: number;
    rate: number; // 0–1
}

export interface SlaMetricsResult {
    /** Total tickets evaluated. */
    totalTickets: number;
    /** Total breach count (first-response OR resolution). */
    totalBreaches: number;
    /** Average first-response time in ms across tickets that have one. */
    avgFirstResponseTimeMs: number | null;
    /** Average resolution time in ms across closed tickets. */
    avgResolutionTimeMs: number | null;
    /** Breach rate broken down by priority. */
    breachRateByPriority: PriorityBreachRate[];
    /** Trend comparing this period's breach count vs the previous equal-length period. */
    trend: {
        currentBreaches: number;
        previousBreaches: number;
        /** Positive = more breaches this period, negative = fewer. */
        delta: number;
    };
}

// ─── Minimal Prisma interface for metrics queries ───────────────────────────

export interface SlaMetricsClient extends SlaConfigClient {
    ticket: {
        findMany: (args: {
            where: {
                createdAt: {
                    gte: Date;
                    lte: Date;
                };
            };
            include: {
                messages: {
                    select: { type: true; createdAt: true };
                    orderBy: { createdAt: 'asc' };
                };
            };
        }) => Promise<TicketForSla[]>;
    };
}

// ─── Aggregator ─────────────────────────────────────────────────────────────

/**
 * Compute aggregate SLA metrics for the given date range.
 *
 * When no dateRange is supplied the aggregator uses the last 30 days
 * as the current period and the 30 days before that as the comparison
 * period.
 */
export async function getSlaMetrics(
    prisma: SlaMetricsClient,
    dateRange?: DateRange,
): Promise<SlaMetricsResult> {
    const now = new Date();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

    const currentRange: DateRange = dateRange ?? {
        from: new Date(now.getTime() - thirtyDaysMs),
        to: now,
    };

    const periodLengthMs = currentRange.to.getTime() - currentRange.from.getTime();
    const previousRange: DateRange = {
        from: new Date(currentRange.from.getTime() - periodLengthMs),
        to: currentRange.from,
    };

    const targets = await loadSlaConfig(prisma);

    // Fetch current period tickets with messages
    const currentTickets = await fetchTicketsInRange(prisma, currentRange);
    const previousTickets = await fetchTicketsInRange(prisma, previousRange);

    // Evaluate current period
    const currentResults = currentTickets.map((t: TicketForSla) =>
        checkSlaCompliance(t, targets, currentRange.to),
    );

    const previousResults = previousTickets.map((t: TicketForSla) =>
        checkSlaCompliance(t, targets, previousRange.to),
    );

    // Aggregate
    const totalTickets = currentResults.length;
    const totalBreaches = currentResults.filter(
        (r: SlaCheckResult) => r.firstResponseBreached || r.resolutionBreached,
    ).length;

    const firstResponseTimes = currentResults
        .map((r: SlaCheckResult) => r.firstResponseTimeMs)
        .filter((ms: number | null): ms is number => ms !== null);

    const resolutionTimes = currentResults
        .map((r: SlaCheckResult) => r.resolutionTimeMs)
        .filter((ms: number | null): ms is number => ms !== null);

    const avgFirstResponseTimeMs =
        firstResponseTimes.length > 0
            ? firstResponseTimes.reduce((a: number, b: number) => a + b, 0) / firstResponseTimes.length
            : null;

    const avgResolutionTimeMs =
        resolutionTimes.length > 0
            ? resolutionTimes.reduce((a: number, b: number) => a + b, 0) / resolutionTimes.length
            : null;

    // Breach rate by priority
    const breachRateByPriority = buildBreachRateByPriority(currentResults);

    // Trend
    const previousBreaches = previousResults.filter(
        (r: SlaCheckResult) => r.firstResponseBreached || r.resolutionBreached,
    ).length;

    return {
        totalTickets,
        totalBreaches,
        avgFirstResponseTimeMs,
        avgResolutionTimeMs,
        breachRateByPriority,
        trend: {
            currentBreaches: totalBreaches,
            previousBreaches,
            delta: totalBreaches - previousBreaches,
        },
    };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function fetchTicketsInRange(
    prisma: SlaMetricsClient,
    range: DateRange,
): Promise<TicketForSla[]> {
    return prisma.ticket.findMany({
        where: {
            createdAt: {
                gte: range.from,
                lte: range.to,
            },
        },
        include: {
            messages: {
                select: {
                    type: true,
                    createdAt: true,
                },
                orderBy: { createdAt: 'asc' },
            },
        },
    });
}

function buildBreachRateByPriority(
    results: SlaCheckResult[],
): PriorityBreachRate[] {
    const priorities = [
        TicketPriority.CRITICAL,
        TicketPriority.HIGH,
        TicketPriority.MEDIUM,
        TicketPriority.LOW,
    ];

    return priorities.map((priority) => {
        const matching = results.filter((r: SlaCheckResult) => r.priority === priority);
        const breached = matching.filter(
            (r: SlaCheckResult) => r.firstResponseBreached || r.resolutionBreached,
        );
        return {
            priority,
            total: matching.length,
            breached: breached.length,
            rate: matching.length > 0 ? breached.length / matching.length : 0,
        };
    });
}
