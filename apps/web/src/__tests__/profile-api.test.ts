import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock Prisma ────────────────────────────────────────────────────────────

const mockFindUnique = vi.fn();
const mockUpdateMember = vi.fn();

vi.mock('@copilotkit/outpost/db', () => ({
    prisma: {
        teamMember: {
            findUnique: (args: unknown) => mockFindUnique(args),
            update: (args: unknown) => mockUpdateMember(args),
        },
    },
}));

// ─── Mock auth utilities ────────────────────────────────────────────────────

const mockHashPassword = vi.fn().mockResolvedValue('new-hash-456');
const mockVerifyPassword = vi.fn();

vi.mock('@copilotkit/outpost/shared', () => ({
    hashPassword: (...args: unknown[]) => mockHashPassword(...args),
    verifyPassword: (...args: unknown[]) => mockVerifyPassword(...args),
    MIN_PASSWORD_LENGTH: 8,
    MAX_PASSWORD_BYTES: 72,
    passwordByteLength: (pw: string) => new TextEncoder().encode(pw).length,
}));

// ─── Mock next-auth ─────────────────────────────────────────────────────────

const mockGetServerSession = vi.fn();

vi.mock('next-auth/next', () => ({
    getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

vi.mock('@/lib/auth', () => ({
    authOptions: {},
}));

// Import after mocks
import { GET, PUT } from '@/app/api/profile/route';

function makeRequest(body: Record<string, unknown>): Request {
    return new Request('http://localhost:3000/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

const sampleMember = {
    id: 'member-1',
    name: 'Alice Admin',
    email: 'alice@example.com',
    avatarUrl: null,
    role: 'ADMIN',
    passwordHash: 'existing-hash-123',
};

describe('GET /api/profile', () => {
    beforeEach(() => {
        mockGetServerSession.mockReset();
        mockFindUnique.mockReset();
    });

    it('returns profile for authenticated user', async () => {
        mockGetServerSession.mockResolvedValue({
            user: { id: 'member-1', role: 'ADMIN', memberId: 'member-1' },
        });
        mockFindUnique.mockResolvedValue(sampleMember);

        const res = await GET();
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.name).toBe('Alice Admin');
        expect(body.email).toBe('alice@example.com');
        expect(body.passwordHash).toBeUndefined();
    });

    it('returns 401 when not authenticated', async () => {
        mockGetServerSession.mockResolvedValue(null);

        const res = await GET();
        expect(res.status).toBe(401);
    });
});

describe('PUT /api/profile', () => {
    beforeEach(() => {
        mockGetServerSession.mockReset();
        mockFindUnique.mockReset();
        mockUpdateMember.mockReset();
        mockVerifyPassword.mockReset();
        mockHashPassword.mockReset().mockResolvedValue('new-hash-456');
    });

    it('updates name and avatar', async () => {
        mockGetServerSession.mockResolvedValue({
            user: { id: 'member-1', role: 'ADMIN', memberId: 'member-1' },
        });
        mockFindUnique.mockResolvedValue(sampleMember);
        mockUpdateMember.mockResolvedValue({
            ...sampleMember,
            name: 'Alice Updated',
            avatarUrl: 'https://example.com/pic.png',
        });

        const res = await PUT(makeRequest({
            name: 'Alice Updated',
            avatarUrl: 'https://example.com/pic.png',
        }));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.name).toBe('Alice Updated');
    });

    it('changes password when current password is correct', async () => {
        mockGetServerSession.mockResolvedValue({
            user: { id: 'member-1', role: 'ADMIN', memberId: 'member-1' },
        });
        mockFindUnique.mockResolvedValue(sampleMember);
        mockVerifyPassword.mockResolvedValue(true);
        mockUpdateMember.mockResolvedValue(sampleMember);

        const res = await PUT(makeRequest({
            name: 'Alice Admin',
            currentPassword: 'oldpass123',
            newPassword: 'newpass1234',
            confirmNewPassword: 'newpass1234',
        }));

        expect(res.status).toBe(200);
        expect(mockHashPassword).toHaveBeenCalledWith('newpass1234');
    });

    it('rejects password change with wrong current password', async () => {
        mockGetServerSession.mockResolvedValue({
            user: { id: 'member-1', role: 'ADMIN', memberId: 'member-1' },
        });
        mockFindUnique.mockResolvedValue(sampleMember);
        mockVerifyPassword.mockResolvedValue(false);

        const res = await PUT(makeRequest({
            name: 'Alice Admin',
            currentPassword: 'wrongpass',
            newPassword: 'newpass1234',
            confirmNewPassword: 'newpass1234',
        }));

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.errors).toEqual(
            expect.arrayContaining([expect.stringContaining('incorrect')]),
        );
    });

    it('rejects password change with mismatched new passwords', async () => {
        mockGetServerSession.mockResolvedValue({
            user: { id: 'member-1', role: 'ADMIN', memberId: 'member-1' },
        });
        mockFindUnique.mockResolvedValue(sampleMember);
        mockVerifyPassword.mockResolvedValue(true);

        const res = await PUT(makeRequest({
            name: 'Alice Admin',
            currentPassword: 'oldpass123',
            newPassword: 'newpass1234',
            confirmNewPassword: 'different5678',
        }));

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.errors).toEqual(
            expect.arrayContaining([expect.stringContaining('do not match')]),
        );
    });

    it('rejects short new password', async () => {
        mockGetServerSession.mockResolvedValue({
            user: { id: 'member-1', role: 'ADMIN', memberId: 'member-1' },
        });
        mockFindUnique.mockResolvedValue(sampleMember);

        const res = await PUT(makeRequest({
            name: 'Alice Admin',
            currentPassword: 'oldpass123',
            newPassword: 'short',
            confirmNewPassword: 'short',
        }));

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.errors).toEqual(
            expect.arrayContaining([expect.stringContaining('8 characters')]),
        );
    });

    it('rejects a new password longer than bcrypts 72-byte limit', async () => {
        mockGetServerSession.mockResolvedValue({
            user: { id: 'member-1', role: 'ADMIN', memberId: 'member-1' },
        });
        mockFindUnique.mockResolvedValue(sampleMember);
        mockVerifyPassword.mockResolvedValue(true);

        const longPassword = 'a'.repeat(73);
        const res = await PUT(makeRequest({
            name: 'Alice Admin',
            currentPassword: 'oldpass123',
            newPassword: longPassword,
            confirmNewPassword: longPassword,
        }));

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.errors).toEqual(
            expect.arrayContaining([expect.stringContaining('at most 72 bytes')]),
        );
        expect(mockHashPassword).not.toHaveBeenCalled();
    });
});
