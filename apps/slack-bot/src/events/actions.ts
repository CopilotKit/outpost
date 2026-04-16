import type { App } from '@slack/bolt';
import { prisma } from '@outpost/db';
import { createJob, JobType } from '@outpost/queue';
import { findTicketByThreadTs } from '../lib/tickets.js';

/**
 * Register Slack Block Kit action handlers (button clicks).
 */
export function registerActionHandlers(app: App): void {
    app.action('issue_solved', async ({ ack, body, client }) => {
        await ack();

        try {
            const channelId = body.channel?.id;
            const threadTs = 'message' in body ? body.message?.thread_ts : undefined;

            if (!channelId || !threadTs) {
                console.warn('[Slack Bot] issue_solved action missing channel or thread context');
                return;
            }

            const ticket = await findTicketByThreadTs(channelId, threadTs);
            if (!ticket) {
                await client.chat.postMessage({
                    channel: channelId,
                    thread_ts: threadTs,
                    text: 'No ticket found for this thread.',
                });
                return;
            }

            const userId = body.user.id;

            // Update ticket status to CLOSED
            await prisma.ticket.update({
                where: { id: ticket.id },
                data: { status: 'CLOSED' },
            });

            // Log the resolution as a system message
            await prisma.message.create({
                data: {
                    ticketId: ticket.id,
                    author: `slack:${userId}`,
                    content: 'Issue marked as solved by user.',
                    type: 'SYSTEM',
                },
            });

            await client.chat.postMessage({
                channel: channelId,
                thread_ts: threadTs,
                text: 'Glad we could help! \uD83C\uDF89',
            });

            console.log(`[Slack Bot] Ticket ${ticket.displayId} closed via "Issue Solved" button`);
        } catch (error) {
            console.error('[Slack Bot] Error handling issue_solved action:', error);
        }
    });

    app.action('need_more_help', async ({ ack, body, client }) => {
        await ack();

        try {
            const channelId = body.channel?.id;
            const threadTs = 'message' in body ? body.message?.thread_ts : undefined;

            if (!channelId || !threadTs) {
                console.warn('[Slack Bot] need_more_help action missing channel or thread context');
                return;
            }

            const ticket = await findTicketByThreadTs(channelId, threadTs);
            if (!ticket) {
                await client.chat.postMessage({
                    channel: channelId,
                    thread_ts: threadTs,
                    text: 'No ticket found for this thread.',
                });
                return;
            }

            const userId = body.user.id;

            // Update ticket to waiting on team
            await prisma.ticket.update({
                where: { id: ticket.id },
                data: { status: 'WAITING_ON_TEAM' },
            });

            // Enqueue an escalation notification
            await createJob(JobType.ESCALATION, {
                ticketId: ticket.id,
                reason: `User requested more help via "Need more help" button in Slack thread ${threadTs}`,
            });

            // Log the escalation
            await prisma.message.create({
                data: {
                    ticketId: ticket.id,
                    author: `slack:${userId}`,
                    content: 'User requested more help. Escalating to team.',
                    type: 'SYSTEM',
                },
            });

            await client.chat.postMessage({
                channel: channelId,
                thread_ts: threadTs,
                text: 'A team member has been notified and will follow up shortly.',
            });

            console.log(`[Slack Bot] Ticket ${ticket.displayId} escalated via "Need more help" button`);
        } catch (error) {
            console.error('[Slack Bot] Error handling need_more_help action:', error);
        }
    });
}
