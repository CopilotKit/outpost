import type { App } from '@slack/bolt';
import { prisma } from '@outpost/db';
import { createJob, JobType } from '@outpost/queue';

export function registerEscalateCommand(app: App): void {
    app.command('/outpost-escalate', async ({ ack, command, client }) => {
        await ack();

        try {
            const reason = command.text.trim() || 'Needs engineering attention';

            // Find the most recent open ticket in this channel
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
                    text: 'No open ticket found in this channel.',
                });
                return;
            }

            // Escalate: bump priority to HIGH if currently below it
            const escalatedPriority =
                ticket.priority === 'CRITICAL' ? 'CRITICAL' : 'HIGH';

            await prisma.ticket.update({
                where: { id: ticket.id },
                data: {
                    priority: escalatedPriority,
                    status: 'WAITING_ON_TEAM',
                },
            });

            // Add escalation note
            await prisma.note.create({
                data: {
                    ticketId: ticket.id,
                    author: `slack:${command.user_id}`,
                    content: `Escalated. Reason: ${reason}`,
                },
            });

            // Enqueue escalation notification
            await createJob(JobType.ESCALATION, {
                ticketId: ticket.id,
                reason: `Escalated by slack:${command.user_id}: ${reason}`,
            });

            await client.chat.postMessage({
                channel: command.channel_id,
                text: `Ticket ${ticket.displayId} escalated to ${escalatedPriority} priority. Reason: ${reason}`,
            });

            console.log(`[Slack Bot] Ticket ${ticket.displayId} escalated by ${command.user_id}`);
        } catch (error) {
            console.error('[Slack Bot] Error handling /outpost-escalate:', error);
            await client.chat.postEphemeral({
                channel: command.channel_id,
                user: command.user_id,
                text: 'An error occurred while processing this command.',
            });
        }
    });
}
