/**
 * SLA_CHECK job handler.
 *
 * Runs every 5 minutes via the scheduler.  For each open ticket it:
 *   1. Evaluates SLA compliance (first response + resolution)
 *   2. On new breaches: sets ticket.slaBreachedAt, posts a SYSTEM message,
 *      and logs the breach event
 *   3. Returns a summary of { checked, breached, newBreaches }
 */

import { prisma } from '@outpost/db';
import {
    loadSlaConfig,
    checkSlaCompliance,
    formatDuration,
} from '@outpost/shared';
import type { JobHandler } from '../types.js';
import { JobType } from '../types.js';

export interface SlaCheckSummary {
    checked: number;
    breached: number;
    newBreaches: number;
}

export const handleSlaCheck: JobHandler<typeof JobType.SLA_CHECK> = async (
    _payload,
    context,
) => {
    const targets = await loadSlaConfig(prisma);

    // Fetch all open tickets (any non-closed, non-resolved status)
    const openTickets = await prisma.ticket.findMany({
        where: {
            status: {
                notIn: ['CLOSED', 'RESOLVED'],
            },
        },
        include: {
            messages: {
                select: {
                    type: true,
                    createdAt: true,
                },
                orderBy: { createdAt: 'asc' },
            },
        },
    });

    const now = new Date();
    let breached = 0;
    let newBreaches = 0;

    for (let i = 0; i < openTickets.length; i++) {
        const ticket = openTickets[i];
        const result = checkSlaCompliance(ticket, targets, now);

        const isBreached = result.firstResponseBreached || result.resolutionBreached;
        if (isBreached) {
            breached++;
        }

        // Only flag as a *new* breach if the ticket wasn't already marked
        if (isBreached && !ticket.slaBreachedAt) {
            newBreaches++;

            // Build a human-readable breach message
            const breachParts: string[] = [];
            if (result.firstResponseBreached) {
                breachParts.push(
                    `First response SLA breached — exceeded ${formatDuration(result.target.firstResponseMinutes)}`,
                );
            }
            if (result.resolutionBreached) {
                breachParts.push(
                    `Resolution SLA breached — exceeded ${formatDuration(result.target.resolutionMinutes)}`,
                );
            }

            const breachMessage = breachParts.join('. ');

            // Update ticket and create system message in one transaction
            await prisma.$transaction([
                prisma.ticket.update({
                    where: { id: ticket.id },
                    data: { slaBreachedAt: now },
                }),
                prisma.message.create({
                    data: {
                        ticketId: ticket.id,
                        author: 'System',
                        content: breachMessage,
                        type: 'SYSTEM',
                    },
                }),
            ]);

            console.log(
                `[SLA Check] Breach on ${ticket.displayId}: ${breachMessage}`,
            );
        }

        // Report progress
        const percent = Math.round(((i + 1) / openTickets.length) * 100);
        await context.reportProgress(percent);
    }

    return {
        success: true,
        data: {
            checked: openTickets.length,
            breached,
            newBreaches,
        },
    };
};
