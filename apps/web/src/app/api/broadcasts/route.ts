import { NextRequest, NextResponse } from 'next/server';
import { requireSession, requireAdmin } from '@/lib/require-admin';
import { prisma } from '@copilotkit/outpost/db';
import type { Prisma, BroadcastStatus } from '@copilotkit/outpost/db';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@copilotkit/outpost/shared';

const MAX_BROADCAST_LENGTH = 500;

/**
 * GET /api/broadcasts
 *
 * List broadcasts with optional status filter and pagination.
 * Query params: status (DRAFT | SENT), page, pageSize
 */
export async function GET(request: NextRequest) {
    const { error } = await requireSession();
    if (error) return error;

    const { searchParams } = request.nextUrl;
    const status = searchParams.get('status')?.toUpperCase() as BroadcastStatus | null;

    const rawPage = Number.parseInt(searchParams.get('page') ?? '', 10);
    const rawPageSize = Number.parseInt(searchParams.get('pageSize') ?? '', 10);
    const MAX_PAGE = 10000;
    const page =
        Number.isSafeInteger(rawPage) && rawPage >= 1 && rawPage <= MAX_PAGE ? rawPage : 1;
    const pageSize = Number.isFinite(rawPageSize)
        ? Math.min(MAX_PAGE_SIZE, Math.max(1, rawPageSize))
        : DEFAULT_PAGE_SIZE;

    const where: Prisma.BroadcastWhereInput = {};
    if (status && (status === 'DRAFT' || status === 'SENT')) {
        where.status = status;
    }

    const [broadcasts, total] = await Promise.all([
        prisma.broadcast.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: pageSize,
            skip: (page - 1) * pageSize,
        }),
        prisma.broadcast.count({ where }),
    ]);

    return NextResponse.json({ broadcasts, total, page, pageSize });
}

/**
 * POST /api/broadcasts
 *
 * Create a new broadcast (draft or send immediately).
 * Body: { message, status?, audience?, targetAccounts?, sendAs? }
 */
export async function POST(request: NextRequest) {
    const { error } = await requireAdmin();
    if (error) return error;

    try {
        const body = await request.json();

        if (!body.message || typeof body.message !== 'string') {
            return NextResponse.json(
                { error: 'message is required' },
                { status: 400 },
            );
        }

        if (body.message.length > MAX_BROADCAST_LENGTH) {
            return NextResponse.json(
                { error: `message exceeds ${MAX_BROADCAST_LENGTH} character limit` },
                { status: 400 },
            );
        }

        const status: BroadcastStatus = body.status === 'SENT' ? 'SENT' : 'DRAFT';
        const audience = body.audience || 'ALL_ACCOUNTS';

        const newBroadcast = await prisma.broadcast.create({
            data: {
                message: body.message,
                sendAs: body.sendAs || null,
                audience,
                targetAccounts: body.targetAccounts || null,
                status,
                sentAt: status === 'SENT' ? new Date() : null,
            },
        });

        return NextResponse.json(newBroadcast, { status: 201 });
    } catch {
        return NextResponse.json(
            { error: 'Invalid request body' },
            { status: 400 },
        );
    }
}
