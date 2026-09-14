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
 * - SLACK_MIRROR: mirror a ticket or reply into the internal Slack channel
 * - PENDING_RESPONSE_SWEEP: settle AI responses stranded in PENDING by a dead job
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
    handleSlackMirror,
    handlePendingResponseSweep,
    createJob,
} from '@copilotkit/outpost/queue';
import { buildSyncEngine } from './build-sync-engine.js';

// ─── Build SyncEngine for TRACKER_SYNC handler ────────────────────────────

// BOOT SEMANTICS — deliberate change. This is a top-level await that performs
// three database reads (the persisted status / priority / label mapping configs)
// before this module finishes evaluating. If the database is unreachable at boot
// the import throws, so the process exits BEFORE the health server below starts
// listening: the container crash-loops with no /health at all rather than coming
// up and reporting itself degraded.
//
// Fail-fast is the intent — a worker running with silently-defaulted mappings is
// worse than one that is visibly down, since TRACKER_SYNC would then write wrong
// statuses to Linear. Railway's restart policy is the retry mechanism. Note this
// interacts with the /health honesty follow-up (#138): once /health reflects
// worker state, a degraded-but-listening mode becomes a real option and this
// decision is worth revisiting.
const syncEngine = await buildSyncEngine();

const handleTrackerSync = createTrackerSyncHandler(syncEngine);

// ─── Create Worker ────────────────────────────────────────────────────────

const worker = new Worker({
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
        // 1, not 2: the ticket and reply jobs for one ticket race to claim the
        // same TicketExternalLink row. The handler survives the race, but serial
        // processing keeps one ticket's thread in one Slack thread by construction.
        [JobType.SLACK_MIRROR]: 1,
        [JobType.PENDING_RESPONSE_SWEEP]: 1,
    },
    jobTimeouts: {
        [JobType.AI_RESPONSE]: 120_000, // 2 minutes — AI pipeline is slow
        [JobType.HUBSPOT_SYNC]: 300_000, // 5 minutes — full sync can be large
        [JobType.ACCOUNT_SCORING]: 300_000, // 5 minutes — many accounts
        // 60s, above the 30s default: a reply that has to open its thread first
        // makes two chat.postMessage calls, and WebClient sleeps through Slack's
        // rate-limit retries. Timing out mid-post would re-post on the retry.
        [JobType.SLACK_MIRROR]: 60_000,
    },
});

// ─── Register Handlers ────────────────────────────────────────────────────

worker.on(JobType.AI_RESPONSE, handleAiResponse);
worker.on(JobType.ESCALATION, handleEscalation);
worker.on(JobType.SLA_CHECK, handleSlaCheck);
worker.on(JobType.ONBOARDING_DIGEST, handleOnboardingDigest);
worker.on(JobType.ACCOUNT_SCORING, handleAccountScoring);
worker.on(JobType.HUBSPOT_SYNC, handleHubSpotSync);
worker.on(JobType.TRACKER_SYNC, handleTrackerSync);
worker.on(JobType.JOB_CLEANUP, handleJobCleanup);
worker.on(JobType.GITHUB_REACTION_POLL, handleGithubReactionPoll);
worker.on(JobType.SLACK_MIRROR, handleSlackMirror);
worker.on(JobType.PENDING_RESPONSE_SWEEP, handlePendingResponseSweep);

// ─── Start Scheduler ──────────────────────────────────────────────────────

const scheduler = new Scheduler();

// ─── Health Server ────────────────────────────────────────────────────────

const port = parseInt(process.env.PORT ?? process.env.HEALTH_PORT ?? '3003', 10);

const healthServer = http.createServer((req, res) => {
    if (req.url === '/health') {
        const health = worker.healthCheck();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', ...health }));
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

// ─── Start Everything ─────────────────────────────────────────────────────

healthServer.listen(port, () => {
    console.log(`[Worker] Health server listening on port ${port}`);
});

scheduler.start();
worker.start();

console.log('[Worker] Worker process started');

// ─── Graceful Shutdown ────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
    console.log(`[Worker] Received ${signal}, shutting down...`);
    scheduler.stop();
    await worker.stop();
    healthServer.close();
    await prisma.$disconnect();
    console.log('[Worker] Shutdown complete');
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
