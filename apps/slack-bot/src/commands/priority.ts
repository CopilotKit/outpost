import type { App } from '@slack/bolt';
import { prisma } from '@outpost/db';

const VALID_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
type PriorityLevel = (typeof VALID_PRIORITIES)[number];

const PRIORITY_MAP: Record<PriorityLevel, 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'> = {
    critical: 'CRITICAL',
    high: 'HIGH',
    medium: 'MEDIUM',
    low: 'LOW',
};

export function registerPriorityCommand(app: App): void {
    app.command('/outpost-priority', async ({ ack, command, client }) => {
        await ack();

        try {
            const level = command.text.trim().toLowerCase() as PriorityLevel;

            if (!VALID_PRIORITIES.includes(level)) {
                await client.chat.postEphemeral({
                    channel: command.channel_id,
                    user: command.user_id,
                    text: `Invalid priority level. Choose one of: ${VALID_PRIORITIES.join(', ')}`,
                });
                return;
            }

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

            const dbPriority = PRIORITY_MAP[level];

            await prisma.ticket.update({
                where: { id: ticket.id },
                data: { priority: dbPriority },
            });

            // Log the priority change
            await prisma.note.create({
                data: {
                    ticketId: ticket.id,
                    author: `slack:${command.user_id}`,
                    content: `Priority changed from ${ticket.priority} to ${dbPriority}`,
                },
            });

            await client.chat.postMessage({
                channel: command.channel_id,
                text: `Ticket ${ticket.displayId} priority updated to ${dbPriority}.`,
            });

            console.log(`[Slack Bot] Ticket ${ticket.displayId} priority changed to ${dbPriority}`);
        } catch (error) {
            console.error('[Slack Bot] Error handling /outpost-priority:', error);
            await client.chat.postEphemeral({
                channel: command.channel_id,
                user: command.user_id,
                text: 'An error occurred while processing this command.',
            });
        }
    });
}
