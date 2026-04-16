import type { App } from '@slack/bolt';
import { prisma } from '@outpost/db';

export function registerCloseCommand(app: App): void {
    app.command('/outpost-close', async ({ ack, command, client }) => {
        await ack();

        try {
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

            const reason = command.text.trim() || 'Resolved';

            // Update ticket status to CLOSED
            await prisma.ticket.update({
                where: { id: ticket.id },
                data: { status: 'CLOSED' },
            });

            // Add a closing note
            await prisma.note.create({
                data: {
                    ticketId: ticket.id,
                    author: `slack:${command.user_id}`,
                    content: `Ticket closed. Reason: ${reason}`,
                },
            });

            await client.chat.postMessage({
                channel: command.channel_id,
                text: `Ticket ${ticket.displayId} closed. Reason: ${reason}`,
            });

            console.log(`[Slack Bot] Ticket ${ticket.displayId} closed by ${command.user_id}`);
        } catch (error) {
            console.error('[Slack Bot] Error handling /outpost-close:', error);
            await client.chat.postEphemeral({
                channel: command.channel_id,
                user: command.user_id,
                text: 'An error occurred while processing this command.',
            });
        }
    });
}
