import { ChannelType, type ThreadChannel } from 'discord.js';
import { prisma } from '@copilotkit/outpost/db';
import { createJob } from '@copilotkit/outpost/queue';
import { PlatformDiscordAdapter, InboundHandler } from '@copilotkit/outpost/shared/platforms';
import { generateTicketId, isSupportRequest } from '@copilotkit/outpost/shared';
import type { CreateJobFn } from '@copilotkit/outpost/shared';
import { config } from '../config.js';
import { isShadowMode, handleShadowThreadCreate } from '../lib/shadow-mode.js';

/** Adapter instance shared across thread-create invocations. */
const adapter = new PlatformDiscordAdapter({ token: config.discordToken });

/**
 * Wrap the queue's createJob into the signature InboundHandler expects.
 * The queue createJob is generic over JobType; InboundHandler just needs
 * (type: string, payload: { ticketId, threadId?, source }) => Promise<string>.
 */
const createJobFn: CreateJobFn = async (
    type: string,
    payload: { ticketId: string; threadId?: string; source: string },
) => {
    return createJob(
        type as Parameters<typeof createJob>[0],
        payload as Parameters<typeof createJob>[1],
    );
};

/** Log the unconfigured-channel warning once, not once per thread. */
let warnedUnconfiguredChannels = false;
function warnUnconfiguredChannels(): void {
    if (warnedUnconfiguredChannels) return;
    warnedUnconfiguredChannels = true;
    console.warn(
        '[Discord Bot] MONITORED_CHANNEL_IDS is empty — ignoring all threads. ' +
            'Set it to the forum channel IDs Outpost should answer in.',
    );
}

/**
 * A forum post's title often carries the question while the body carries the
 * repro, so both are considered. The bot's own application ID doubles as its
 * user ID, so an @-mention of the bot always qualifies.
 */
function shouldAnswer(threadName: string, content: string): boolean {
    return isSupportRequest(`${threadName}\n${content}`, { botUserId: config.clientId });
}

export async function handleThreadCreate(thread: ThreadChannel, newlyCreated: boolean): Promise<void> {
    if (!newlyCreated) return;

    // Only monitor threads in configured forum channels
    const parentId = thread.parentId;
    if (!parentId) return;

    // Fail CLOSED on an unset MONITORED_CHANNEL_IDS. Treating "empty" as
    // "every channel" meant a missing env var silently opted the whole guild
    // into a retrieval + generation cycle per thread.
    if (config.monitoredChannelIds.length === 0) {
        warnUnconfiguredChannels();
        return;
    }

    if (!config.monitoredChannelIds.includes(parentId)) return;

    // Only handle public/private threads (includes forum posts)
    if (
        thread.type !== ChannelType.PublicThread &&
        thread.type !== ChannelType.PrivateThread
    ) {
        return;
    }

    // In shadow mode, create the ticket silently without posting to Discord
    if (isShadowMode()) {
        const starterMessage = await thread.fetchStarterMessage();
        const content = starterMessage?.content ?? '';
        if (!shouldAnswer(thread.name, content)) {
            console.log(
                `[Discord Bot] Thread ${thread.id} does not read as a support request, skipping`,
            );
            return;
        }
        const authorTag = starterMessage?.author.tag ?? 'Unknown';
        const authorId = starterMessage?.author.id ?? '';
        const displayId = generateTicketId();
        try {
            return void await handleShadowThreadCreate(thread, displayId, content, authorTag, authorId);
        } catch (error) {
            console.error(`[Discord Bot] Shadow mode thread handling failed for thread ${thread.id}:`, error);
            return;
        }
    }

    console.log(
        `[Discord Bot] New thread created: ${thread.name} in #${thread.parent?.name ?? 'unknown'}`,
    );

    try {
        // Fetch the starter message (first message in the thread)
        const starterMessage = await thread.fetchStarterMessage();

        // Announcements and release notes are threads too — only spend a full
        // retrieval + generation cycle on something that reads like a question.
        if (!shouldAnswer(thread.name, starterMessage?.content ?? '')) {
            console.log(
                `[Discord Bot] Thread ${thread.id} does not read as a support request, skipping`,
            );
            return;
        }

        // Parse the raw event through the platform adapter
        const inboundMessage = adapter.parseInboundEvent({
            thread,
            starterMessage,
        });

        // Process through the shared InboundHandler
        const handler = new InboundHandler({ prisma, createJob: createJobFn });
        const result = await handler.handle(inboundMessage);

        // No acknowledgment post. This used to announce
        // "\uD83C\uDFAB Ticket TKT-XXXXXXXX created..." in the thread, which leaked an
        // internal identifier to the public server and spent a bot message
        // saying nothing the reporter can act on. displayId is for the dashboard
        // and team slash commands only — never for reporter-facing copy.
        // The AI response itself is the only message the reporter needs.

        console.log(`[Discord Bot] Created ticket ${result.displayId} for thread ${thread.id}`);
    } catch (error) {
        console.error(`[Discord Bot] Failed to create ticket for thread ${thread.id}:`, error);
    }
}
