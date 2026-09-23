import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Mocks ────────────────────────────────────────────────────────────────

const mockTicketFindMany = vi.fn();
const mockTicketCount = vi.fn();
const mockTicketCreate = vi.fn();
const mockBroadcastFindMany = vi.fn();
const mockBroadcastCreate = vi.fn();
const mockDocArticleFindMany = vi.fn();
const mockDocArticleCreate = vi.fn();
const mockDocCategoryFindUnique = vi.fn();

vi.mock('@copilotkit/outpost/db', () => ({
    prisma: {
        ticket: {
            findMany: (...args: unknown[]) => mockTicketFindMany(...args),
            count: (...args: unknown[]) => mockTicketCount(...args),
            create: (...args: unknown[]) => mockTicketCreate(...args),
        },
        broadcast: {
            findMany: (...args: unknown[]) => mockBroadcastFindMany(...args),
            create: (...args: unknown[]) => mockBroadcastCreate(...args),
        },
        docArticle: {
            findMany: (...args: unknown[]) => mockDocArticleFindMany(...args),
            create: (...args: unknown[]) => mockDocArticleCreate(...args),
        },
        docCategory: {
            findUnique: (...args: unknown[]) => mockDocCategoryFindUnique(...args),
        },
    },
    TicketStatus: {
        OPEN: 'OPEN',
        IN_PROGRESS: 'IN_PROGRESS',
        WAITING_ON_CUSTOMER: 'WAITING_ON_CUSTOMER',
        WAITING_ON_TEAM: 'WAITING_ON_TEAM',
        RESOLVED: 'RESOLVED',
        CLOSED: 'CLOSED',
    },
    TicketPriority: { CRITICAL: 'CRITICAL', HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW' },
    TicketType: {
        BUG: 'BUG',
        FEATURE_REQUEST: 'FEATURE_REQUEST',
        QUESTION: 'QUESTION',
        INTEGRATION_HELP: 'INTEGRATION_HELP',
        ACCOUNT_ISSUE: 'ACCOUNT_ISSUE',
        OTHER: 'OTHER',
    },
    TicketSource: {
        DISCORD: 'DISCORD',
        SLACK: 'SLACK',
        GITHUB_ISSUE: 'GITHUB_ISSUE',
        GITHUB_DISCUSSION: 'GITHUB_DISCUSSION',
        WEB: 'WEB',
        EMAIL: 'EMAIL',
        LINEAR: 'LINEAR',
        MANUAL: 'MANUAL',
        ORCA: 'ORCA',
        TEAMS: 'TEAMS',
    },
    BroadcastAudience: {
        ALL_ACCOUNTS: 'ALL_ACCOUNTS',
        SELECTED_ACCOUNTS: 'SELECTED_ACCOUNTS',
        BY_SENTIMENT: 'BY_SENTIMENT',
    },
    BroadcastStatus: { DRAFT: 'DRAFT', SENT: 'SENT' },
    Prisma: {},
}));

vi.mock('@copilotkit/outpost/shared', () => ({
    DEFAULT_PAGE_SIZE: 25,
    MAX_PAGE_SIZE: 100,
    generateTicketId: () => 'TKT-VALIDATION1',
}));

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

vi.mock('@/lib/require-admin', () => ({
    requireSession: vi.fn().mockResolvedValue({}),
    requireAdmin: vi.fn().mockResolvedValue({}),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────

import { GET as ticketsGet, POST as ticketsPost } from '@/app/api/tickets/route';
import { POST as broadcastsPost } from '@/app/api/broadcasts/route';
import { POST as articlesPost } from '@/app/api/docs/articles/route';
import {
    parsePagination,
    sanitizeSearch,
    ticketCreateSchema,
    broadcastCreateSchema,
    articleCreateSchema,
    MAX_TITLE_LENGTH,
    MAX_DESCRIPTION_LENGTH,
    MAX_BROADCAST_LENGTH,
} from '@/lib/validate';

// ─── Helpers ──────────────────────────────────────────────────────────────

function getRequest(url: string): NextRequest {
    return new NextRequest(new URL(url, 'http://localhost:3000'));
}

function jsonRequest(url: string, body: unknown): NextRequest {
    return new NextRequest(new URL(url, 'http://localhost:3000'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

const authedSession = {
    user: { id: 'tm-1', name: 'Test', email: 'test@test.com', role: 'ADMIN', memberId: 'tm-1' },
};

// ─── Unit: pagination ─────────────────────────────────────────────────────

describe('parsePagination', () => {
    it('defaults when params are absent', () => {
        const p = parsePagination(new URLSearchParams());
        expect(p).toEqual({ page: 1, pageSize: 25, skip: 0 });
    });

    it('parses valid values', () => {
        const p = parsePagination(new URLSearchParams('page=3&pageSize=10'));
        expect(p).toEqual({ page: 3, pageSize: 10, skip: 20 });
    });

    it('falls back to defaults for non-numeric input (previously NaN -> Prisma throw)', () => {
        const p = parsePagination(new URLSearchParams('page=abc&pageSize=xyz'));
        expect(p.page).toBe(1);
        expect(p.pageSize).toBe(25);
    });

    it('clamps pageSize to MAX_PAGE_SIZE and page to >= 1', () => {
        const p = parsePagination(new URLSearchParams('page=0&pageSize=9999'));
        expect(p.page).toBe(1);
        expect(p.pageSize).toBe(100);
    });

    it('falls back to page 1 for a huge page that would overflow skip', () => {
        const p = parsePagination(new URLSearchParams('page=99999999999999999999&pageSize=100'));
        expect(p.page).toBe(1);
        expect(p.skip).toBe(0);
        expect(Number.isSafeInteger(p.skip)).toBe(true);
    });
});

describe('sanitizeSearch', () => {
    it('returns undefined for missing/blank search', () => {
        expect(sanitizeSearch(null)).toBeUndefined();
        expect(sanitizeSearch('   ')).toBeUndefined();
    });

    it('truncates overlong search input', () => {
        expect(sanitizeSearch('a'.repeat(500))?.length).toBe(200);
    });
});

// ─── Unit: schemas ────────────────────────────────────────────────────────

describe('ticketCreateSchema', () => {
    const valid = { title: 'Login fails', description: 'Steps to reproduce...' };

    it('accepts a minimal valid payload', () => {
        expect(ticketCreateSchema.safeParse(valid).success).toBe(true);
    });

    it('rejects non-string title/description (previously passed through to Prisma)', () => {
        expect(ticketCreateSchema.safeParse({ ...valid, title: 123 }).success).toBe(false);
        expect(ticketCreateSchema.safeParse({ ...valid, description: ['x'] }).success).toBe(false);
    });

    it('rejects overlong title/description', () => {
        expect(
            ticketCreateSchema.safeParse({ ...valid, title: 't'.repeat(MAX_TITLE_LENGTH + 1) })
                .success,
        ).toBe(false);
        expect(
            ticketCreateSchema.safeParse({
                ...valid,
                description: 'd'.repeat(MAX_DESCRIPTION_LENGTH + 1),
            }).success,
        ).toBe(false);
    });

    it('rejects unknown enum values', () => {
        expect(ticketCreateSchema.safeParse({ ...valid, priority: 'URGENT' }).success).toBe(false);
        expect(ticketCreateSchema.safeParse({ ...valid, source: 'SMS' }).success).toBe(false);
    });
});

describe('broadcastCreateSchema', () => {
    it('rejects an arbitrary audience string (previously a Prisma throw)', () => {
        expect(
            broadcastCreateSchema.safeParse({ message: 'hi', audience: 'EVERYONE' }).success,
        ).toBe(false);
        expect(
            broadcastCreateSchema.safeParse({ message: 'hi', audience: 'ALL_ACCOUNTS' }).success,
        ).toBe(true);
    });

    it('enforces the message length cap', () => {
        expect(
            broadcastCreateSchema.safeParse({ message: 'm'.repeat(MAX_BROADCAST_LENGTH + 1) })
                .success,
        ).toBe(false);
    });
});

describe('articleCreateSchema', () => {
    const valid = { title: 'Guide', content: 'Body', categoryId: 'cat-1' };

    it('accepts a minimal valid payload', () => {
        expect(articleCreateSchema.safeParse(valid).success).toBe(true);
    });

    it('rejects overlong content and blank categoryId', () => {
        expect(
            articleCreateSchema.safeParse({ ...valid, content: 'c'.repeat(100001) }).success,
        ).toBe(false);
        expect(articleCreateSchema.safeParse({ ...valid, categoryId: '  ' }).success).toBe(false);
    });
});

// ─── Route: GET /api/tickets enum validation ──────────────────────────────

describe('GET /api/tickets validation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetServerSession.mockResolvedValue(authedSession);
        mockTicketFindMany.mockResolvedValue([]);
        mockTicketCount.mockResolvedValue(0);
    });

    it('returns 400 for an unknown status value instead of a 500', async () => {
        const res = await ticketsGet(getRequest('/api/tickets?status=BOGUS') as never);
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toContain('BOGUS');
        expect(mockTicketFindMany).not.toHaveBeenCalled();
    });

    it('returns 400 for an unknown priority value', async () => {
        const res = await ticketsGet(getRequest('/api/tickets?priority=URGENT') as never);
        expect(res.status).toBe(400);
        expect(mockTicketFindMany).not.toHaveBeenCalled();
    });

    it('accepts valid enum filters and passes them through', async () => {
        const res = await ticketsGet(getRequest('/api/tickets?status=OPEN&priority=HIGH') as never);
        expect(res.status).toBe(200);
        const where = mockTicketFindMany.mock.calls[0][0].where;
        expect(where.status).toEqual({ in: ['OPEN'] });
        expect(where.priority).toEqual({ in: ['HIGH'] });
    });

    it('survives non-numeric pagination without a Prisma throw', async () => {
        const res = await ticketsGet(getRequest('/api/tickets?page=abc&pageSize=xyz') as never);
        expect(res.status).toBe(200);
        const call = mockTicketFindMany.mock.calls[0][0];
        expect(call.take).toBe(25);
        expect(call.skip).toBe(0);
    });
});

// ─── Route: POST /api/tickets ─────────────────────────────────────────────

describe('POST /api/tickets validation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetServerSession.mockResolvedValue(authedSession);
        mockTicketCreate.mockResolvedValue({ id: 'tkt-1' });
    });

    it('keeps the legacy message when title/description are missing', async () => {
        const res = await ticketsPost(jsonRequest('/api/tickets', {}) as never);
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('title and description are required');
    });

    it('returns 400 (not 500) for a JSON null body', async () => {
        const res = await ticketsPost(jsonRequest('/api/tickets', null) as never);
        expect(res.status).toBe(400);
        expect(mockTicketCreate).not.toHaveBeenCalled();
    });

    it('returns 400 for a non-string title', async () => {
        const res = await ticketsPost(
            jsonRequest('/api/tickets', { title: 123, description: 'desc' }) as never,
        );
        expect(res.status).toBe(400);
        expect(mockTicketCreate).not.toHaveBeenCalled();
    });

    it('returns 400 for an overlong title', async () => {
        const res = await ticketsPost(
            jsonRequest('/api/tickets', {
                title: 't'.repeat(MAX_TITLE_LENGTH + 1),
                description: 'desc',
            }) as never,
        );
        expect(res.status).toBe(400);
        expect(mockTicketCreate).not.toHaveBeenCalled();
    });

    it('returns 400 for an unknown priority', async () => {
        const res = await ticketsPost(
            jsonRequest('/api/tickets', {
                title: 't',
                description: 'd',
                priority: 'URGENT',
            }) as never,
        );
        expect(res.status).toBe(400);
        expect(mockTicketCreate).not.toHaveBeenCalled();
    });

    it('creates the ticket for a valid payload with defaults', async () => {
        const res = await ticketsPost(
            jsonRequest('/api/tickets', { title: 't', description: 'd' }) as never,
        );
        expect(res.status).toBe(201);
        const data = mockTicketCreate.mock.calls[0][0].data;
        expect(data.priority).toBe('MEDIUM');
        expect(data.type).toBe('QUESTION');
        expect(data.source).toBe('MANUAL');
    });
});

// ─── Route: POST /api/broadcasts ──────────────────────────────────────────

describe('POST /api/broadcasts validation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockBroadcastCreate.mockResolvedValue({ id: 'bc-1' });
    });

    it('returns 400 for an arbitrary audience string', async () => {
        const res = await broadcastsPost(
            jsonRequest('/api/broadcasts', { message: 'hello', audience: 'EVERYONE' }) as never,
        );
        expect(res.status).toBe(400);
        expect(mockBroadcastCreate).not.toHaveBeenCalled();
    });

    it('accepts a valid audience and persists it', async () => {
        const res = await broadcastsPost(
            jsonRequest('/api/broadcasts', {
                message: 'hello',
                audience: 'SELECTED_ACCOUNTS',
                targetAccounts: ['acc-1'],
            }) as never,
        );
        expect(res.status).toBe(201);
        const data = mockBroadcastCreate.mock.calls[0][0].data;
        expect(data.audience).toBe('SELECTED_ACCOUNTS');
        expect(data.targetAccounts).toEqual(['acc-1']);
    });
});

// ─── Route: POST /api/docs/articles ───────────────────────────────────────

describe('POST /api/docs/articles validation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockDocCategoryFindUnique.mockResolvedValue({ id: 'cat-1' });
        mockDocArticleCreate.mockResolvedValue({ id: 'art-1' });
    });

    it('returns 400 for an overlong title', async () => {
        const res = await articlesPost(
            jsonRequest('/api/docs/articles', {
                title: 't'.repeat(MAX_TITLE_LENGTH + 1),
                content: 'body',
                categoryId: 'cat-1',
            }) as never,
        );
        expect(res.status).toBe(400);
        expect(mockDocArticleCreate).not.toHaveBeenCalled();
    });

    it('returns 400 for a non-string content body', async () => {
        const res = await articlesPost(
            jsonRequest('/api/docs/articles', {
                title: 't',
                content: { block: 1 },
                categoryId: 'cat-1',
            }) as never,
        );
        expect(res.status).toBe(400);
        expect(mockDocArticleCreate).not.toHaveBeenCalled();
    });
});
