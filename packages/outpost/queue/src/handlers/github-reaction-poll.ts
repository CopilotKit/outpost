/**
 * GITHUB_REACTION_POLL job handler.
 *
 * GitHub has no webhook event for reactions (confirmed against GitHub's
 * official webhook docs) — this is the only way to detect a 👍/👎 on the
 * AI's own comment. Runs every 24 hours (see scheduler.ts). For each
 * AI-generated GitHub message with no feedback yet, checks whether the
 * ticket's original reporter reacted +1 or -1 on that specific comment.
 * A -1 also enqueues an ESCALATION job, matching Discord's
 * "Need more help" button behavior.
 *
 * Lookups run GITHUB_REACTION_POLL_CONCURRENCY at a time. One at a time, the
 * poll needs one GitHub round trip per pending message, and that list only
 * grows. At 256 messages the serial loop overran the 30s job timeout on every
 * attempt, and the job was dead-lettered after each scheduled run.
 */

import { prisma } from '@copilotkit/outpost/db';
import {
    createGithubClient,
    isGithubNotFound,
    isRepoVisible,
    listCommentReactions,
} from '@copilotkit/outpost/shared';
import { createJob } from '../create-job.js';
import { JobType } from '../types.js';
import type { GithubReactionPollPayload, JobResult, JobHandlerContext } from '../types.js';

/**
 * Number of reaction lookups the poll keeps in flight. Well under GitHub's
 * secondary rate limit of 100 concurrent requests, and enough to check
 * about 1,000 messages inside the 30s job timeout.
 */
export const GITHUB_REACTION_POLL_CONCURRENCY = 8;

/**
 * Terminal `feedback` value for a message whose GitHub comment no longer exists.
 * It takes the message out of the `feedback: null` set this job polls, so a
 * deleted comment is logged once instead of erroring on every run. Feedback
 * calibration counts only POSITIVE and NEGATIVE, so it is not affected.
 */
export const COMMENT_DELETED_FEEDBACK = 'COMMENT_DELETED';

/**
 * Parse "owner/repo#number" into its components.
 */
function parseSourceId(sourceId: string): { owner: string; repo: string } | null {
    const match = sourceId.match(/^(.+?)\/(.+?)#\d+$/);
    if (!match) return null;
    return { owner: match[1], repo: match[2] };
}

export async function handleGithubReactionPoll(
    _payload: GithubReactionPollPayload,
    context: JobHandlerContext,
): Promise<JobResult> {
    await context.reportProgress(10);

    const pendingMessages = await prisma.message.findMany({
        where: {
            isAiGenerated: true,
            feedback: null,
            externalCommentId: { not: null },
            ticket: {
                // GITHUB_DISCUSSION excluded: discussion comments are created via GraphQL
                // and their externalCommentId is a GraphQL node_id, not a numeric REST
                // comment ID — reactions on them are only readable via GraphQL, which this
                // poll doesn't use. Follow-up work, not in scope here.
                source: { in: ['GITHUB_ISSUE'] },
            },
        },
        include: {
            ticket: {
                select: {
                    id: true,
                    sourceId: true,
                    user: { select: { externalId: true } },
                },
            },
        },
    });

    await context.reportProgress(20);

    const appId = process.env.GITHUB_APP_ID;
    const privateKey = process.env.GITHUB_PRIVATE_KEY;
    const installationId = process.env.GITHUB_INSTALLATION_ID;

    if (!appId || !privateKey || !installationId) {
        return {
            success: false,
            error: 'GITHUB_APP_ID/GITHUB_PRIVATE_KEY/GITHUB_INSTALLATION_ID not configured',
        };
    }

    const client = createGithubClient({ appId, privateKey, installationId });

    // One visibility check per repo per run, shared by every 404 in that repo.
    const repoVisibility = new Map<string, Promise<boolean>>();
    const reportedHiddenRepos = new Set<string>();

    let checked = 0;
    let updated = 0;
    let deleted = 0;

    /**
     * A 404 from the reactions endpoint means the comment is gone only if the App
     * can still see the repo. If it cannot, the problem is access, not deletion:
     * the message stays pending and the repo is reported once as an error.
     */
    async function handleCommentNotFound(
        messageId: string,
        owner: string,
        repo: string,
        commentId: number,
    ): Promise<void> {
        const key = `${owner}/${repo}`;
        const check = repoVisibility.get(key) ?? isRepoVisible(client, owner, repo);
        repoVisibility.set(key, check);

        let visible: boolean;
        try {
            visible = await check;
        } catch (error) {
            console.error(
                `[GithubReactionPoll] Failed to list reactions for message ${messageId}: comment ${commentId} not found, and checking ${key} failed:`,
                error instanceof Error ? error.message : String(error),
            );
            return;
        }

        if (!visible) {
            if (!reportedHiddenRepos.has(key)) {
                reportedHiddenRepos.add(key);
                console.error(
                    `[GithubReactionPoll] Repo ${key} is not visible to the GitHub App (404); skipping its messages this run`,
                );
            }
            return;
        }

        await prisma.message.update({
            where: { id: messageId },
            data: { feedback: COMMENT_DELETED_FEEDBACK },
        });
        deleted += 1;
        console.log(
            `[GithubReactionPoll] Comment ${commentId} for message ${messageId} no longer exists on ${key}; marked ${COMMENT_DELETED_FEEDBACK}, it will not be polled again`,
        );
    }

    async function checkMessage(message: (typeof pendingMessages)[number]): Promise<void> {
        checked += 1;

        if (
            !message.externalCommentId ||
            !message.ticket.sourceId ||
            !message.ticket.user?.externalId
        ) {
            return;
        }

        const parsed = parseSourceId(message.ticket.sourceId);
        if (!parsed) return;

        const reporterLogin = message.ticket.user.externalId;
        const commentId = Number(message.externalCommentId);

        let reactions;
        try {
            reactions = await listCommentReactions(client, parsed.owner, parsed.repo, commentId);
        } catch (error) {
            if (isGithubNotFound(error)) {
                await handleCommentNotFound(message.id, parsed.owner, parsed.repo, commentId);
                return;
            }
            console.error(
                `[GithubReactionPoll] Failed to list reactions for message ${message.id}:`,
                error instanceof Error ? error.message : String(error),
            );
            return;
        }

        const reporterReaction = reactions.find((r) => r.login === reporterLogin);
        if (!reporterReaction) return;

        if (reporterReaction.content === '+1') {
            await prisma.message.update({
                where: { id: message.id },
                data: { feedback: 'POSITIVE' },
            });
            updated += 1;
        } else if (reporterReaction.content === '-1') {
            await prisma.message.update({
                where: { id: message.id },
                data: { feedback: 'NEGATIVE' },
            });
            await createJob(JobType.ESCALATION, {
                ticketId: message.ticketId,
                reason: 'User reacted 👎 (negative) via GitHub reaction — automated escalation',
            });
            updated += 1;
        }
    }

    let next = 0;
    async function drain(): Promise<void> {
        while (next < pendingMessages.length) {
            const message = pendingMessages[next];
            next += 1;
            await checkMessage(message);
        }
    }

    await Promise.all(
        Array.from(
            { length: Math.min(GITHUB_REACTION_POLL_CONCURRENCY, pendingMessages.length) },
            drain,
        ),
    );

    await context.reportProgress(100);

    console.log(
        `[GithubReactionPoll] Checked ${checked} messages, updated ${updated} with feedback, marked ${deleted} deleted`,
    );

    return {
        success: true,
        data: { checked, updated, deleted },
    };
}
