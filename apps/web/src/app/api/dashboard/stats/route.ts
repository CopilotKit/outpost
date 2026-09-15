import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth';
import { prisma } from '@copilotkit/outpost/db';
import { TicketStatus, MessageType } from '@copilotkit/outpost/db';
import {
    resolveMonthKey,
    monthWindow,
    monthLabel,
    listMonths,
} from '@/lib/month-window';

/**
 * GET /api/dashboard/stats?month=YYYY-MM
 *
 * Returns SLA metrics, ticket counts, and daily trend data for the
 * requested month. An absent, malformed, or out-of-range month falls
 * back to the current month rather than erroring — a bad query param
 * must not blank the dashboard.
 */
export async function GET(request: Request) {
    const session = await getServerSession(authOptions);
    if (!session) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const now = new Date();

        // Fetched first: resolveMonthKey needs the oldest ticket to know which
        // months are in range, and the newest to pick the default month.
        const [oldestTicket, newestTicket] = await Promise.all([
            prisma.ticket.findFirst({
                orderBy: { createdAt: 'asc' },
                select: { createdAt: true },
            }),
            prisma.ticket.findFirst({
                orderBy: { createdAt: 'desc' },
                select: { createdAt: true },
            }),
        ]);
        const oldest = oldestTicket?.createdAt ?? null;
        const newest = newestTicket?.createdAt ?? null;

        const url = new URL(request.url);
        const monthKey = resolveMonthKey(url.searchParams.get('month'), oldest, newest, now);
        const { start: monthStart, end: monthEnd, daysInMonth } = monthWindow(monthKey);

        // Run aggregate queries in parallel
        const [
            totalTickets,
            openTickets,
            slaBreaches,
            ticketsWithFirstResponse,
            resolvedTickets,
            monthlyTickets,
        ] = await Promise.all([
            // Scoped to the selected month so the figure matches the chart
            // beside it.
            prisma.ticket.count({
                where: { createdAt: { gte: monthStart, lte: monthEnd } },
            }),
            prisma.ticket.count({
                where: {
                    status: {
                        in: [
                            TicketStatus.OPEN,
                            TicketStatus.IN_PROGRESS,
                            TicketStatus.WAITING_ON_CUSTOMER,
                            TicketStatus.WAITING_ON_TEAM,
                        ],
                    },
                },
            }),
            // Left all-time and untouched: PR 2 removes this field together
            // with the SLA Breaches card that reads it.
            prisma.ticket.count({
                where: { slaBreachedAt: { not: null } },
            }),
            // Get tickets with their first non-system, non-user-authored message for avg first response.
            // Scoped to the selected month: previously this loaded the entire
            // ticket table on every dashboard view and the average ignored
            // the month picker beside it.
            prisma.ticket.findMany({
                where: {
                    createdAt: { gte: monthStart, lte: monthEnd },
                },
                select: {
                    createdAt: true,
                    user: { select: { name: true } },
                    messages: {
                        where: {
                            type: { not: MessageType.SYSTEM },
                        },
                        orderBy: { createdAt: 'asc' },
                        take: 5, // Take a few to find the first agent/bot reply
                    },
                },
            }),
            // Resolved/closed tickets created in the selected month for avg
            // resolution time. Previously unbounded: every resolved ticket
            // ever was loaded to compute an "all-time" number that did not
            // match the selected month.
            prisma.ticket.findMany({
                where: {
                    status: { in: [TicketStatus.RESOLVED, TicketStatus.CLOSED] },
                    createdAt: { gte: monthStart, lte: monthEnd },
                },
                select: {
                    createdAt: true,
                    updatedAt: true,
                },
            }),
            // Monthly tickets for trend
            prisma.ticket.findMany({
                where: {
                    createdAt: {
                        gte: monthStart,
                        lte: monthEnd,
                    },
                },
                select: { createdAt: true },
            }),
        ]);

        // Compute avg first response time
        const firstResponseTimesMs: number[] = [];
        for (const ticket of ticketsWithFirstResponse) {
            const created = ticket.createdAt.getTime();
            // First response = first message that isn't from the user or system
            const firstResponse = ticket.messages.find(
                (m: { type: string; createdAt: Date }) => m.type !== 'USER' && m.type !== 'SYSTEM',
            );
            if (firstResponse) {
                firstResponseTimesMs.push(firstResponse.createdAt.getTime() - created);
            }
        }

        const avgFirstResponseMs =
            firstResponseTimesMs.length > 0
                ? firstResponseTimesMs.reduce((a, b) => a + b, 0) / firstResponseTimesMs.length
                : 0;

        // Compute avg resolution time
        const resolutionTimesMs: number[] = [];
        for (const ticket of resolvedTickets) {
            resolutionTimesMs.push(ticket.updatedAt.getTime() - ticket.createdAt.getTime());
        }

        const avgResolutionMs =
            resolutionTimesMs.length > 0
                ? resolutionTimesMs.reduce((a, b) => a + b, 0) / resolutionTimesMs.length
                : 0;

        // Build daily trend for the selected month
        const dailyCounts: number[] = new Array(daysInMonth).fill(0);

        for (const ticket of monthlyTickets) {
            const day = ticket.createdAt.getDate();
            if (day >= 1 && day <= daysInMonth) {
                dailyCounts[day - 1]++;
            }
        }

        const trend = dailyCounts.map((count, i) => ({
            day: i + 1,
            count,
        }));

        return NextResponse.json({
            slaBreaches,
            avgFirstResponseMs,
            avgResolutionMs,
            totalTickets,
            openTickets,
            trend,
            month: monthLabel(monthKey),
            monthKey,
            availableMonths: listMonths(oldest, now),
            year: monthWindow(monthKey).start.getFullYear(),
        });
    } catch (error) {
        console.error('[GET /api/dashboard/stats] Error:', error);
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 },
        );
    }
}
