import { NextRequest, NextResponse } from 'next/server';
import { requireSession, requireAdmin } from '@/lib/require-admin';
import { prisma } from '@copilotkit/outpost/db';
import type { Prisma } from '@copilotkit/outpost/db';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@copilotkit/outpost/shared';

/**
 * GET /api/docs/articles
 *
 * List articles with optional filters and pagination.
 * Query params: category, status, search, page, pageSize
 */
export async function GET(request: NextRequest) {
    const { error } = await requireSession();
    if (error) return error;

    const { searchParams } = request.nextUrl;
    const categoryId = searchParams.get('category');
    const status = searchParams.get('status')?.toUpperCase() as 'DRAFT' | 'PUBLISHED' | null;
    const search = searchParams.get('search');

    const rawPage = Number.parseInt(searchParams.get('page') ?? '', 10);
    const rawPageSize = Number.parseInt(searchParams.get('pageSize') ?? '', 10);
    const MAX_PAGE = 10000;
    const page =
        Number.isSafeInteger(rawPage) && rawPage >= 1 && rawPage <= MAX_PAGE ? rawPage : 1;
    const pageSize = Number.isFinite(rawPageSize)
        ? Math.min(MAX_PAGE_SIZE, Math.max(1, rawPageSize))
        : DEFAULT_PAGE_SIZE;

    const where: Prisma.DocArticleWhereInput = {};

    if (categoryId) {
        where.categoryId = categoryId;
    }

    if (status && (status === 'DRAFT' || status === 'PUBLISHED')) {
        where.status = status;
    }

    if (search) {
        where.OR = [
            { title: { contains: search, mode: 'insensitive' } },
            { content: { contains: search, mode: 'insensitive' } },
        ];
    }

    const [articles, total] = await Promise.all([
        prisma.docArticle.findMany({
            where,
            include: { category: true },
            orderBy: { updatedAt: 'desc' },
            take: pageSize,
            skip: (page - 1) * pageSize,
        }),
        prisma.docArticle.count({ where }),
    ]);

    return NextResponse.json({ articles, total, page, pageSize });
}

/**
 * POST /api/docs/articles
 *
 * Create a new article. Required: title, categoryId, content.
 */
export async function POST(request: NextRequest) {
    const { error } = await requireAdmin();
    if (error) return error;

    try {
        const body = await request.json();

        if (!body.title || !body.categoryId || !body.content) {
            return NextResponse.json(
                { error: 'title, categoryId, and content are required' },
                { status: 400 },
            );
        }

        // Verify the category exists
        const category = await prisma.docCategory.findUnique({
            where: { id: body.categoryId },
        });

        if (!category) {
            return NextResponse.json(
                { error: 'Category not found' },
                { status: 404 },
            );
        }

        const newArticle = await prisma.docArticle.create({
            data: {
                title: body.title,
                content: body.content,
                status: 'DRAFT',
                sourceUrl: body.sourceUrl || null,
                categoryId: body.categoryId,
            },
            include: { category: true },
        });

        return NextResponse.json(newArticle, { status: 201 });
    } catch {
        return NextResponse.json(
            { error: 'Invalid request body' },
            { status: 400 },
        );
    }
}
