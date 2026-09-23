/**
 * Onboarding digest job handler.
 *
 * Consumes ONBOARDING_DIGEST jobs from the queue, queries new members
 * from the last 24 hours, and compiles a formatted digest.
 *
 * Posts the digest to a Discord channel via DISCORD_DIGEST_CHANNEL_ID.
 * Falls back to console.log when the env var is not set (development).
 */

import { prisma } from '@copilotkit/outpost/db';
import { computeFunnelMetrics, isShadowMode } from '@copilotkit/outpost/shared';
import type { OnboardingMember } from '@copilotkit/outpost/shared';
import type { OnboardingDigestPayload, JobResult, JobHandlerContext } from '../types.js';

/**
 * Post a message to a Discord channel using the Discord REST API.
 *
 * Requires DISCORD_TOKEN to be set. Uses the raw fetch API to avoid
 * pulling in the full discord.js dependency for a single REST call.
 */
async function postToDiscord(channelId: string, content: string): Promise<void> {
    const token = process.env.DISCORD_TOKEN;
    if (!token) {
        throw new Error('DISCORD_TOKEN is required to post to Discord');
    }

    const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
            Authorization: `Bot ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content }),
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Discord API error ${response.status}: ${errorBody}`);
    }
}

/**
 * Handle an ONBOARDING_DIGEST job.
 *
 * 1. Parse the target date from the payload
 * 2. Query members who joined in the last 24 hours
 * 3. Compile and deliver a formatted digest
 */
export async function handleOnboardingDigest(
    payload: OnboardingDigestPayload,
    context: JobHandlerContext,
): Promise<JobResult> {
    const targetDate = payload.date || new Date().toISOString().split('T')[0];

    await context.reportProgress(10);

    // Query new members from the last 24 hours
    const since = new Date(targetDate);
    since.setUTCHours(0, 0, 0, 0);

    const until = new Date(since);
    until.setDate(until.getDate() + 1);
    until.setUTCHours(0, 0, 0, 0);

    const newMembers = await prisma.onboardingMember.findMany({
        where: {
            joinedAt: {
                gte: since,
                lt: until,
            },
        },
        orderBy: { joinedAt: 'asc' },
    });

    await context.reportProgress(50);

    // Compile the digest
    const digestLines = [
        `===== Onboarding Digest for ${targetDate} =====`,
        `New members: ${newMembers.length}`,
        '',
    ];

    if (newMembers.length === 0) {
        digestLines.push('No new members joined today.');
    } else {
        digestLines.push('Member List:');
        for (const member of newMembers) {
            const joinTime = new Date(member.joinedAt).toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: true,
                timeZone: 'UTC',
            });
            digestLines.push(`  - ${member.username} (joined at ${joinTime})`);
        }
    }

    await context.reportProgress(70);

    // Compute overall funnel metrics
    const allMembers = await prisma.onboardingMember.findMany();
    const metrics = computeFunnelMetrics(allMembers as unknown as OnboardingMember[]);

    digestLines.push('');
    digestLines.push('Funnel Summary (all time):');
    digestLines.push(`  Joined: ${metrics.stageCounts.JOINED}`);
    digestLines.push(
        `  Contacted: ${metrics.stageCounts.CONTACTED} (${metrics.conversionRates.joinedToContacted}%)`,
    );
    digestLines.push(
        `  Responded: ${metrics.stageCounts.RESPONDED} (${metrics.conversionRates.contactedToResponded}%)`,
    );
    digestLines.push(
        `  Meeting Booked: ${metrics.stageCounts.MEETING_BOOKED} (${metrics.conversionRates.respondedToMeetingBooked}%)`,
    );

    const digest = digestLines.join('\n');

    await context.reportProgress(90);

    // Deliver the digest
    const channelId = process.env.DISCORD_DIGEST_CHANNEL_ID;
    if (isShadowMode()) {
        // Shadow mode (staging): log the digest instead of posting it, so a
        // staging worker never delivers to a real Discord channel.
        console.log(`[Onboarding Digest] Shadow mode — skipping Discord post:\n${digest}`);
    } else if (channelId) {
        await postToDiscord(channelId, digest);
    } else {
        // Development fallback when DISCORD_DIGEST_CHANNEL_ID is not set
        console.log(
            `[Onboarding Digest] DISCORD_DIGEST_CHANNEL_ID not set, logging to console:\n${digest}`,
        );
    }

    await context.reportProgress(100);

    return {
        success: true,
        data: {
            date: targetDate,
            newMemberCount: newMembers.length,
            totalMembers: metrics.totalMembers,
        },
    };
}
