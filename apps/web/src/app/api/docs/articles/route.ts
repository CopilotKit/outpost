import { NextRequest, NextResponse } from 'next/server';
import { requireSession, requireAdmin } from '@/lib/require-admin';
import { prisma } from '@copilotkit/outpost/db';
import type { Prisma } from '@copilotkit/outpost/db';
import {
    articleCreateSchema,
    formatZodError,
    sanitizeSearch,
} from '@/lib/validate';

/**
 * GET /api/docs/articles
 *
 * List articles with optional filters.
 * Query params: category, status, search
 */
export async function GET(request: NextRequest) {
    const { error } = await requireSession();
    if (error) return error;

    const { searchParams } = request.nextUrl;
    const categoryId = searchParams.get('category');
    const status = searchParams.get('status')?.toUpperCase() as 'DRAFT' | 'PUBLISHED' | null;
    const search = sanitizeSearch(searchParams.get('search'));

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

    const articles = await prisma.docArticle.findMany({
        where,
        include: { category: true },
        orderBy: { updatedAt: 'desc' },
    });

    return NextResponse.json({ articles, total: articles.length });
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

        if (
            body.title === undefined ||
            body.categoryId === undefined ||
            body.content === undefined
        ) {
            return NextResponse.json(
                { error: 'title, categoryId, and content are required' },
                { status: 400 },
            );
        }

        const parsed = articleCreateSchema.safeParse(body);
        if (!parsed.success) {
            return NextResponse.json(
                { error: formatZodError(parsed.error) },
                { status: 400 },
            );
        }
        const input = parsed.data;

        // Verify the category exists
        const category = await prisma.docCategory.findUnique({
            where: { id: input.categoryId },
        });

        if (!category) {
            return NextResponse.json(
                { error: 'Category not found' },
                { status: 404 },
            );
        }

        const newArticle = await prisma.docArticle.create({
            data: {
                title: input.title,
                content: input.content,
                status: 'DRAFT',
                sourceUrl: input.sourceUrl || null,
                categoryId: input.categoryId,
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
