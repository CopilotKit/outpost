import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock Prisma ────────────────────────────────────────────────────────────

const mockTicketCount = vi.fn();
const mockTicketFindMany = vi.fn();
const mockTicketFindFirst = vi.fn();

vi.mock('@copilotkit/outpost/db', () => ({
    prisma: {
        ticket: {
            count: (...args: unknown[]) => mockTicketCount(...args),
            findMany: (...args: unknown[]) => mockTicketFindMany(...args),
            findFirst: (...args: unknown[]) => mockTicketFindFirst(...args),
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
    MessageType: {
        USER: 'USER',
        BOT: 'BOT',
        SYSTEM: 'SYSTEM',
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

// ─── Mock PathfinderClient ──────────────────────────────────────────────────

const mockQueryKnowledgeBase = vi.fn();
const mockDisconnect = vi.fn();

vi.mock('@copilotkit/outpost/ai', () => ({
    PathfinderClient: vi.fn().mockImplementation(function () {
        return {
            queryKnowledgeBase: mockQueryKnowledgeBase,
            disconnect: mockDisconnect,
        };
    }),
}));

// ─── Import routes (after mocks) ───────────────────────────────────────────

import { GET as statsGet } from '@/app/api/dashboard/stats/route';
import { GET as myTasksGet } from '@/app/api/dashboard/my-tasks/route';
import { GET as faqGet } from '@/app/api/dashboard/faq/route';

// ─── Helpers ────────────────────────────────────────────────────────────────

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

function statsRequest(month?: string): Request {
    const url = month
        ? `http://localhost/api/dashboard/stats?month=${month}`
        : 'http://localhost/api/dashboard/stats';
    return new Request(url);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Dashboard API', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetServerSession.mockResolvedValue(userSession('tm-1'));
    });

    // ── GET /api/dashboard/stats ──────────────────────────────────────────

    describe('GET /api/dashboard/stats', () => {
        it('returns aggregated ticket stats', async () => {
            mockTicketFindFirst.mockResolvedValue({ createdAt: new Date() });
            // Mock the 6 parallel queries:
            // totalTickets, openTickets, slaBreaches, ticketsWithFirstResponse, resolvedTickets, monthlyTickets
            mockTicketCount
                .mockResolvedValueOnce(10)  // totalTickets
                .mockResolvedValueOnce(6)   // openTickets
                .mockResolvedValueOnce(2);  // slaBreaches
            mockTicketFindMany
                .mockResolvedValueOnce([    // ticketsWithFirstResponse
                    {
                        createdAt: new Date('2025-04-14T09:00:00Z'),
                        user: { name: 'Alice' },
                        messages: [
                            { author: 'Alice', type: 'USER', createdAt: new Date('2025-04-14T09:00:00Z') },
                            { author: 'Bot', type: 'BOT', createdAt: new Date('2025-04-14T09:01:00Z') },
                        ],
                    },
                ])
                .mockResolvedValueOnce([    // resolvedTickets
                    {
                        createdAt: new Date('2025-04-10T09:00:00Z'),
                        updatedAt: new Date('2025-04-11T14:00:00Z'),
                    },
                ])
                .mockResolvedValueOnce([]); // monthlyTickets

            const res = await statsGet(statsRequest());

            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.totalTickets).toBe(10);
            expect(body.openTickets).toBe(6);
            expect(body.slaBreaches).toBe(2);
            expect(body.avgFirstResponseMs).toBe(60000); // 1 minute
            expect(body.avgResolutionMs).toBeGreaterThan(0);
            expect(body.trend).toBeDefined();
            expect(Array.isArray(body.trend)).toBe(true);
        });

        it('handles no tickets gracefully', async () => {
            mockTicketFindFirst.mockResolvedValue({ createdAt: new Date() });
            mockTicketCount
                .mockResolvedValueOnce(0)
                .mockResolvedValueOnce(0)
                .mockResolvedValueOnce(0);
            mockTicketFindMany
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([]);

            const res = await statsGet(statsRequest());

            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.totalTickets).toBe(0);
            expect(body.openTickets).toBe(0);
            expect(body.slaBreaches).toBe(0);
            expect(body.avgFirstResponseMs).toBe(0);
            expect(body.avgResolutionMs).toBe(0);
        });

        it('returns 500 on database error', async () => {
            mockTicketFindFirst.mockResolvedValue({ createdAt: new Date() });
            mockTicketCount.mockRejectedValue(new Error('DB failed'));

            const res = await statsGet(statsRequest());

            expect(res.status).toBe(500);
            const body = await res.json();
            expect(body.error).toBe('Internal server error');
        });

        it('computes daily trend with correct number of days', async () => {
            const now = new Date();
            const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

            // Oldest ticket in the current month, so the current month stays selectable.
            mockTicketFindFirst.mockResolvedValue({
                createdAt: new Date(now.getFullYear(), now.getMonth(), 1),
            });
            mockTicketCount
                .mockResolvedValueOnce(1)
                .mockResolvedValueOnce(1)
                .mockResolvedValueOnce(0);
            mockTicketFindMany
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([
                    { createdAt: new Date() }, // ticket created today
                ]);

            const res = await statsGet(statsRequest());
            const body = await res.json();

            expect(body.trend).toHaveLength(daysInMonth);
            // At least one day should have count > 0 (today)
            const todaysEntry = body.trend.find((d: { day: number; count: number }) => d.day === now.getDate());
            expect(todaysEntry?.count).toBe(1);
        });

        it('returns the requested month, its label, and selectable months', async () => {
            mockTicketFindFirst.mockResolvedValue({ createdAt: new Date(2026, 4, 20) });
            mockTicketCount
                .mockResolvedValueOnce(4)   // totalTickets for the window
                .mockResolvedValueOnce(2)   // openTickets
                .mockResolvedValueOnce(0);  // slaBreaches
            mockTicketFindMany
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([{ createdAt: new Date(2026, 5, 4) }]);

            const res = await statsGet(statsRequest('2026-06'));
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(body.monthKey).toBe('2026-06');
            expect(body.month).toBe('June 2026');
            expect(body.trend).toHaveLength(30);
            expect(body.trend.find((d: { day: number; count: number }) => d.day === 4)?.count).toBe(1);
            expect(body.availableMonths[0]).toBe('2026-05');
            expect(body.availableMonths).toContain('2026-06');
        });

        it('scopes totalTickets to the selected month, not all time', async () => {
            mockTicketFindFirst.mockResolvedValue({ createdAt: new Date(2026, 5, 4) });
            mockTicketCount
                .mockResolvedValueOnce(4)
                .mockResolvedValueOnce(1)
                .mockResolvedValueOnce(0);
            mockTicketFindMany
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([]);

            const res = await statsGet(statsRequest('2026-06'));
            const body = await res.json();

            expect(body.totalTickets).toBe(4);
            // The count must be constrained by a createdAt window.
            const countArgs = mockTicketCount.mock.calls[0][0] as {
                where?: { createdAt?: { gte: Date; lte: Date } };
            };
            expect(countArgs?.where?.createdAt?.gte).toEqual(new Date(2026, 5, 1, 0, 0, 0, 0));
            expect(countArgs?.where?.createdAt?.lte).toEqual(new Date(2026, 5, 30, 23, 59, 59, 999));
        });

        it('scopes the first-response and resolution scans to the selected month', async () => {
            mockTicketFindFirst.mockResolvedValue({ createdAt: new Date(2026, 5, 4) });
            mockTicketCount
                .mockResolvedValueOnce(4)
                .mockResolvedValueOnce(1)
                .mockResolvedValueOnce(0);
            mockTicketFindMany
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([]);

            const res = await statsGet(statsRequest('2026-06'));
            expect(res.status).toBe(200);

            // findMany calls: [ticketsWithFirstResponse, resolvedTickets, monthlyTickets]
            expect(mockTicketFindMany).toHaveBeenCalledTimes(3);
            for (const index of [0, 1]) {
                const args = mockTicketFindMany.mock.calls[index][0] as {
                    where?: { createdAt?: { gte: Date; lte: Date } };
                };
                expect(args?.where?.createdAt?.gte).toEqual(new Date(2026, 5, 1, 0, 0, 0, 0));
                expect(args?.where?.createdAt?.lte).toEqual(new Date(2026, 5, 30, 23, 59, 59, 999));
            }
        });

        it('falls back to the newest month with tickets for a malformed month param', async () => {
            // Both findFirst calls (oldest, newest) resolve to January 2026, so
            // the newest month with data IS January — not the calendar month.
            mockTicketFindFirst.mockResolvedValue({ createdAt: new Date(2026, 0, 1) });
            mockTicketCount
                .mockResolvedValueOnce(0)
                .mockResolvedValueOnce(0)
                .mockResolvedValueOnce(0);
            mockTicketFindMany
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([]);

            const res = await statsGet(statsRequest('garbage'));
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(body.monthKey).toBe('2026-01');
        });

        it('defaults to the newest month with tickets, not the empty calendar month', async () => {
            // The regression this guards: totalTickets used to be an all-time
            // count, so it was never 0. Scoped to a month, defaulting to the
            // calendar month made the dashboard read 0 with an empty chart for
            // the first days of every month.
            mockTicketFindFirst
                .mockResolvedValueOnce({ createdAt: new Date(2026, 5, 4) })   // oldest
                .mockResolvedValueOnce({ createdAt: new Date(2026, 6, 30) }); // newest
            mockTicketCount
                .mockResolvedValueOnce(47)
                .mockResolvedValueOnce(47)
                .mockResolvedValueOnce(0);
            mockTicketFindMany
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([]);

            const res = await statsGet(statsRequest());
            const body = await res.json();

            expect(body.monthKey).toBe('2026-07');
            expect(body.month).toBe('July 2026');
            expect(body.totalTickets).toBe(47);
        });

        it('offers only the current month when there are no tickets', async () => {
            mockTicketFindFirst.mockResolvedValue(null);
            mockTicketCount
                .mockResolvedValueOnce(0)
                .mockResolvedValueOnce(0)
                .mockResolvedValueOnce(0);
            mockTicketFindMany
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([]);

            const res = await statsGet(statsRequest());
            const body = await res.json();

            expect(body.availableMonths).toHaveLength(1);
        });
    });

    // ── GET /api/dashboard/my-tasks ───────────────────────────────────────

    describe('GET /api/dashboard/my-tasks', () => {
        it('returns tasks for authenticated user', async () => {
            mockGetServerSession.mockResolvedValue(userSession('tm-1'));
            mockTicketFindMany.mockResolvedValue([
                {
                    id: 'tkt-1',
                    displayId: 'TKT-1234',
                    title: 'My Task',
                    status: 'OPEN',
                    priority: 'HIGH',
                    account: { name: 'Acme Corp' },
                    createdAt: new Date('2025-04-14T09:30:00Z'),
                    slaBreachedAt: null,
                },
            ]);

            const res = await myTasksGet();

            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.tasks).toHaveLength(1);
            expect(body.tasks[0].title).toBe('My Task');
            expect(body.tasks[0].accountName).toBe('Acme Corp');
        });

        it('queries with correct assigneeId from session', async () => {
            mockGetServerSession.mockResolvedValue(userSession('tm-3'));
            mockTicketFindMany.mockResolvedValue([]);

            await myTasksGet();

            expect(mockTicketFindMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        assigneeId: 'tm-3',
                    }),
                }),
            );
        });

        it('only fetches open/in-progress/waiting-on-team statuses', async () => {
            mockGetServerSession.mockResolvedValue(userSession('tm-1'));
            mockTicketFindMany.mockResolvedValue([]);

            await myTasksGet();

            expect(mockTicketFindMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        status: {
                            in: ['OPEN', 'IN_PROGRESS', 'WAITING_ON_TEAM'],
                        },
                    }),
                }),
            );
        });

        it('returns 401 for unauthenticated', async () => {
            mockGetServerSession.mockResolvedValue(null);

            const res = await myTasksGet();

            expect(res.status).toBe(401);
            const body = await res.json();
            expect(body.error).toBe('Unauthorized');
        });

        it('returns 401 when session has no memberId', async () => {
            mockGetServerSession.mockResolvedValue({
                user: { id: 'x', name: 'Test', email: 'test@t.com' },
            });

            const res = await myTasksGet();

            expect(res.status).toBe(401);
        });

        it('returns 500 on database error', async () => {
            mockGetServerSession.mockResolvedValue(userSession('tm-1'));
            mockTicketFindMany.mockRejectedValue(new Error('DB failed'));

            const res = await myTasksGet();

            expect(res.status).toBe(500);
            const body = await res.json();
            expect(body.error).toBe('Internal server error');
        });

        it('maps accountName from included account relation', async () => {
            mockGetServerSession.mockResolvedValue(userSession('tm-1'));
            mockTicketFindMany.mockResolvedValue([
                {
                    id: 'tkt-1',
                    displayId: 'TKT-1234',
                    title: 'Task',
                    status: 'OPEN',
                    priority: 'MEDIUM',
                    account: null, // no account
                    createdAt: new Date(),
                    slaBreachedAt: null,
                },
            ]);

            const res = await myTasksGet();
            const body = await res.json();

            expect(body.tasks[0].accountName).toBeNull();
        });
    });

    // ── GET /api/dashboard/faq ────────────────────────────────────────────

    describe('GET /api/dashboard/faq', () => {
        afterEach(() => {
            delete process.env.PATHFINDER_MCP_URL;
        });

        it('returns empty with message when PATHFINDER_MCP_URL is not set', async () => {
            delete process.env.PATHFINDER_MCP_URL;

            const res = await faqGet();

            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.entries).toEqual([]);
            expect(body.message).toContain('Pathfinder not configured');
        });

        it('returns FAQ from Pathfinder when configured', async () => {
            process.env.PATHFINDER_MCP_URL = 'http://mcp.test.local';
            mockQueryKnowledgeBase.mockResolvedValue([
                {
                    title: 'How do I set up CopilotKit?',
                    content: 'Follow the quickstart guide.',
                    score: 0.95,
                },
                {
                    title: 'How to use CoAgents?',
                    content: 'CoAgents integrate with LangGraph.',
                    score: 0.85,
                },
            ]);

            const res = await faqGet();

            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.entries).toHaveLength(2);
            expect(body.entries[0].question).toBe('How do I set up CopilotKit?');
            expect(body.entries[0].answer).toBe('Follow the quickstart guide.');
            expect(mockDisconnect).toHaveBeenCalled();

            delete process.env.PATHFINDER_MCP_URL;
        });

        it('returns empty gracefully on Pathfinder error', async () => {
            process.env.PATHFINDER_MCP_URL = 'http://mcp.test.local';
            mockQueryKnowledgeBase.mockRejectedValue(new Error('MCP connection failed'));

            const res = await faqGet();

            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.entries).toEqual([]);
            expect(body.message).toContain('Failed to fetch FAQ');

            delete process.env.PATHFINDER_MCP_URL;
        });

        it('converts Pathfinder scores to sourceCount', async () => {
            process.env.PATHFINDER_MCP_URL = 'http://mcp.test.local';
            mockQueryKnowledgeBase.mockResolvedValue([
                { title: 'Q1', content: 'A1', score: 0.75 },
            ]);

            const res = await faqGet();
            const body = await res.json();

            expect(body.entries[0].sourceCount).toBe(75); // 0.75 * 100

            delete process.env.PATHFINDER_MCP_URL;
        });
    });
});
