#!/usr/bin/env npx tsx
// ─── Orca → Outpost Cutover Execution ───────────────────────────────────────
// Automated step-by-step cutover from Orca to Outpost as the primary bot.
//
// Usage:
//   npx tsx scripts/cutover/execute-cutover.ts              # dry run
//   npx tsx scripts/cutover/execute-cutover.ts --confirm     # execute for real

import { PrismaClient } from '@prisma/client';
import { isShadowMode } from '@copilotkit/outpost/shared';
import { validateQuality } from './validate-quality.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface StepResult {
    step: string;
    status: 'PASS' | 'FAIL' | 'SKIP';
    message: string;
    timestamp: Date;
}

interface CutoverLog {
    startedAt: Date;
    completedAt: Date | null;
    confirm: boolean;
    steps: StepResult[];
    outcome: 'SUCCESS' | 'FAILED' | 'ABORTED';
}

interface CliArgs {
    confirm: boolean;
    skipQualityCheck: boolean;
    announcement: string;
}

// ─── CLI Parsing ────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): CliArgs {
    const args: CliArgs = {
        confirm: false,
        skipQualityCheck: false,
        announcement:
            "We've upgraded our support bot to provide faster, more accurate responses. " +
            'If you notice any issues, please let us know!',
    };

    for (let i = 2; i < argv.length; i++) {
        switch (argv[i]) {
            case '--confirm':
                args.confirm = true;
                break;
            case '--skip-quality-check':
                args.skipQualityCheck = true;
                break;
            case '--announcement':
                args.announcement = argv[++i] ?? args.announcement;
                break;
        }
    }

    return args;
}

// ─── Step Execution ─────────────────────────────────────────────────────────

function logStep(result: StepResult): void {
    const icon = result.status === 'PASS' ? '[OK]' : result.status === 'FAIL' ? '[FAIL]' : '[SKIP]';
    console.log(`  ${icon} ${result.step}: ${result.message}`);
}

export async function runHealthChecks(prisma: PrismaClient): Promise<StepResult> {
    const step = 'Health checks';
    try {
        // Verify database connectivity
        await prisma.$queryRaw`SELECT 1`;

        // Verify required env vars are set
        const required = ['DATABASE_URL', 'DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'GUILD_ID'];
        const missing = required.filter((k) => !process.env[k]);
        if (missing.length > 0) {
            return {
                step,
                status: 'FAIL',
                message: `Missing env vars: ${missing.join(', ')}`,
                timestamp: new Date(),
            };
        }

        return {
            step,
            status: 'PASS',
            message: 'Database connected, all required env vars present',
            timestamp: new Date(),
        };
    } catch (err) {
        return {
            step,
            status: 'FAIL',
            message: `Database connection failed: ${err instanceof Error ? err.message : String(err)}`,
            timestamp: new Date(),
        };
    }
}

export async function runQualityValidation(
    prisma: PrismaClient,
    skip: boolean,
): Promise<StepResult> {
    const step = 'Quality validation';

    if (skip) {
        return {
            step,
            status: 'SKIP',
            message: 'Skipped via --skip-quality-check',
            timestamp: new Date(),
        };
    }

    try {
        const metrics = await validateQuality(prisma, {
            since: null,
            minSample: 20,
        });

        if (metrics.recommendation === 'READY') {
            return {
                step,
                status: 'PASS',
                message: `${metrics.ticketsWithShadowResponses} shadow responses analyzed, all metrics pass`,
                timestamp: new Date(),
            };
        }

        return {
            step,
            status: 'FAIL',
            message: `Recommendation: ${metrics.recommendation} — ${metrics.reasons.join('; ')}`,
            timestamp: new Date(),
        };
    } catch (err) {
        return {
            step,
            status: 'FAIL',
            message: `Validation error: ${err instanceof Error ? err.message : String(err)}`,
            timestamp: new Date(),
        };
    }
}

export async function disableShadowMode(confirm: boolean): Promise<StepResult> {
    const step = 'Disable shadow mode';

    if (!confirm) {
        return {
            step,
            status: 'SKIP',
            message: 'Dry run — would set SHADOW_MODE=false on Railway',
            timestamp: new Date(),
        };
    }

    // In a real deployment, this would call the Railway API to update env vars.
    // For now, we verify the current state and log the instruction.
    //
    // Reads through the shared helper, not `!== 'true'`. This was the fourth
    // copy of that comparison and the sweep missed it, which meant
    // `SHADOW_MODE=TRUE` had the worker correctly withholding posts while this
    // step reported shadow mode already disabled and passed — the same
    // fail-open, moved onto the cutover path.
    const currentValue = process.env.SHADOW_MODE;
    if (!isShadowMode()) {
        return {
            step,
            status: 'PASS',
            message: `Shadow mode already disabled (SHADOW_MODE=${currentValue ?? 'unset'})`,
            timestamp: new Date(),
        };
    }

    console.log('  ACTION REQUIRED: Set SHADOW_MODE=false in Railway environment variables');
    console.log('  Then redeploy the discord-bot service.');

    return {
        step,
        status: 'PASS',
        message: 'Shadow mode disable instruction issued',
        timestamp: new Date(),
    };
}

export async function verifyTicketData(prisma: PrismaClient): Promise<StepResult> {
    const step = 'Verify ticket data';

    try {
        const ticketCount = await prisma.ticket.count();
        const discordTickets = await prisma.ticket.count({
            where: { source: 'DISCORD' },
        });
        const orcaTickets = await prisma.ticket.count({
            where: { source: 'ORCA' },
        });

        if (ticketCount === 0) {
            return {
                step,
                status: 'FAIL',
                message: 'No tickets found in database',
                timestamp: new Date(),
            };
        }

        return {
            step,
            status: 'PASS',
            message: `${ticketCount} total tickets (${discordTickets} Discord, ${orcaTickets} Orca)`,
            timestamp: new Date(),
        };
    } catch (err) {
        return {
            step,
            status: 'FAIL',
            message: `Query failed: ${err instanceof Error ? err.message : String(err)}`,
            timestamp: new Date(),
        };
    }
}

// ─── Main ───────────────────────────────────────────────────────────────────

export async function executeCutover(prisma: PrismaClient, args: CliArgs): Promise<CutoverLog> {
    const log: CutoverLog = {
        startedAt: new Date(),
        completedAt: null,
        confirm: args.confirm,
        steps: [],
        outcome: 'ABORTED',
    };

    console.log('');
    console.log('═══ Orca → Outpost Cutover ═══');
    console.log(`  Mode: ${args.confirm ? 'EXECUTE' : 'DRY RUN'}`);
    console.log(`  Started: ${log.startedAt.toISOString()}`);
    console.log('');

    // Step 1: Health checks
    const health = await runHealthChecks(prisma);
    log.steps.push(health);
    logStep(health);
    if (health.status === 'FAIL') {
        log.outcome = 'FAILED';
        log.completedAt = new Date();
        return log;
    }

    // Step 2: Verify ticket data exists
    const dataCheck = await verifyTicketData(prisma);
    log.steps.push(dataCheck);
    logStep(dataCheck);
    if (dataCheck.status === 'FAIL') {
        log.outcome = 'FAILED';
        log.completedAt = new Date();
        return log;
    }

    // Step 3: Quality validation
    const quality = await runQualityValidation(prisma, args.skipQualityCheck);
    log.steps.push(quality);
    logStep(quality);
    if (quality.status === 'FAIL') {
        log.outcome = 'FAILED';
        log.completedAt = new Date();
        return log;
    }

    // Step 4: Disable shadow mode
    const shadow = await disableShadowMode(args.confirm);
    log.steps.push(shadow);
    logStep(shadow);

    // Step 5: Log announcement
    const announceStep: StepResult = {
        step: 'Post announcement',
        status: args.confirm ? 'PASS' : 'SKIP',
        message: args.confirm
            ? `Announcement: "${args.announcement}"`
            : `Dry run — would post: "${args.announcement}"`,
        timestamp: new Date(),
    };
    log.steps.push(announceStep);
    logStep(announceStep);

    log.outcome = 'SUCCESS';
    log.completedAt = new Date();

    console.log('');
    console.log(`  Cutover ${args.confirm ? 'COMPLETED' : 'DRY RUN COMPLETED'}`);
    console.log(`  Duration: ${log.completedAt.getTime() - log.startedAt.getTime()}ms`);
    console.log('');

    return log;
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv);

    if (!args.confirm) {
        console.log('\n  This is a DRY RUN. Pass --confirm to execute the cutover.\n');
    }

    const prisma = new PrismaClient();

    try {
        const log = await executeCutover(prisma, args);

        if (log.outcome === 'FAILED') {
            console.error('\n  Cutover FAILED. Review the steps above.\n');
            process.exit(1);
        }
    } finally {
        await prisma.$disconnect();
    }
}

// Only run when executed directly (not when imported for testing)
const isDirectExecution = process.argv[1]?.endsWith('execute-cutover.ts') ?? false;
if (isDirectExecution) {
    main().catch((err) => {
        console.error('Cutover failed:', err);
        process.exit(1);
    });
}
