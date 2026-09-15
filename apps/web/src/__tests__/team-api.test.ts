import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock Prisma ────────────────────────────────────────────────────────────

const mockTeamMemberFindMany = vi.fn();
const mockTeamMemberFindUnique = vi.fn();
const mockTeamMemberCreate = vi.fn();
const mockTeamMemberUpdate = vi.fn();
const mockTeamMemberDelete = vi.fn();
const mockTeamMemberCount = vi.fn();
const mockInviteTokenFindUnique = vi.fn();
const mockInviteTokenCreate = vi.fn();
const mockInviteTokenUpdate = vi.fn();
const mockInviteTokenDeleteMany = vi.fn();
const mockOrganizationFindFirst = vi.fn();
const mockTransaction = vi.fn();

vi.mock('@copilotkit/outpost/db', () => ({
    prisma: {
        teamMember: {
            findMany: (...args: unknown[]) => mockTeamMemberFindMany(...args),
            findUnique: (...args: unknown[]) => mockTeamMemberFindUnique(...args),
            create: (...args: unknown[]) => mockTeamMemberCreate(...args),
            update: (...args: unknown[]) => mockTeamMemberUpdate(...args),
            delete: (...args: unknown[]) => mockTeamMemberDelete(...args),
            count: (...args: unknown[]) => mockTeamMemberCount(...args),
        },
        inviteToken: {
            findUnique: (...args: unknown[]) => mockInviteTokenFindUnique(...args),
            create: (...args: unknown[]) => mockInviteTokenCreate(...args),
            update: (...args: unknown[]) => mockInviteTokenUpdate(...args),
            deleteMany: (...args: unknown[]) => mockInviteTokenDeleteMany(...args),
        },
        organization: {
            findFirst: (...args: unknown[]) => mockOrganizationFindFirst(...args),
        },
        $transaction: (...args: unknown[]) => mockTransaction(...args),
    },
}));

// ─── Mock hashPassword ──────────────────────────────────────────────────────

vi.mock('@copilotkit/outpost/shared', () => ({
    hashPassword: vi.fn().mockResolvedValue('hashed-password-123'),
    // Faithful mirror of the real policy (min 8 chars, max 72 UTF-8 bytes).
    validatePassword: (pw: unknown) => {
        if (typeof pw !== 'string' || pw.length === 0) return 'Password is required.';
        if (pw.length < 8) return 'Password must be at least 8 characters.';
        if (new TextEncoder().encode(pw).length > 72) {
            return 'Password must be at most 72 bytes; bcrypt ignores anything beyond that.';
        }
        return null;
    },
}));

vi.mock('@copilotkit/outpost/shared/server', () => ({
    sendEmail: vi.fn().mockResolvedValue({ success: true, method: 'console' }),
}));

// ─── Mock next-auth session ─────────────────────────────────────────────────

const mockGetServerSession = vi.fn();

vi.mock('next-auth', () => ({
    getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

// ─── Import route handlers ─────────────────────────────────────────────────

import { POST as invitePost } from '@/app/api/team/invite/route';
import { GET as teamGet } from '@/app/api/team/route';
import { PATCH as memberPatch, DELETE as memberDelete } from '@/app/api/team/[id]/route';
import { DELETE as revokeInvite } from '@/app/api/team/invite/[id]/route';
import { POST as resendInvite } from '@/app/api/team/invite/resend/route';
import { GET as acceptGet, POST as acceptPost } from '@/app/api/team/invite/accept/route';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRequest(url: string, options?: RequestInit): Request {
    return new Request(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        ...options,
    });
}

function jsonRequest(url: string, body: unknown, method = 'POST'): Request {
    return new Request(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

function adminSession() {
    return {
        user: {
            id: 'admin-1',
            name: 'Admin User',
            email: 'admin@test.com',
            role: 'ADMIN',
            memberId: 'admin-1',
        },
    };
}

function memberSession() {
    return {
        user: {
            id: 'member-1',
            name: 'Regular Member',
            email: 'member@test.com',
            role: 'MEMBER',
            memberId: 'member-1',
        },
    };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Team API', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    // ── Invite creates member + token ──────────────────────────────────────

    describe('POST /api/team/invite', () => {
        it('creates an invited member with a token', async () => {
            mockGetServerSession.mockResolvedValue(adminSession());
            mockTeamMemberFindUnique.mockResolvedValue(null);
            mockTeamMemberCreate.mockResolvedValue({
                id: 'new-member-1',
                email: 'new@test.com',
                role: 'MEMBER',
                status: 'INVITED',
                invitedAt: new Date(),
                inviteTokens: [{ token: 'abc123' }],
            });

            const res = await invitePost(
                jsonRequest('http://localhost:3000/api/team/invite', {
                    email: 'new@test.com',
                    role: 'MEMBER',
                }),
            );

            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.email).toBe('new@test.com');
            expect(body.role).toBe('MEMBER');
            expect(body.status).toBe('INVITED');
            expect(body.inviteUrl).toContain('/invite/accept?token=');

            // Verify prisma create was called with correct structure
            expect(mockTeamMemberCreate).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        email: 'new@test.com',
                        role: 'MEMBER',
                        status: 'INVITED',
                        invitedBy: 'admin-1',
                    }),
                }),
            );
        });

        it('rejects duplicate email', async () => {
            mockGetServerSession.mockResolvedValue(adminSession());
            mockTeamMemberFindUnique.mockResolvedValue({
                id: 'existing',
                email: 'exists@test.com',
            });

            const res = await invitePost(
                jsonRequest('http://localhost:3000/api/team/invite', {
                    email: 'exists@test.com',
                }),
            );

            expect(res.status).toBe(409);
            const body = await res.json();
            expect(body.error).toContain('already exists');
        });
    });

    // ── Token validation ───────────────────────────────────────────────────

    describe('GET /api/team/invite/accept (token validation)', () => {
        it('returns email and org for a valid token', async () => {
            mockInviteTokenFindUnique.mockResolvedValue({
                id: 'tok-1',
                token: 'valid-token',
                expiresAt: new Date(Date.now() + 3600000),
                usedAt: null,
                member: { email: 'invited@test.com' },
            });
            mockOrganizationFindFirst.mockResolvedValue({ name: 'TestOrg', logoUrl: null });

            const res = await acceptGet(
                makeRequest('http://localhost:3000/api/team/invite/accept?token=valid-token'),
            );

            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.email).toBe('invited@test.com');
            expect(body.orgName).toBe('TestOrg');
        });

        it('rejects an expired token', async () => {
            mockInviteTokenFindUnique.mockResolvedValue({
                id: 'tok-1',
                token: 'expired-token',
                expiresAt: new Date(Date.now() - 1000),
                usedAt: null,
                member: { email: 'invited@test.com' },
            });

            const res = await acceptGet(
                makeRequest('http://localhost:3000/api/team/invite/accept?token=expired-token'),
            );

            expect(res.status).toBe(410);
            const body = await res.json();
            expect(body.error).toContain('expired');
        });

        it('rejects an already-used token', async () => {
            mockInviteTokenFindUnique.mockResolvedValue({
                id: 'tok-1',
                token: 'used-token',
                expiresAt: new Date(Date.now() + 3600000),
                usedAt: new Date(),
                member: { email: 'invited@test.com' },
            });

            const res = await acceptGet(
                makeRequest('http://localhost:3000/api/team/invite/accept?token=used-token'),
            );

            expect(res.status).toBe(410);
            const body = await res.json();
            expect(body.error).toContain('already been used');
        });

        it('rejects an invalid token', async () => {
            mockInviteTokenFindUnique.mockResolvedValue(null);

            const res = await acceptGet(
                makeRequest('http://localhost:3000/api/team/invite/accept?token=nonexistent'),
            );

            expect(res.status).toBe(404);
        });
    });

    // ── Accept sets password and activates ─────────────────────────────────

    describe('POST /api/team/invite/accept', () => {
        it('sets password and activates the member', async () => {
            mockInviteTokenFindUnique.mockResolvedValue({
                id: 'tok-1',
                memberId: 'invited-1',
                token: 'valid-token',
                expiresAt: new Date(Date.now() + 3600000),
                usedAt: null,
                member: { email: 'invited@test.com' },
            });
            mockTransaction.mockResolvedValue([
                {
                    id: 'invited-1',
                    name: 'New User',
                    email: 'invited@test.com',
                    role: 'MEMBER',
                    status: 'ACTIVE',
                },
                {},
            ]);

            const res = await acceptPost(
                jsonRequest('http://localhost:3000/api/team/invite/accept', {
                    token: 'valid-token',
                    name: 'New User',
                    password: 'securepass123',
                    confirmPassword: 'securepass123',
                }),
            );

            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.name).toBe('New User');
            expect(body.role).toBe('MEMBER');
        });

        it('rejects if passwords do not match', async () => {
            const res = await acceptPost(
                jsonRequest('http://localhost:3000/api/team/invite/accept', {
                    token: 'valid-token',
                    name: 'Test',
                    password: 'password123',
                    confirmPassword: 'different456',
                }),
            );

            expect(res.status).toBe(400);
            const body = await res.json();
            expect(body.errors).toEqual(
                expect.arrayContaining([expect.stringContaining('do not match')]),
            );
        });

        it('rejects a password longer than bcrypts 72-byte limit', async () => {
            const longPassword = 'a'.repeat(73);
            const res = await acceptPost(
                jsonRequest('http://localhost:3000/api/team/invite/accept', {
                    token: 'valid-token',
                    name: 'Test',
                    password: longPassword,
                    confirmPassword: longPassword,
                }),
            );

            expect(res.status).toBe(400);
            const body = await res.json();
            expect(body.errors).toEqual(
                expect.arrayContaining([expect.stringContaining('at most 72 bytes')]),
            );
        });
    });

    // ── Role change API ────────────────────────────────────────────────────

    describe('PATCH /api/team/[id]', () => {
        it('updates a member role', async () => {
            mockGetServerSession.mockResolvedValue(adminSession());
            mockTeamMemberUpdate.mockResolvedValue({
                id: 'member-1',
                name: 'Test',
                email: 'test@test.com',
                role: 'ADMIN',
                status: 'ACTIVE',
            });

            const res = await memberPatch(
                jsonRequest('http://localhost:3000/api/team/member-1', { role: 'ADMIN' }, 'PATCH'),
                { params: Promise.resolve({ id: 'member-1' }) },
            );

            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.role).toBe('ADMIN');
        });

        it('prevents self-demotion', async () => {
            mockGetServerSession.mockResolvedValue(adminSession());

            const res = await memberPatch(
                jsonRequest('http://localhost:3000/api/team/admin-1', { role: 'MEMBER' }, 'PATCH'),
                { params: Promise.resolve({ id: 'admin-1' }) },
            );

            expect(res.status).toBe(400);
            const body = await res.json();
            expect(body.error).toContain('own role');
        });
    });

    // ── MEMBER cannot access team management ───────────────────────────────

    describe('Authorization', () => {
        it('rejects non-admin from listing team', async () => {
            mockGetServerSession.mockResolvedValue(memberSession());

            const res = await teamGet();

            expect(res.status).toBe(403);
        });

        it('rejects non-admin from sending invites', async () => {
            mockGetServerSession.mockResolvedValue(memberSession());

            const res = await invitePost(
                jsonRequest('http://localhost:3000/api/team/invite', {
                    email: 'new@test.com',
                }),
            );

            expect(res.status).toBe(403);
        });

        it('rejects unauthenticated users', async () => {
            mockGetServerSession.mockResolvedValue(null);

            const res = await teamGet();

            expect(res.status).toBe(401);
        });
    });

    // ── Resend and revoke ──────────────────────────────────────────────────

    describe('POST /api/team/invite/resend', () => {
        it('regenerates token for pending invite', async () => {
            mockGetServerSession.mockResolvedValue(adminSession());
            mockTeamMemberFindUnique.mockResolvedValue({
                id: 'invited-1',
                email: 'invited@test.com',
                status: 'INVITED',
            });
            mockInviteTokenFindUnique.mockResolvedValue(null);
            mockInviteTokenDeleteMany.mockResolvedValue({ count: 1 });
            mockInviteTokenCreate.mockResolvedValue({ token: 'new-token' });

            const res = await resendInvite(
                jsonRequest('http://localhost:3000/api/team/invite/resend', {
                    memberId: 'invited-1',
                }),
            );

            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.success).toBe(true);
        });

        it('returns 429 when the previous invite was sent seconds ago', async () => {
            mockGetServerSession.mockResolvedValue(adminSession());
            mockTeamMemberFindUnique.mockResolvedValue({
                id: 'invited-1',
                email: 'invited@test.com',
                status: 'INVITED',
            });
            mockInviteTokenFindUnique.mockResolvedValue({
                id: 'tok-old',
                memberId: 'invited-1',
                createdAt: new Date(Date.now() - 5_000),
            });

            const res = await resendInvite(
                jsonRequest('http://localhost:3000/api/team/invite/resend', {
                    memberId: 'invited-1',
                }),
            );

            expect(res.status).toBe(429);
            const body = await res.json();
            expect(body.error).toContain('recently');
            expect(res.headers.get('Retry-After')).not.toBeNull();
            expect(mockInviteTokenDeleteMany).not.toHaveBeenCalled();
            expect(mockInviteTokenCreate).not.toHaveBeenCalled();
        });

        it('allows a resend once the cooldown has elapsed', async () => {
            mockGetServerSession.mockResolvedValue(adminSession());
            mockTeamMemberFindUnique.mockResolvedValue({
                id: 'invited-1',
                email: 'invited@test.com',
                status: 'INVITED',
            });
            mockInviteTokenFindUnique.mockResolvedValue({
                id: 'tok-old',
                memberId: 'invited-1',
                createdAt: new Date(Date.now() - 61_000),
            });
            mockInviteTokenDeleteMany.mockResolvedValue({ count: 1 });
            mockInviteTokenCreate.mockResolvedValue({ token: 'new-token' });

            const res = await resendInvite(
                jsonRequest('http://localhost:3000/api/team/invite/resend', {
                    memberId: 'invited-1',
                }),
            );

            expect(res.status).toBe(200);
            expect(mockInviteTokenCreate).toHaveBeenCalledTimes(1);
        });
    });

    describe('DELETE /api/team/invite/[id]', () => {
        it('revokes a pending invite', async () => {
            mockGetServerSession.mockResolvedValue(adminSession());
            mockTeamMemberFindUnique.mockResolvedValue({
                id: 'invited-1',
                status: 'INVITED',
            });
            mockTeamMemberDelete.mockResolvedValue({});

            const res = await revokeInvite(
                makeRequest('http://localhost:3000/api/team/invite/invited-1'),
                { params: Promise.resolve({ id: 'invited-1' }) },
            );

            expect(res.status).toBe(200);
        });
    });

    // ── Remove member ──────────────────────────────────────────────────────

    describe('DELETE /api/team/[id]', () => {
        it('removes a member', async () => {
            mockGetServerSession.mockResolvedValue(adminSession());
            mockTeamMemberDelete.mockResolvedValue({});

            const res = await memberDelete(
                makeRequest('http://localhost:3000/api/team/member-1'),
                { params: Promise.resolve({ id: 'member-1' }) },
            );

            expect(res.status).toBe(200);
        });

        it('prevents self-removal', async () => {
            mockGetServerSession.mockResolvedValue(adminSession());

            const res = await memberDelete(
                makeRequest('http://localhost:3000/api/team/admin-1'),
                { params: Promise.resolve({ id: 'admin-1' }) },
            );

            expect(res.status).toBe(400);
            const body = await res.json();
            expect(body.error).toContain('yourself');
        });
    });
});
