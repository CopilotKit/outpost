import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetServerSession = vi.fn();
vi.mock('next-auth', () => ({
    getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

const mockOrgFindFirst = vi.fn();
const mockMemberFindUnique = vi.fn();
const mockTxCreate = vi.fn();
const mockTxExecute = vi.fn();

vi.mock('@copilotkit/outpost/db', () => ({
    prisma: {
        organization: { findFirst: (...a: unknown[]) => mockOrgFindFirst(...a) },
        teamMember: { findUnique: (...a: unknown[]) => mockMemberFindUnique(...a) },
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
            fn({
                $executeRawUnsafe: (...a: unknown[]) => mockTxExecute(...a),
                teamMember: { create: (...a: unknown[]) => mockTxCreate(...a) },
            }),
    },
}));

vi.mock('@copilotkit/outpost/shared', () => ({ verifyPassword: vi.fn() }));

import { POST } from '@/app/api/admin/reset/route';
import { authOptions } from '@/lib/auth';

const adminRow = {
    id: 'admin-1',
    name: 'Admin',
    email: 'admin@x.io',
    role: 'ADMIN',
    status: 'ACTIVE',
    avatarUrl: null,
    passwordHash: 'h',
    joinedAt: new Date('2026-01-01T00:00:00Z'),
    sessionVersion: 3,
};

describe('POST /api/admin/reset', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetServerSession.mockResolvedValue({ user: { role: 'ADMIN', memberId: 'admin-1' } });
        mockOrgFindFirst.mockResolvedValue(null);
        mockMemberFindUnique.mockResolvedValue(adminRow);
    });

    it("recreates the admin with the saved sessionVersion, so the admin's own token still passes", async () => {
        const res = await POST(
            new Request('http://localhost:3000/api/admin/reset', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ confirmation: 'RESET' }),
            }),
        );
        expect(res.status).toBe(200);

        const created = mockTxCreate.mock.calls[0][0].data as Record<string, unknown>;
        expect(created.sessionVersion).toBe(3);

        // Replay the row as the database now holds it (Prisma default 0 if omitted).
        mockMemberFindUnique.mockResolvedValue({
            sessionVersion: (created.sessionVersion as number | undefined) ?? 0,
            status: created.status,
        });
        await expect(
            authOptions.callbacks!.jwt!({ token: { memberId: 'admin-1', sv: 3 } } as never),
        ).resolves.toMatchObject({ memberId: 'admin-1' });
    });
});
