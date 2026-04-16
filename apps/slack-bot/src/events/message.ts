import type { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { prisma } from '@outpost/db';
import { createJob, JobType } from '@outpost/queue';
import { generateTicketId, truncate } from '@outpost/shared';
import { config } from '../config.js';
import { findTicketByThreadTs, isTeamMember, buildPermalink } from '../lib/tickets.js';

/**
 * Register the Slack message event handler.
 *
 * Handles two cases:
 * 1. New top-level messages in monitored channels -> create a ticket
 * 2. Threaded replies to tracked tickets -> append message and maybe enqueue AI response
 */
export function registerMessageHandler(app: App): void {
    app.event('message', async ({ event, client }) => {
        // Only handle regular user messages (not bot messages, edits, deletions, etc.)
        if (event.subtype !== undefined) return;
        if (!('user' in event) || !event.user) return;
        if (!('text' in event) || !event.text) return;
        if ('bot_id' in event && event.bot_id) return;

        const channelId = event.channel;

        // Check if this channel is monitored
        const isMonitored =
            config.monitoredChannelIds.length === 0 ||
            config.monitoredChannelIds.includes(channelId);

        if (!isMonitored) return;

        try {
            const text = 'text' in event ? event.text : undefined;
            const user = 'user' in event ? event.user : undefined;
            if (!text || !user) return;

            if (event.thread_ts) {
                // This is a threaded reply — handle as follow-up message
                await handleThreadReply(
                    { user, text, thread_ts: event.thread_ts, ts: event.ts },
                    channelId,
                    client,
                );
            } else if (event.ts) {
                // This is a new top-level message — create a ticket
                await handleNewMessage(
                    { user, text, ts: event.ts },
                    channelId,
                    client,
                );
            }
        } catch (error) {
            console.error(
                `[Slack Bot] Failed to process message in channel ${channelId}:`,
                error,
            );
        }
    });
}

async function handleNewMessage(
    event: { user: string; text: string; ts: string },
    channelId: string,
    client: WebClient,
): Promise<void> {
    const displayId = generateTicketId();
    const sourceId = `${channelId}:${event.ts}`;
    const sourceUrl = buildPermalink(channelId, event.ts);

    // Look up user info for the author field
    const authorLabel = `slack:${event.user}`;

    // Create the ticket in the database
    const ticket = await prisma.ticket.create({
        data: {
            displayId,
            title: truncate(event.text, 200),
            description: truncate(event.text, 4000),
            status: 'OPEN',
            priority: 'MEDIUM',
            type: 'QUESTION',
            source: 'SLACK',
            sourceId,
            sourceUrl,
            channel: channelId,
        },
    });

    // Create the first Message record
    await prisma.message.create({
        data: {
            ticketId: ticket.id,
            author: authorLabel,
            content: truncate(event.text, 8000),
            type: 'USER',
        },
    });

    // Enqueue an AI response job
    await createJob(JobType.AI_RESPONSE, {
        ticketId: ticket.id,
        threadId: event.ts,
        source: 'slack' as const,
    });

    // Post acknowledgment in thread
    await client.chat.postMessage({
        channel: channelId,
        thread_ts: event.ts,
        text: `\uD83C\uDFAB Ticket ${displayId} created. Our AI assistant is reviewing your question...`,
    });

    console.log(`[Slack Bot] Created ticket ${displayId} for message ${event.ts} in ${channelId}`);
}

async function handleThreadReply(
    event: { user: string; text: string; thread_ts: string; ts: string },
    channelId: string,
    _client: unknown,
): Promise<void> {
    const ticket = await findTicketByThreadTs(channelId, event.thread_ts);
    if (!ticket) {
        // This thread isn't tracked as a ticket, ignore it
        return;
    }

    const authorLabel = `slack:${event.user}`;

    // Append the message as a Message record
    await prisma.message.create({
        data: {
            ticketId: ticket.id,
            author: authorLabel,
            content: truncate(event.text, 8000),
            type: 'USER',
        },
    });

    console.log(
        `[Slack Bot] Message from ${event.user} appended to ticket ${ticket.displayId}`,
    );

    // Check if this user is a team member
    const teamMember = await isTeamMember(event.user);

    if (teamMember) {
        // Team member message: don't enqueue AI response, but update ticket status
        if (ticket.status === 'WAITING_ON_TEAM') {
            await prisma.ticket.update({
                where: { id: ticket.id },
                data: { status: 'WAITING_ON_CUSTOMER' },
            });
        }
    } else {
        // External user: enqueue a new AI response for follow-up
        await createJob(JobType.AI_RESPONSE, {
            ticketId: ticket.id,
            threadId: event.thread_ts,
            source: 'slack' as const,
        });

        // Reopen ticket if it was waiting on customer or resolved
        if (ticket.status === 'WAITING_ON_CUSTOMER' || ticket.status === 'RESOLVED') {
            await prisma.ticket.update({
                where: { id: ticket.id },
                data: { status: 'OPEN' },
            });
        }
    }
}
