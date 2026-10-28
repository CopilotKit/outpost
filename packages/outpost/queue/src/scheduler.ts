import { prisma } from '@copilotkit/outpost/db';
import { createJob } from './create-job.js';
import { JobType } from './types.js';
import type { ScheduledJobDefinition } from './types.js';

/**
 * Default scheduled job definitions for Outpost.
 *
 * SLA check: every 5 minutes
 * Onboarding digest: every 24 hours (daily at ~9 AM UTC, depending on when the scheduler starts)
 */
export const DEFAULT_SCHEDULED_JOBS: ScheduledJobDefinition[] = [
    {
        type: JobType.SLA_CHECK,
        payload: {},
        intervalMs: 5 * 60 * 1000, // 5 minutes
        description: 'Check SLA compliance for all open tickets',
    },
    {
        type: JobType.ONBOARDING_DIGEST,
        payload: { date: '' }, // Will be filled at runtime with the current date
        intervalMs: 24 * 60 * 60 * 1000, // 24 hours
        description: 'Compile daily new member onboarding digest',
    },
    {
        type: JobType.ACCOUNT_SCORING,
        payload: {},
        intervalMs: 24 * 60 * 60 * 1000, // 24 hours
        description: 'Run sentiment and engagement scoring on all accounts',
    },
    {
        type: JobType.HUBSPOT_SYNC,
        payload: {},
        intervalMs: 24 * 60 * 60 * 1000, // 24 hours
        description: 'Sync accounts from HubSpot CRM',
    },
    {
        type: JobType.JOB_CLEANUP,
        payload: {},
        intervalMs: 24 * 60 * 60 * 1000, // 24 hours
        description: 'Clean up old completed/dead-letter jobs and sync events',
    },
    {
        type: JobType.GITHUB_REACTION_POLL,
        payload: {},
        intervalMs: 24 * 60 * 60 * 1000, // 24 hours
        description: 'Poll GitHub reactions on AI-authored comments for feedback signal',
    },
    {
        type: JobType.PENDING_RESPONSE_SWEEP,
        payload: {},
        // 5 minutes, matching SLA_CHECK. The handler's own age threshold decides
        // what is stranded, so this interval only sets detection latency — a
        // reporter owed a human waits at most one interval past that threshold.
        intervalMs: 5 * 60 * 1000,
        description: 'Settle primary AI responses stranded in PENDING with no live owning job',
    },
];

/**
 * Drop scheduled jobs whose required configuration is missing.
 *
 * HUBSPOT_SYNC needs HUBSPOT_API_KEY: without it every run fails at client
 * construction and dead-letters. It is left out of the schedule (so no job rows
 * are created) and one startup line says so. Setting the key re-enables it on
 * the next start.
 */
export function resolveScheduledJobs(
    definitions: ScheduledJobDefinition[] = DEFAULT_SCHEDULED_JOBS,
    env: NodeJS.ProcessEnv = process.env,
): ScheduledJobDefinition[] {
    if (env.HUBSPOT_API_KEY?.trim()) return definitions;

    console.log(
        '[Scheduler] Skipping HUBSPOT_SYNC: HUBSPOT_API_KEY is not set (set it to enable the HubSpot sync)',
    );
    return definitions.filter((d) => d.type !== JobType.HUBSPOT_SYNC);
}

/**
 * A simple interval-based scheduler that creates recurring jobs.
 *
 * For each scheduled job definition, it checks whether a job of that type
 * is already pending or processing. If not, it creates a new one. This
 * prevents duplicate scheduled jobs from piling up.
 */
export class Scheduler {
    private definitions: ScheduledJobDefinition[];
    private timers: ReturnType<typeof setInterval>[] = [];
    private running = false;

    constructor(definitions?: ScheduledJobDefinition[]) {
        this.definitions = definitions ?? resolveScheduledJobs();
    }

    /**
     * Start all scheduled job timers.
     * Each definition gets its own interval that checks and creates jobs.
     */
    start(): void {
        if (this.running) return;
        this.running = true;
        console.log(`[Scheduler] Starting with ${this.definitions.length} scheduled jobs`);

        for (const definition of this.definitions) {
            // Run immediately on start, then on interval
            this.tick(definition);
            const timer = setInterval(() => this.tick(definition), definition.intervalMs);
            this.timers.push(timer);
        }
    }

    /**
     * Stop all scheduled job timers.
     */
    stop(): void {
        if (!this.running) return;
        this.running = false;
        for (const timer of this.timers) {
            clearInterval(timer);
        }
        this.timers = [];
        console.log('[Scheduler] Stopped');
    }

    /**
     * Check if a job of the given type needs to be created, and create it if so.
     * A job is skipped if there's already a PENDING or PROCESSING job of the same type.
     */
    private async tick(definition: ScheduledJobDefinition): Promise<void> {
        try {
            const existingJob = await prisma.job.findFirst({
                where: {
                    type: definition.type,
                    status: { in: ['PENDING', 'PROCESSING'] },
                },
            });

            if (existingJob) {
                return; // Already queued or running, skip
            }

            // For onboarding digest, inject the current date
            let payload = definition.payload;
            if (definition.type === JobType.ONBOARDING_DIGEST) {
                payload = { date: new Date().toISOString().split('T')[0] };
            }

            const jobId = await createJob(definition.type, payload);
            console.log(
                `[Scheduler] Created ${definition.type} job ${jobId}: ${definition.description}`,
            );
        } catch (error) {
            console.error(`[Scheduler] Failed to create ${definition.type} job:`, error);
        }
    }
}
