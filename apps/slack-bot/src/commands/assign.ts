import type { App } from '@slack/bolt';
import { prisma } from '@outpost/db';
import { findTicketByThreadTs } from '../lib/tickets.js';

export function registerAssignCommand(app: App): void {
    app.command('/outpost-assign', async ({ ack, command, client }) => {
        await ack();

        try {
            // Parse the user mention from the command text (format: <@USER_ID|username>)
            const userMention = command.text.trim();
            const userMatch = userMention.match(/<@([A-Z0-9]+)(?:\|[^>]*)?>/);

            if (!userMatch) {
                await client.chat.postEphemeral({
                    channel: command.channel_id,
                    user: command.user_id,
                    text: 'Usage: /outpost-assign @user — mention the user to assign.',
                });
                return;
            }

            const assigneeSlackId = userMatch[1];

            // Commands in Slack don't inherently have thread context,
            // but we can check if the command was issued from a thread
            // via the undocumented (but widely used) thread_ts field on message commands.
            // For Slack Connect channels, commands are typically used in threads.
            // We'll need the channel + thread_ts to find the ticket.
            // Slack doesn't pass thread_ts to slash commands, so we fall back
            // to looking for the most recent open ticket in this channel.
            // Ideally the user would use this from a thread bookmark or shortcut.

            // For now: find the most recent open SLACK ticket in this channel
            const ticket = await prisma.ticket.findFirst({
                where: {
                    source: 'SLACK',
                    channel: command.channel_id,
                    status: { not: 'CLOSED' },
                },
                orderBy: { createdAt: 'desc' },
            });

            if (!ticket) {
                await client.chat.postEphemeral({
                    channel: command.channel_id,
                    user: command.user_id,
                    text: 'No open ticket found in this channel. Make sure there is an active ticket.',
                });
                return;
            }

            // Look up team member by Slack user ID
            const dbUser = await prisma.user.findFirst({
                where: { externalId: assigneeSlackId, source: 'SLACK' },
            });

            let assigneeId: string | null = null;
            if (dbUser?.email) {
                const teamMember = await prisma.teamMember.findUnique({
                    where: { email: dbUser.email },
                });
                assigneeId = teamMember?.id ?? null;
            }

            // Update the ticket
            await prisma.ticket.update({
                where: { id: ticket.id },
                data: {
                    assigneeId,
                    status: 'IN_PROGRESS',
                },
            });

            // Log the assignment
            await prisma.note.create({
                data: {
                    ticketId: ticket.id,
                    author: `slack:${command.user_id}`,
                    content: `Assigned to <@${assigneeSlackId}> via /outpost-assign`,
                },
            });

            await client.chat.postMessage({
                channel: command.channel_id,
                text: `Ticket ${ticket.displayId} assigned to <@${assigneeSlackId}> and marked as In Progress.`,
            });

            console.log(`[Slack Bot] Ticket ${ticket.displayId} assigned to ${assigneeSlackId}`);
        } catch (error) {
            console.error('[Slack Bot] Error handling /outpost-assign:', error);
            await client.chat.postEphemeral({
                channel: command.channel_id,
                user: command.user_id,
                text: 'An error occurred while processing this command.',
            });
        }
    });
}
