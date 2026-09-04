import { ChannelType, type Message } from 'discord.js';
import { prisma } from '@copilotkit/outpost/db';
import { createJob } from '@copilotkit/outpost/queue';
import { PlatformDiscordAdapter, InboundHandler } from '@copilotkit/outpost/shared/platforms';
import type { CreateJobFn } from '@copilotkit/outpost/shared';
import { config } from '../config.js';
import { isShadowMode, handleShadowMessage } from '../lib/shadow-mode.js';
import { findTicketByThreadId } from '../lib/tickets.js';

/** Adapter instance shared across message-create invocations. */
const adapter = new PlatformDiscordAdapter({ token: config.discordToken });

/**
 * Wrap the queue's createJob into the signature InboundHandler expects.
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

export async function handleMessageCreate(message: Message): Promise<void> {
    // Ignore messages from bots
    if (message.author.bot) return;

    // Only process messages in threads (forum posts are threads)
    if (
        message.channel.type !== ChannelType.PublicThread &&
        message.channel.type !== ChannelType.PrivateThread
    ) {
        return;
    }

    const threadId = message.channel.id;

    // Discord dispatches BOTH ThreadCreate and MessageCreate for a new forum
    // post, and handleThreadCreate has already ingested this exact message as
    // the ticket's first message. Processing it again enqueues a second
    // AI_RESPONSE job for the same ticket, so the same question is retrieved
    // and answered twice. A thread's starter message shares the thread's ID —
    // that identity is what makes this detectable.
    if (message.id === threadId) return;

    try {
        // Look up the ticket associated with this thread (for shadow mode check)
        const ticket = await findTicketByThreadId(threadId);

        // In shadow mode, record the message silently without triggering visible responses
        if (isShadowMode() && ticket) {
            try {
                return await handleShadowMessage(message, ticket.id, threadId);
            } catch (error) {
                console.error(`[Discord Bot] Shadow mode message handling failed for thread ${threadId}:`, error);
                return;
            }
        }

        if (!ticket) {
            // This thread isn't tracked as a ticket, ignore it
            return;
        }

        // Parse the raw message through the platform adapter
        const inboundMessage = adapter.parseInboundEvent({ message });

        // Process through the shared InboundHandler
        const handler = new InboundHandler({ prisma, createJob: createJobFn });
        const result = await handler.handle(inboundMessage);

        console.log(
            `[Discord Bot] Message from ${message.author.tag} processed on ticket ${result.displayId}` +
            (result.aiJobEnqueued ? ' (AI job enqueued)' : ''),
        );
    } catch (error) {
        console.error(
            `[Discord Bot] Failed to process message in thread ${threadId}:`,
            error,
        );
    }
}
