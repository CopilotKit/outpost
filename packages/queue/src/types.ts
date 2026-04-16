/**
 * Job queue types for the Postgres-based job queue.
 *
 * Each job type has a strongly-typed payload shape. Handlers receive
 * the typed payload and must return a JobResult.
 */

// ─── Job Types ──────────────────────────────────────────────────────────────

export enum JobType {
    /** Generate an AI response for a ticket (Pathfinder -> Claude -> post to Discord/GitHub) */
    AI_RESPONSE = 'AI_RESPONSE',
    /** Auto-classify a ticket (priority, type, account matching) */
    TICKET_CLASSIFY = 'TICKET_CLASSIFY',
    /** Periodic SLA compliance check across all open tickets */
    SLA_CHECK = 'SLA_CHECK',
    /** Route a ticket to the right human */
    ESCALATION = 'ESCALATION',
    /** Compile daily new member digest */
    ONBOARDING_DIGEST = 'ONBOARDING_DIGEST',
    /** Run sentiment and engagement scoring on accounts */
    ACCOUNT_SCORING = 'ACCOUNT_SCORING',
    /** Sync accounts from HubSpot CRM */
    HUBSPOT_SYNC = 'HUBSPOT_SYNC',
}

// ─── Payload Shapes ─────────────────────────────────────────────────────────

export interface AiResponsePayload {
    ticketId: string;
    threadId?: string;
    source: 'discord' | 'github' | 'slack';
}

export interface TicketClassifyPayload {
    ticketId: string;
}

export interface SlaCheckPayload {
    // No payload needed — runs against all open tickets
}

export interface EscalationPayload {
    ticketId: string;
    reason: string;
    targetTeamMemberId?: string;
}

export interface OnboardingDigestPayload {
    date: string; // ISO date string, e.g. "2026-04-15"
}

export interface AccountScoringPayload {
    /** Optional account ID to score a single account; omit for all accounts */
    accountId?: string;
}

export interface HubSpotSyncPayload {
    /** Optional domain to sync a single account; omit for full sync */
    domain?: string;
}

/** Map from JobType to its specific payload shape */
export interface JobPayload {
    [JobType.AI_RESPONSE]: AiResponsePayload;
    [JobType.TICKET_CLASSIFY]: TicketClassifyPayload;
    [JobType.SLA_CHECK]: SlaCheckPayload;
    [JobType.ESCALATION]: EscalationPayload;
    [JobType.ONBOARDING_DIGEST]: OnboardingDigestPayload;
    [JobType.ACCOUNT_SCORING]: AccountScoringPayload;
    [JobType.HUBSPOT_SYNC]: HubSpotSyncPayload;
}

// ─── Job Results ────────────────────────────────────────────────────────────

export interface JobResult {
    success: boolean;
    data?: Record<string, unknown>;
    error?: string;
}

// ─── Options ────────────────────────────────────────────────────────────────

export interface CreateJobOptions {
    /** When to run the job (defaults to now) */
    runAt?: Date;
    /** Maximum retry attempts (defaults to MAX_JOB_ATTEMPTS) */
    maxAttempts?: number;
}

// ─── Handler Type ───────────────────────────────────────────────────────────

/**
 * A function that processes a job of a specific type.
 * Handlers receive the typed payload and an optional context object
 * for reporting progress.
 */
export type JobHandler<T extends JobType> = (
    payload: JobPayload[T],
    context: JobHandlerContext,
) => Promise<JobResult>;

/**
 * Context passed to job handlers allowing them to report progress
 * and check for cancellation.
 */
export interface JobHandlerContext {
    /** Report job progress as a percentage (0-100) */
    reportProgress: (percent: number) => Promise<void>;
    /** The job ID being processed */
    jobId: string;
}

// ─── Worker Types ───────────────────────────────────────────────────────────

export interface WorkerOptions {
    /** How often to poll for new jobs, in milliseconds. Default: 1000 */
    pollIntervalMs?: number;
    /** How many jobs to fetch per poll. Default: 10 */
    batchSize?: number;
    /** Maximum number of jobs to process concurrently. Default: 5 */
    maxConcurrency?: number;
    /** Per-job-type timeout overrides in milliseconds */
    jobTimeouts?: Partial<Record<JobType, number>>;
    /** Default timeout for jobs without a specific override, in ms. Default: 30000 */
    defaultTimeoutMs?: number;
}

export interface WorkerHealthStatus {
    running: boolean;
    activeJobCount: number;
    lastPollTime: Date | null;
    registeredHandlers: string[];
    upSince: Date | null;
}

// ─── Scheduler Types ────────────────────────────────────────────────────────

export interface ScheduledJobDefinition<T extends JobType = JobType> {
    /** Job type to create */
    type: T;
    /** Payload for the job */
    payload: JobPayload[T];
    /** Interval in milliseconds between runs */
    intervalMs: number;
    /** Human-readable description */
    description: string;
}
