import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock Prisma ────────────────────────────────────────────────────────────

const mockBroadcastFindMany = vi.fn();
const mockBroadcastFindUnique = vi.fn();
const mockBroadcastCreate = vi.fn();
const mockBroadcastUpdate = vi.fn();

vi.mock('@copilotkit/outpost/db', () => ({
    prisma: {
        broadcast: {
            findMany: (...args: unknown[]) => mockBroadcastFindMany(...args),
            findUnique: (...args: unknown[]) => mockBroadcastFindUnique(...args),
            create: (...args: unknown[]) => mockBroadcastCreate(...args),
            update: (...args: unknown[]) => mockBroadcastUpdate(...args),
        },
    },
    BroadcastAudience: {
        ALL_ACCOUNTS: 'ALL_ACCOUNTS',
        SELECTED_ACCOUNTS: 'SELECTED_ACCOUNTS',
        BY_SENTIMENT: 'BY_SENTIMENT',
    },
    BroadcastStatus: {
        DRAFT: 'DRAFT',
        SENT: 'SENT',
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
import { GET, POST } from '@/app/api/broadcasts/route';
import { GET as GET_BY_ID, PATCH } from '@/app/api/broadcasts/[id]/route';

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

const MOCK_BROADCAST = {
    id: 'bc-1',
    message: 'Hello from Outpost!',
    sendAs: null,
    audience: 'ALL_ACCOUNTS',
    targetAccounts: null,
    status: 'DRAFT',
    sentAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
};

// ─── Helpers ────────────────────────────────────────────────────────────────

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

describe('GET /api/broadcasts', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetServerSession.mockResolvedValue(userSession('tm-1'));
    });

    it('returns all broadcasts', async () => {
        mockBroadcastFindMany.mockResolvedValue([MOCK_BROADCAST]);

        const req = makeGetRequest('http://localhost:3000/api/broadcasts');
        const res = await GET(req as never);
        const body = await res.json();

        expect(body.broadcasts).toHaveLength(1);
        expect(body.total).toBe(1);
    });

    it('returns empty array when no broadcasts exist', async () => {
        mockBroadcastFindMany.mockResolvedValue([]);

        const req = makeGetRequest('http://localhost:3000/api/broadcasts');
        const res = await GET(req as never);
        const body = await res.json();

        expect(body.broadcasts).toHaveLength(0);
    });

    it('filters by status', async () => {
        mockBroadcastFindMany.mockResolvedValue([]);

        const req = makeGetRequest('http://localhost:3000/api/broadcasts?status=DRAFT');
        await GET(req as never);

        expect(mockBroadcastFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ status: 'DRAFT' }),
            }),
        );
    });
});

describe('POST /api/broadcasts', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetServerSession.mockResolvedValue(userSession('tm-1'));
    });

    it('creates a broadcast', async () => {
        mockBroadcastCreate.mockResolvedValue({ ...MOCK_BROADCAST, id: 'bc-new' });

        const req = makeJsonRequest('http://localhost:3000/api/broadcasts', {
            message: 'Test broadcast',
        });
        const res = await POST(req as never);

        expect(res.status).toBe(201);
        expect(mockBroadcastCreate).toHaveBeenCalledTimes(1);
    });

    it('rejects when message is missing', async () => {
        const req = makeJsonRequest('http://localhost:3000/api/broadcasts', {});
        const res = await POST(req as never);

        expect(res.status).toBe(400);
    });

    it('rejects when message exceeds limit', async () => {
        const req = makeJsonRequest('http://localhost:3000/api/broadcasts', {
            message: 'x'.repeat(501),
        });
        const res = await POST(req as never);

        expect(res.status).toBe(400);
    });
});

describe('GET /api/broadcasts/[id]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetServerSession.mockResolvedValue(userSession('tm-1'));
    });

    it('returns broadcast by ID', async () => {
        mockBroadcastFindUnique.mockResolvedValue(MOCK_BROADCAST);

        const req = makeGetRequest('http://localhost:3000/api/broadcasts/bc-1');
        const res = await GET_BY_ID(req as never, { params: Promise.resolve({ id: 'bc-1' }) });
        const body = await res.json();

        expect(body.message).toBe('Hello from Outpost!');
    });

    it('returns 404 for non-existent broadcast', async () => {
        mockBroadcastFindUnique.mockResolvedValue(null);

        const req = makeGetRequest('http://localhost:3000/api/broadcasts/nope');
        const res = await GET_BY_ID(req as never, { params: Promise.resolve({ id: 'nope' }) });

        expect(res.status).toBe(404);
    });
});

describe('PATCH /api/broadcasts/[id]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetServerSession.mockResolvedValue(userSession('tm-1'));
    });

    it('updates a draft broadcast', async () => {
        mockBroadcastFindUnique.mockResolvedValue(MOCK_BROADCAST);
        mockBroadcastUpdate.mockResolvedValue({ ...MOCK_BROADCAST, message: 'Updated' });

        const req = makeJsonRequest('http://localhost:3000/api/broadcasts/bc-1', { message: 'Updated' }, 'PATCH');
        const res = await PATCH(req as never, { params: Promise.resolve({ id: 'bc-1' }) });
        const body = await res.json();

        expect(body.message).toBe('Updated');
    });

    it('rejects updating a sent broadcast', async () => {
        mockBroadcastFindUnique.mockResolvedValue({ ...MOCK_BROADCAST, status: 'SENT' });

        const req = makeJsonRequest('http://localhost:3000/api/broadcasts/bc-1', { message: 'Updated' }, 'PATCH');
        const res = await PATCH(req as never, { params: Promise.resolve({ id: 'bc-1' }) });

        expect(res.status).toBe(400);
    });

    it('returns 404 for non-existent broadcast', async () => {
        mockBroadcastFindUnique.mockResolvedValue(null);

        const req = makeJsonRequest('http://localhost:3000/api/broadcasts/nope', { message: 'Updated' }, 'PATCH');
        const res = await PATCH(req as never, { params: Promise.resolve({ id: 'nope' }) });

        expect(res.status).toBe(404);
    });

    it('rejects empty message', async () => {
        mockBroadcastFindUnique.mockResolvedValue(MOCK_BROADCAST);

        const req = makeJsonRequest('http://localhost:3000/api/broadcasts/bc-1', { message: '' }, 'PATCH');
        const res = await PATCH(req as never, { params: Promise.resolve({ id: 'bc-1' }) });

        expect(res.status).toBe(400);
    });
});
