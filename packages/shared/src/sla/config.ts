/**
 * SLA configuration: types, defaults, and DB loader.
 *
 * Default targets are used when no DB-level SlaConfig rows exist for a
 * given metric+priority pair.  loadSlaConfig() reads from the database
 * and merges with defaults so callers always get a complete map.
 */

import { SlaMetric, TicketPriority } from '../types.js';
import {
    DEFAULT_SLA_FIRST_RESPONSE,
    DEFAULT_SLA_RESOLUTION,
} from '../constants.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Per-priority SLA target in minutes. */
export interface SlaTarget {
    firstResponseMinutes: number;
    resolutionMinutes: number;
}

/** Result of evaluating one ticket against its SLA targets. */
export interface SlaCheckResult {
    ticketId: string;
    priority: TicketPriority;
    firstResponseBreached: boolean;
    resolutionBreached: boolean;
    /** null when no response yet (still counting). */
    firstResponseTimeMs: number | null;
    /** null when ticket is not yet closed. */
    resolutionTimeMs: number | null;
    target: SlaTarget;
}

/** Emitted when a new breach is detected. */
export interface SlaBreachEvent {
    ticketId: string;
    metric: SlaMetric;
    priority: TicketPriority;
    elapsedMs: number;
    targetMs: number;
}

/** Complete map of priority → SlaTarget. */
export type SlaTargetMap = Record<TicketPriority, SlaTarget>;

/** Minimal interface for the SlaConfig query — avoids depending on @outpost/db. */
export interface SlaConfigRow {
    metric: string;
    priority: string;
    targetMinutes: number;
}

/** Minimal Prisma-like client needed for SLA operations. */
export interface SlaConfigClient {
    slaConfig: {
        findMany: () => Promise<SlaConfigRow[]>;
    };
}

// ─── Defaults ───────────────────────────────────────────────────────────────

export const DEFAULT_SLA_TARGETS: SlaTargetMap = {
    [TicketPriority.CRITICAL]: {
        firstResponseMinutes: DEFAULT_SLA_FIRST_RESPONSE.CRITICAL,
        resolutionMinutes: DEFAULT_SLA_RESOLUTION.CRITICAL,
    },
    [TicketPriority.HIGH]: {
        firstResponseMinutes: DEFAULT_SLA_FIRST_RESPONSE.HIGH,
        resolutionMinutes: DEFAULT_SLA_RESOLUTION.HIGH,
    },
    [TicketPriority.MEDIUM]: {
        firstResponseMinutes: DEFAULT_SLA_FIRST_RESPONSE.MEDIUM,
        resolutionMinutes: DEFAULT_SLA_RESOLUTION.MEDIUM,
    },
    [TicketPriority.LOW]: {
        firstResponseMinutes: DEFAULT_SLA_FIRST_RESPONSE.LOW,
        resolutionMinutes: DEFAULT_SLA_RESOLUTION.LOW,
    },
};

// ─── Loader ─────────────────────────────────────────────────────────────────

/**
 * Load SLA configuration from the database, falling back to built-in
 * defaults for any missing metric+priority combination.
 */
export async function loadSlaConfig(prisma: SlaConfigClient): Promise<SlaTargetMap> {
    const rows = await prisma.slaConfig.findMany();

    // Start from defaults
    const targets: SlaTargetMap = structuredClone(DEFAULT_SLA_TARGETS);

    for (const row of rows) {
        const priority = row.priority as TicketPriority;
        if (!targets[priority]) continue;

        if (row.metric === SlaMetric.FIRST_RESPONSE) {
            targets[priority].firstResponseMinutes = row.targetMinutes;
        } else if (row.metric === SlaMetric.RESOLUTION) {
            targets[priority].resolutionMinutes = row.targetMinutes;
        }
    }

    return targets;
}
