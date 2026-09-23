import { NextRequest, NextResponse } from 'next/server';
import { requireSession, requireAdmin } from '@/lib/require-admin';
import { prisma } from '@copilotkit/outpost/db';
import type { Prisma, BroadcastStatus } from '@copilotkit/outpost/db';
import { broadcastCreateSchema, formatZodError } from '@/lib/validate';

/**
 * GET /api/broadcasts
 *
 * List broadcasts with optional status filter.
 * Query params: status (DRAFT | SENT)
 */
export async function GET(request: NextRequest) {
    const { error } = await requireSession();
    if (error) return error;

    const { searchParams } = request.nextUrl;
    const status = searchParams.get('status')?.toUpperCase() as BroadcastStatus | null;

    const where: Prisma.BroadcastWhereInput = {};
    if (status && (status === 'DRAFT' || status === 'SENT')) {
        where.status = status;
    }

    const broadcasts = await prisma.broadcast.findMany({
        where,
        orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json({ broadcasts, total: broadcasts.length });
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

        const parsed = broadcastCreateSchema.safeParse(body);
        if (!parsed.success) {
            // body may be null (valid JSON); derive the legacy message from
            // the Zod issues instead of reading body.message first.
            const missingMessage = parsed.error.issues.some(
                (i) =>
                    i.path[0] === 'message' &&
                    (i.code === 'invalid_type' || i.code === 'too_small'),
            );
            if (missingMessage) {
                return NextResponse.json({ error: 'message is required' }, { status: 400 });
            }
            return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
        }
        const input = parsed.data;

        // `audience` is a Prisma enum (ALL_ACCOUNTS | SELECTED_ACCOUNTS |
        // BY_SENTIMENT): an arbitrary string here used to become a Prisma
        // throw. The schema above rejects it with a 400 instead.
        const status: BroadcastStatus = input.status ?? 'DRAFT';
        const audience = input.audience ?? 'ALL_ACCOUNTS';

        const newBroadcast = await prisma.broadcast.create({
            data: {
                message: input.message,
                sendAs: input.sendAs || null,
                audience,
                // Omit when absent so the column keeps its DB default (null);
                // a previous `|| null` passed a bare null that Prisma's
                // Json-input type rejects.
                targetAccounts: input.targetAccounts ?? undefined,
                status,
                sentAt: status === 'SENT' ? new Date() : null,
            },
        });

        return NextResponse.json(newBroadcast, { status: 201 });
    } catch {
        return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
}
