import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock Prisma ────────────────────────────────────────────────────────────

const mockDocArticleFindMany = vi.fn();
const mockDocArticleFindUnique = vi.fn();
const mockDocArticleCreate = vi.fn();
const mockDocArticleUpdate = vi.fn();
const mockDocArticleCount = vi.fn();
const mockDocCategoryFindMany = vi.fn();
const mockDocCategoryFindUnique = vi.fn();
const mockDocCategoryFindFirst = vi.fn();

vi.mock('@copilotkit/outpost/db', () => ({
    prisma: {
        docArticle: {
            findMany: (...args: unknown[]) => mockDocArticleFindMany(...args),
            findUnique: (...args: unknown[]) => mockDocArticleFindUnique(...args),
            create: (...args: unknown[]) => mockDocArticleCreate(...args),
            update: (...args: unknown[]) => mockDocArticleUpdate(...args),
            count: (...args: unknown[]) => mockDocArticleCount(...args),
        },
        docCategory: {
            findMany: (...args: unknown[]) => mockDocCategoryFindMany(...args),
            findUnique: (...args: unknown[]) => mockDocCategoryFindUnique(...args),
            findFirst: (...args: unknown[]) => mockDocCategoryFindFirst(...args),
        },
    },
}));

// ─── Mock next-auth ─────────────────────────────────────────────────────────

const mockGetServerSession = vi.fn();

vi.mock('next-auth/next', () => ({
    getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

vi.mock('next-auth', () => ({
    getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

vi.mock('@/lib/auth', () => ({
    authOptions: {},
}));

// Import after mocks
import { GET as getArticles, POST as createArticle } from '@/app/api/docs/articles/route';
import { GET as getArticleById, PATCH as patchArticle } from '@/app/api/docs/articles/[id]/route';
import { GET as getCategories } from '@/app/api/docs/categories/route';
import { POST as importLoom } from '@/app/api/docs/import-loom/route';

// ─── Helpers ────────────────────────────────────────────────────────────────

import { NextRequest } from 'next/server';

function makeGetRequest(url: string): NextRequest {
    return new NextRequest(url, { method: 'GET' });
}

function makeJsonRequest(url: string, body: unknown, method = 'POST'): NextRequest {
    return new NextRequest(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

const MOCK_CATEGORY = {
    id: 'cat-1',
    name: 'Getting Started',
    description: 'Quick start guides',
    createdAt: new Date(),
    _count: { articles: 3 },
};

const MOCK_ARTICLE = {
    id: 'art-1',
    title: 'Quick Start Guide',
    content: '# Quick Start',
    status: 'PUBLISHED',
    sourceUrl: null,
    categoryId: 'cat-1',
    category: { id: 'cat-1', name: 'Getting Started' },
    createdAt: new Date(),
    updatedAt: new Date(),
};

// ─── Session helpers ────────────────────────────────────────────────────────

// Writes on these routes are admin-gated (see require-admin); role-tier
// behaviour is covered in api-route-auth.test.ts. These route-logic tests
// authenticate as an authorized admin.
function userSession(memberId = 'tm-1') {
    return {
        user: {
            id: memberId,
            name: 'Test User',
            email: 'test@test.com',
            role: 'ADMIN',
            memberId,
        },
    };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('GET /api/docs/articles', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetServerSession.mockResolvedValue(userSession('tm-1'));
    });

    it('returns all articles', async () => {
        mockDocArticleFindMany.mockResolvedValue([MOCK_ARTICLE]);
        mockDocArticleCount.mockResolvedValue(1);

        const req = makeGetRequest('http://localhost:3000/api/docs/articles');
        const res = await getArticles(req as never);
        const body = await res.json();

        expect(body.articles).toHaveLength(1);
        expect(body.total).toBe(1);
        expect(body.page).toBe(1);
        expect(body.pageSize).toBe(25);
    });

    it('returns empty when no articles exist', async () => {
        mockDocArticleFindMany.mockResolvedValue([]);
        mockDocArticleCount.mockResolvedValue(0);

        const req = makeGetRequest('http://localhost:3000/api/docs/articles');
        const res = await getArticles(req as never);
        const body = await res.json();

        expect(body.articles).toHaveLength(0);
    });

    it('filters by search', async () => {
        mockDocArticleFindMany.mockResolvedValue([]);
        mockDocArticleCount.mockResolvedValue(0);

        const req = makeGetRequest('http://localhost:3000/api/docs/articles?search=quick');
        await getArticles(req as never);

        expect(mockDocArticleFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    OR: expect.arrayContaining([
                        expect.objectContaining({ title: expect.objectContaining({ contains: 'quick' }) }),
                    ]),
                }),
            }),
        );
    });

    it('paginates with take/skip and reports the total from count', async () => {
        mockDocArticleFindMany.mockResolvedValue([MOCK_ARTICLE]);
        mockDocArticleCount.mockResolvedValue(57);

        const req = makeGetRequest('http://localhost:3000/api/docs/articles?page=2&pageSize=10');
        const res = await getArticles(req as never);
        const body = await res.json();

        expect(mockDocArticleFindMany).toHaveBeenCalledWith(
            expect.objectContaining({ take: 10, skip: 10 }),
        );
        expect(body.total).toBe(57);
        expect(body.page).toBe(2);
        expect(body.pageSize).toBe(10);
    });

    it('clamps pageSize to 100', async () => {
        mockDocArticleFindMany.mockResolvedValue([]);
        mockDocArticleCount.mockResolvedValue(0);

        const req = makeGetRequest('http://localhost:3000/api/docs/articles?pageSize=9999');
        const res = await getArticles(req as never);
        const body = await res.json();

        expect(mockDocArticleFindMany).toHaveBeenCalledWith(
            expect.objectContaining({ take: 100 }),
        );
        expect(body.pageSize).toBe(100);
    });
});

describe('POST /api/docs/articles', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetServerSession.mockResolvedValue(userSession('tm-1'));
    });

    it('creates an article', async () => {
        mockDocCategoryFindUnique.mockResolvedValue(MOCK_CATEGORY);
        mockDocArticleCreate.mockResolvedValue(MOCK_ARTICLE);

        const req = makeJsonRequest('http://localhost:3000/api/docs/articles', {
            title: 'New Article',
            categoryId: 'cat-1',
            content: '# New Article',
        });
        const res = await createArticle(req as never);

        expect(res.status).toBe(201);
        expect(mockDocArticleCreate).toHaveBeenCalledTimes(1);
    });

    it('rejects when required fields missing', async () => {
        const req = makeJsonRequest('http://localhost:3000/api/docs/articles', {
            title: 'Missing content and category',
        });
        const res = await createArticle(req as never);

        expect(res.status).toBe(400);
    });

    it('returns 404 when category does not exist', async () => {
        mockDocCategoryFindUnique.mockResolvedValue(null);

        const req = makeJsonRequest('http://localhost:3000/api/docs/articles', {
            title: 'Test',
            categoryId: 'nope',
            content: 'Content',
        });
        const res = await createArticle(req as never);

        expect(res.status).toBe(404);
    });
});

describe('GET /api/docs/articles/[id]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetServerSession.mockResolvedValue(userSession('tm-1'));
    });

    it('returns article by ID', async () => {
        mockDocArticleFindUnique.mockResolvedValue(MOCK_ARTICLE);

        const req = makeGetRequest('http://localhost:3000/api/docs/articles/art-1');
        const res = await getArticleById(req as never, { params: Promise.resolve({ id: 'art-1' }) });
        const body = await res.json();

        expect(body.title).toBe('Quick Start Guide');
    });

    it('returns 404 for non-existent article', async () => {
        mockDocArticleFindUnique.mockResolvedValue(null);

        const req = makeGetRequest('http://localhost:3000/api/docs/articles/nope');
        const res = await getArticleById(req as never, { params: Promise.resolve({ id: 'nope' }) });

        expect(res.status).toBe(404);
    });
});

describe('PATCH /api/docs/articles/[id]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetServerSession.mockResolvedValue(userSession('tm-1'));
    });

    it('updates an article', async () => {
        mockDocArticleFindUnique.mockResolvedValue(MOCK_ARTICLE);
        mockDocArticleUpdate.mockResolvedValue({ ...MOCK_ARTICLE, title: 'Updated Title' });

        const req = makeJsonRequest('http://localhost:3000/api/docs/articles/art-1', { title: 'Updated Title' }, 'PATCH');
        const res = await patchArticle(req as never, { params: Promise.resolve({ id: 'art-1' }) });
        const body = await res.json();

        expect(body.title).toBe('Updated Title');
    });

    it('returns 404 for non-existent article', async () => {
        mockDocArticleFindUnique.mockResolvedValue(null);

        const req = makeJsonRequest('http://localhost:3000/api/docs/articles/nope', { title: 'Test' }, 'PATCH');
        const res = await patchArticle(req as never, { params: Promise.resolve({ id: 'nope' }) });

        expect(res.status).toBe(404);
    });
});

describe('GET /api/docs/categories', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetServerSession.mockResolvedValue(userSession('tm-1'));
    });

    it('returns categories with article counts', async () => {
        mockDocCategoryFindMany.mockResolvedValue([MOCK_CATEGORY]);

        const res = await getCategories();
        const body = await res.json();

        expect(body.categories).toHaveLength(1);
        expect(body.categories[0].articleCount).toBe(3);
    });

    it('returns empty when no categories exist', async () => {
        mockDocCategoryFindMany.mockResolvedValue([]);

        const res = await getCategories();
        const body = await res.json();

        expect(body.categories).toHaveLength(0);
    });
});

describe('POST /api/docs/import-loom', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetServerSession.mockResolvedValue(userSession('tm-1'));
    });

    it('creates an article from a valid Loom URL', async () => {
        mockDocCategoryFindFirst.mockResolvedValue(MOCK_CATEGORY);
        mockDocArticleCreate.mockResolvedValue({
            ...MOCK_ARTICLE,
            id: 'art-loom-1',
            title: 'Article from Loom: abc123',
            sourceUrl: 'https://www.loom.com/share/abc123',
        });

        const req = makeJsonRequest('http://localhost:3000/api/docs/import-loom', {
            url: 'https://www.loom.com/share/abc123',
        });
        const res = await importLoom(req as never);

        expect(res.status).toBe(201);
        expect(mockDocArticleCreate).toHaveBeenCalledTimes(1);
    });

    it('rejects when URL is missing', async () => {
        const req = makeJsonRequest('http://localhost:3000/api/docs/import-loom', {});
        const res = await importLoom(req as never);

        expect(res.status).toBe(400);
    });

    it('rejects invalid Loom URL', async () => {
        const req = makeJsonRequest('http://localhost:3000/api/docs/import-loom', {
            url: 'https://youtube.com/watch?v=123',
        });
        const res = await importLoom(req as never);

        expect(res.status).toBe(400);
    });

    it('rejects malformed URL', async () => {
        const req = makeJsonRequest('http://localhost:3000/api/docs/import-loom', {
            url: 'not-a-url',
        });
        const res = await importLoom(req as never);

        expect(res.status).toBe(400);
    });
});
