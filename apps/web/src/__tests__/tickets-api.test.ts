import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Mock Prisma ────────────────────────────────────────────────────────────

const mockTicketFindMany = vi.fn();
const mockTicketFindFirst = vi.fn();
const mockTicketFindUnique = vi.fn();
const mockTicketCount = vi.fn();
const mockTicketCreate = vi.fn();
const mockTicketUpdate = vi.fn();
const mockMessageFindMany = vi.fn();
const mockMessageCreate = vi.fn();

vi.mock('@copilotkit/outpost/db', () => ({
    prisma: {
        ticket: {
            findMany: (...args: unknown[]) => mockTicketFindMany(...args),
            findFirst: (...args: unknown[]) => mockTicketFindFirst(...args),
            findUnique: (...args: unknown[]) => mockTicketFindUnique(...args),
            count: (...args: unknown[]) => mockTicketCount(...args),
            create: (...args: unknown[]) => mockTicketCreate(...args),
            update: (...args: unknown[]) => mockTicketUpdate(...args),
        },
        message: {
            findMany: (...args: unknown[]) => mockMessageFindMany(...args),
            create: (...args: unknown[]) => mockMessageCreate(...args),
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
    TicketPriority: {
        CRITICAL: 'CRITICAL',
        HIGH: 'HIGH',
        MEDIUM: 'MEDIUM',
        LOW: 'LOW',
    },
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
    MessageType: {
        USER: 'USER',
        BOT: 'BOT',
        SYSTEM: 'SYSTEM',
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
    Prisma: {},
}));

vi.mock('@copilotkit/outpost/shared', () => ({
    DEFAULT_PAGE_SIZE: 25,
    MAX_PAGE_SIZE: 100,
    generateTicketId: vi.fn().mockReturnValue('TKT-TESTID01'),
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

// ─── Import route handlers (must come after mocks) ────────────────────────

import { GET as ticketsListGet, POST as ticketsPost } from '@/app/api/tickets/route';
import { GET as ticketGet, PATCH as ticketPatch } from '@/app/api/tickets/[id]/route';
import { GET as messagesGet, POST as messagesPost } from '@/app/api/tickets/[id]/messages/route';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeNextRequest(url: string, options?: Record<string, unknown>): NextRequest {
    // Cast through unknown to bridge standard RequestInit and Next.js's narrower RequestInit
    // (Next.js omits `null` from signal's union type)
    return new NextRequest(
        new URL(url, 'http://localhost:3000'),
        options as unknown as ConstructorParameters<typeof NextRequest>[1],
    );
}

function jsonNextRequest(url: string, body: unknown, method = 'POST'): NextRequest {
    return new NextRequest(new URL(url, 'http://localhost:3000'), {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

const sampleTicket = {
    id: 'cuid-1',
    displayId: 'TKT-TESTID01',
    title: 'Test Ticket',
    description: 'A test ticket',
    status: 'OPEN',
    priority: 'MEDIUM',
    type: 'QUESTION',
    source: 'MANUAL',
    sourceUrl: null,
    additionalInfo: null,
    suggestedResponse: null,
    assigneeId: null,
    assignee: null,
    accountId: null,
    account: null,
    userId: null,
    user: null,
    messages: [],
    notes: [],
    slaBreachedAt: null,
    createdAt: new Date('2025-04-14T09:30:00Z'),
    updatedAt: new Date('2025-04-14T09:30:00Z'),
};

const sampleMessage = {
    id: 'msg-1',
    ticketId: 'cuid-1',
    author: 'Test User',
    content: 'Hello world',
    type: 'USER',
    isAiGenerated: false,
    attachments: null,
    createdAt: new Date('2025-04-14T09:30:00Z'),
};

// ─── Session helpers ────────────────────────────────────────────────────────

function userSession(memberId = 'tm-1') {
    return {
        user: {
            id: memberId,
            name: 'Test User',
            email: 'test@test.com',
            role: 'MEMBER',
            memberId,
        },
    };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Tickets API', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetServerSession.mockResolvedValue(userSession('tm-1'));
    });

    // ── GET /api/tickets ──────────────────────────────────────────────────

    describe('GET /api/tickets', () => {
        it('returns paginated ticket list', async () => {
            mockTicketFindMany.mockResolvedValue([sampleTicket]);
            mockTicketCount.mockResolvedValue(1);

            const res = await ticketsListGet(makeNextRequest('http://localhost:3000/api/tickets'));

            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.tickets).toHaveLength(1);
            expect(body.total).toBe(1);
            expect(body.page).toBe(1);
            expect(body.pageSize).toBe(25);
        });

        it('passes status filter to Prisma', async () => {
            mockTicketFindMany.mockResolvedValue([]);
            mockTicketCount.mockResolvedValue(0);

            await ticketsListGet(
                makeNextRequest('http://localhost:3000/api/tickets?status=OPEN&status=IN_PROGRESS'),
            );

            expect(mockTicketFindMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        status: { in: ['OPEN', 'IN_PROGRESS'] },
                    }),
                }),
            );
        });

        it('passes priority filter to Prisma', async () => {
            mockTicketFindMany.mockResolvedValue([]);
            mockTicketCount.mockResolvedValue(0);

            await ticketsListGet(
                makeNextRequest('http://localhost:3000/api/tickets?priority=HIGH'),
            );

            expect(mockTicketFindMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        priority: { in: ['HIGH'] },
                    }),
                }),
            );
        });

        it('passes search filter with OR conditions', async () => {
            mockTicketFindMany.mockResolvedValue([]);
            mockTicketCount.mockResolvedValue(0);

            await ticketsListGet(makeNextRequest('http://localhost:3000/api/tickets?search=crash'));

            expect(mockTicketFindMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        OR: expect.arrayContaining([
                            expect.objectContaining({
                                title: { contains: 'crash', mode: 'insensitive' },
                            }),
                        ]),
                    }),
                }),
            );
        });

        it('respects pagination params', async () => {
            mockTicketFindMany.mockResolvedValue([]);
            mockTicketCount.mockResolvedValue(50);

            await ticketsListGet(
                makeNextRequest('http://localhost:3000/api/tickets?page=2&pageSize=10'),
            );

            expect(mockTicketFindMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    take: 10,
                    skip: 10,
                }),
            );
        });

        it('clamps pageSize to MAX_PAGE_SIZE', async () => {
            mockTicketFindMany.mockResolvedValue([]);
            mockTicketCount.mockResolvedValue(0);

            await ticketsListGet(makeNextRequest('http://localhost:3000/api/tickets?pageSize=500'));

            expect(mockTicketFindMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    take: 100,
                }),
            );
        });

        it('returns 500 on database error', async () => {
            mockTicketFindMany.mockRejectedValue(new Error('DB connection failed'));
            mockTicketCount.mockRejectedValue(new Error('DB connection failed'));

            const res = await ticketsListGet(makeNextRequest('http://localhost:3000/api/tickets'));

            expect(res.status).toBe(500);
            const body = await res.json();
            expect(body.error).toBe('Internal server error');
        });

        it('passes accountId filter to Prisma', async () => {
            mockTicketFindMany.mockResolvedValue([]);
            mockTicketCount.mockResolvedValue(0);

            await ticketsListGet(
                makeNextRequest('http://localhost:3000/api/tickets?accountId=acc-1'),
            );

            expect(mockTicketFindMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        accountId: 'acc-1',
                    }),
                }),
            );
        });

        it('passes assigneeId filter to Prisma', async () => {
            mockTicketFindMany.mockResolvedValue([]);
            mockTicketCount.mockResolvedValue(0);

            await ticketsListGet(
                makeNextRequest('http://localhost:3000/api/tickets?assigneeId=tm-1'),
            );

            expect(mockTicketFindMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        assigneeId: 'tm-1',
                    }),
                }),
            );
        });
    });

    // ── POST /api/tickets ─────────────────────────────────────────────────

    describe('POST /api/tickets', () => {
        it('creates a ticket with required fields', async () => {
            mockTicketCreate.mockResolvedValue({ ...sampleTicket });

            const res = await ticketsPost(
                jsonNextRequest('http://localhost:3000/api/tickets', {
                    title: 'Test Ticket',
                    description: 'A test ticket',
                }),
            );

            expect(res.status).toBe(201);
            const body = await res.json();
            expect(body.title).toBe('Test Ticket');
            expect(mockTicketCreate).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        title: 'Test Ticket',
                        description: 'A test ticket',
                        displayId: 'TKT-TESTID01',
                        status: 'OPEN',
                    }),
                }),
            );
        });

        it('rejects missing title', async () => {
            const res = await ticketsPost(
                jsonNextRequest('http://localhost:3000/api/tickets', {
                    description: 'No title here',
                }),
            );

            expect(res.status).toBe(400);
            const body = await res.json();
            expect(body.error).toContain('title');
        });

        it('rejects missing description', async () => {
            const res = await ticketsPost(
                jsonNextRequest('http://localhost:3000/api/tickets', {
                    title: 'Has title but no desc',
                }),
            );

            expect(res.status).toBe(400);
        });

        it('returns 500 on database error', async () => {
            mockTicketCreate.mockRejectedValue(new Error('DB write failed'));

            const res = await ticketsPost(
                jsonNextRequest('http://localhost:3000/api/tickets', {
                    title: 'Test',
                    description: 'Test desc',
                }),
            );

            expect(res.status).toBe(500);
        });
    });

    // ── GET /api/tickets/[id] ─────────────────────────────────────────────

    describe('GET /api/tickets/[id]', () => {
        it('returns a ticket by ID', async () => {
            mockTicketFindFirst.mockResolvedValue({
                ...sampleTicket,
                discussions: [],
            });

            const res = await ticketGet(
                makeNextRequest('http://localhost:3000/api/tickets/cuid-1'),
                { params: Promise.resolve({ id: 'cuid-1' }) },
            );

            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.id).toBe('cuid-1');
        });

        it('returns 404 for non-existent ticket', async () => {
            mockTicketFindFirst.mockResolvedValue(null);

            const res = await ticketGet(
                makeNextRequest('http://localhost:3000/api/tickets/nonexistent'),
                { params: Promise.resolve({ id: 'nonexistent' }) },
            );

            expect(res.status).toBe(404);
            const body = await res.json();
            expect(body.error).toBe('Ticket not found');
        });

        it('searches by displayId as well', async () => {
            mockTicketFindFirst.mockResolvedValue(sampleTicket);

            await ticketGet(makeNextRequest('http://localhost:3000/api/tickets/TKT-TESTID01'), {
                params: Promise.resolve({ id: 'TKT-TESTID01' }),
            });

            expect(mockTicketFindFirst).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: {
                        OR: [{ id: 'TKT-TESTID01' }, { displayId: 'TKT-TESTID01' }],
                    },
                }),
            );
        });

        it('returns 500 on database error', async () => {
            mockTicketFindFirst.mockRejectedValue(new Error('DB failed'));

            const res = await ticketGet(
                makeNextRequest('http://localhost:3000/api/tickets/cuid-1'),
                { params: Promise.resolve({ id: 'cuid-1' }) },
            );

            expect(res.status).toBe(500);
        });
    });

    // ── PATCH /api/tickets/[id] ───────────────────────────────────────────

    describe('PATCH /api/tickets/[id]', () => {
        it('updates ticket status', async () => {
            mockTicketFindFirst.mockResolvedValue(sampleTicket);
            mockTicketUpdate.mockResolvedValue({
                ...sampleTicket,
                status: 'IN_PROGRESS',
            });

            const res = await ticketPatch(
                jsonNextRequest(
                    'http://localhost:3000/api/tickets/cuid-1',
                    { status: 'IN_PROGRESS' },
                    'PATCH',
                ),
                { params: Promise.resolve({ id: 'cuid-1' }) },
            );

            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.status).toBe('IN_PROGRESS');
        });

        it('returns 404 for non-existent ticket', async () => {
            mockTicketFindFirst.mockResolvedValue(null);

            const res = await ticketPatch(
                jsonNextRequest(
                    'http://localhost:3000/api/tickets/nonexistent',
                    { status: 'OPEN' },
                    'PATCH',
                ),
                { params: Promise.resolve({ id: 'nonexistent' }) },
            );

            expect(res.status).toBe(404);
        });

        it('rejects invalid status value', async () => {
            mockTicketFindFirst.mockResolvedValue(sampleTicket);

            const res = await ticketPatch(
                jsonNextRequest(
                    'http://localhost:3000/api/tickets/cuid-1',
                    { status: 'INVALID_STATUS' },
                    'PATCH',
                ),
                { params: Promise.resolve({ id: 'cuid-1' }) },
            );

            expect(res.status).toBe(400);
            const body = await res.json();
            expect(body.error).toContain('Invalid status');
        });

        it('rejects invalid priority value', async () => {
            mockTicketFindFirst.mockResolvedValue(sampleTicket);

            const res = await ticketPatch(
                jsonNextRequest(
                    'http://localhost:3000/api/tickets/cuid-1',
                    { priority: 'ULTRA' },
                    'PATCH',
                ),
                { params: Promise.resolve({ id: 'cuid-1' }) },
            );

            expect(res.status).toBe(400);
            const body = await res.json();
            expect(body.error).toContain('Invalid priority');
        });

        it('rejects invalid type value', async () => {
            mockTicketFindFirst.mockResolvedValue(sampleTicket);

            const res = await ticketPatch(
                jsonNextRequest(
                    'http://localhost:3000/api/tickets/cuid-1',
                    { type: 'INVALID_TYPE' },
                    'PATCH',
                ),
                { params: Promise.resolve({ id: 'cuid-1' }) },
            );

            expect(res.status).toBe(400);
            const body = await res.json();
            expect(body.error).toContain('Invalid type');
        });

        it('returns 500 on database error', async () => {
            mockTicketFindFirst.mockResolvedValue(sampleTicket);
            mockTicketUpdate.mockRejectedValue(new Error('DB write failed'));

            const res = await ticketPatch(
                jsonNextRequest(
                    'http://localhost:3000/api/tickets/cuid-1',
                    { status: 'IN_PROGRESS' },
                    'PATCH',
                ),
                { params: Promise.resolve({ id: 'cuid-1' }) },
            );

            expect(res.status).toBe(500);
        });
    });

    // ── GET /api/tickets/[id]/messages ────────────────────────────────────

    describe('GET /api/tickets/[id]/messages', () => {
        it('returns messages for a ticket', async () => {
            mockTicketFindFirst.mockResolvedValue(sampleTicket);
            mockMessageFindMany.mockResolvedValue([sampleMessage]);

            const res = await messagesGet(
                makeNextRequest('http://localhost:3000/api/tickets/cuid-1/messages'),
                { params: Promise.resolve({ id: 'cuid-1' }) },
            );

            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.messages).toHaveLength(1);
            expect(body.messages[0].content).toBe('Hello world');
        });

        it('returns 404 for non-existent ticket', async () => {
            mockTicketFindFirst.mockResolvedValue(null);

            const res = await messagesGet(
                makeNextRequest('http://localhost:3000/api/tickets/nonexistent/messages'),
                { params: Promise.resolve({ id: 'nonexistent' }) },
            );

            expect(res.status).toBe(404);
        });

        it('returns 500 on database error', async () => {
            mockTicketFindFirst.mockRejectedValue(new Error('DB failed'));

            const res = await messagesGet(
                makeNextRequest('http://localhost:3000/api/tickets/cuid-1/messages'),
                { params: Promise.resolve({ id: 'cuid-1' }) },
            );

            expect(res.status).toBe(500);
        });
    });

    // ── POST /api/tickets/[id]/messages ───────────────────────────────────

    describe('POST /api/tickets/[id]/messages', () => {
        it('creates a message', async () => {
            mockTicketFindFirst.mockResolvedValue(sampleTicket);
            mockMessageCreate.mockResolvedValue(sampleMessage);

            const res = await messagesPost(
                jsonNextRequest('http://localhost:3000/api/tickets/cuid-1/messages', {
                    content: 'Hello world',
                    author: 'Test User',
                }),
                { params: Promise.resolve({ id: 'cuid-1' }) },
            );

            expect(res.status).toBe(201);
            const body = await res.json();
            expect(body.content).toBe('Hello world');
        });

        it('rejects missing content', async () => {
            mockTicketFindFirst.mockResolvedValue(sampleTicket);

            const res = await messagesPost(
                jsonNextRequest('http://localhost:3000/api/tickets/cuid-1/messages', {
                    author: 'Test User',
                }),
                { params: Promise.resolve({ id: 'cuid-1' }) },
            );

            expect(res.status).toBe(400);
            const body = await res.json();
            expect(body.error).toContain('content');
        });

        it('returns 404 for non-existent ticket', async () => {
            mockTicketFindFirst.mockResolvedValue(null);

            const res = await messagesPost(
                jsonNextRequest('http://localhost:3000/api/tickets/nonexistent/messages', {
                    content: 'Hello',
                }),
                { params: Promise.resolve({ id: 'nonexistent' }) },
            );

            expect(res.status).toBe(404);
        });

        it('returns 500 on database error', async () => {
            mockTicketFindFirst.mockResolvedValue(sampleTicket);
            mockMessageCreate.mockRejectedValue(new Error('DB write failed'));

            const res = await messagesPost(
                jsonNextRequest('http://localhost:3000/api/tickets/cuid-1/messages', {
                    content: 'Hello',
                }),
                { params: Promise.resolve({ id: 'cuid-1' }) },
            );

            expect(res.status).toBe(500);
        });
    });
});
