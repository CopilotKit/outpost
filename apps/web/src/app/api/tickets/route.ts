import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth';
import { prisma } from '@copilotkit/outpost/db';
import { generateTicketId } from '@copilotkit/outpost/shared';
import {
    TicketStatus,
    TicketPriority,
    TicketType,
    TicketSource,
    Prisma,
} from '@copilotkit/outpost/db';
import {
    ticketCreateSchema,
    formatZodError,
    parsePagination,
    sanitizeSearch,
    ticketStatusFilter,
    ticketSourceFilter,
    ticketPriorityFilter,
    ticketTypeFilter,
} from '@/lib/validate';

/**
 * GET /api/tickets
 *
 * List tickets with optional filters and pagination.
 * Query params: status, source, priority, type, accountId, assigneeId, search, page, pageSize
 */
export async function GET(request: NextRequest) {
    const session = await getServerSession(authOptions);
    if (!session) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const { searchParams } = request.nextUrl;

        const rawStatus = searchParams.getAll('status');
        const rawSource = searchParams.getAll('source');
        const rawPriority = searchParams.getAll('priority');
        const rawType = searchParams.getAll('type');
        const accountId = searchParams.get('accountId') || undefined;
        const assigneeId = searchParams.get('assigneeId') || undefined;
        const search = sanitizeSearch(searchParams.get('search'));
        const { page, pageSize, skip } = parsePagination(searchParams);

        // Unknown enum values are a client bug: report them as 400 instead of
        // letting Prisma throw and returning a 500.
        const status = ticketStatusFilter().parseAll(rawStatus);
        if (!status.ok) {
            return NextResponse.json({ error: status.error }, { status: 400 });
        }
        const source = ticketSourceFilter().parseAll(rawSource);
        if (!source.ok) {
            return NextResponse.json({ error: source.error }, { status: 400 });
        }
        const priority = ticketPriorityFilter().parseAll(rawPriority);
        if (!priority.ok) {
            return NextResponse.json({ error: priority.error }, { status: 400 });
        }
        const type = ticketTypeFilter().parseAll(rawType);
        if (!type.ok) {
            return NextResponse.json({ error: type.error }, { status: 400 });
        }

        const where: Prisma.TicketWhereInput = {};

        if (status.values.length) {
            where.status = { in: status.values };
        }
        if (source.values.length) {
            where.source = { in: source.values };
        }
        if (priority.values.length) {
            where.priority = { in: priority.values };
        }
        if (type.values.length) {
            where.type = { in: type.values };
        }
        if (accountId) {
            where.accountId = accountId;
        }
        if (assigneeId) {
            where.assigneeId = assigneeId;
        }
        if (search) {
            const q = search.toLowerCase();
            where.OR = [
                { title: { contains: q, mode: 'insensitive' } },
                { description: { contains: q, mode: 'insensitive' } },
                { displayId: { contains: q, mode: 'insensitive' } },
                { account: { name: { contains: q, mode: 'insensitive' } } },
                { user: { name: { contains: q, mode: 'insensitive' } } },
            ];
        }

        const [tickets, total] = await Promise.all([
            prisma.ticket.findMany({
                where,
                include: {
                    account: true,
                    user: true,
                    assignee: true,
                    messages: { take: 1, orderBy: { createdAt: 'desc' } },
                },
                orderBy: { createdAt: 'desc' },
                take: pageSize,
                skip,
            }),
            prisma.ticket.count({ where }),
        ]);

        return NextResponse.json({
            tickets,
            total,
            page,
            pageSize,
        });
    } catch (error) {
        console.error('[GET /api/tickets] Error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

/**
 * POST /api/tickets
 *
 * Create a new ticket. Required fields: title, description.
 * Optional: priority, type, source, accountId, assigneeId, userId, sourceUrl, additionalInfo.
 */
export async function POST(request: NextRequest) {
    const session = await getServerSession(authOptions);
    if (!session) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const body = await request.json();

        const parsed = ticketCreateSchema.safeParse(body);
        if (!parsed.success) {
            // Preserve the legacy "required" message when title/description are
            // missing or blank; body may be null (valid JSON), so derive it
            // from the Zod issues instead of reading body.title first.
            const issues = parsed.error.issues;
            const missingRequired = issues.some(
                (i) =>
                    (i.path[0] === 'title' || i.path[0] === 'description') &&
                    (i.code === 'invalid_type' || i.code === 'too_small'),
            );
            if (missingRequired) {
                return NextResponse.json(
                    { error: 'title and description are required' },
                    { status: 400 },
                );
            }
            return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
        }
        const input = parsed.data;

        const ticket = await prisma.ticket.create({
            data: {
                displayId: generateTicketId(),
                title: input.title,
                description: input.description,
                status: TicketStatus.OPEN,
                priority: input.priority ?? TicketPriority.MEDIUM,
                type: input.type ?? TicketType.QUESTION,
                source: input.source ?? TicketSource.MANUAL,
                sourceUrl: input.sourceUrl || null,
                additionalInfo: input.additionalInfo ?? undefined,
                assigneeId: input.assigneeId || null,
                accountId: input.accountId || null,
                userId: input.userId || null,
            },
            include: {
                account: true,
                user: true,
                assignee: true,
                messages: true,
                notes: true,
            },
        });

        return NextResponse.json(ticket, { status: 201 });
    } catch (error) {
        console.error('[POST /api/tickets] Error:', error);
        if (error instanceof SyntaxError) {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
        }
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
