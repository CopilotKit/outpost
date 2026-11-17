// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextAuthOptions } from 'next-auth';
import { NextRequest } from 'next/server';
import { encode, decode, type JWT } from 'next-auth/jwt';

// ─── Mock Prisma ────────────────────────────────────────────────────────────

const mockFindUnique = vi.fn();
const mockUpdateMember = vi.fn();
const mockUpdateMany = vi.fn();

vi.mock('@copilotkit/outpost/db', () => ({
    prisma: {
        teamMember: {
            findUnique: (args: unknown) => mockFindUnique(args),
            update: (args: unknown) => mockUpdateMember(args),
            updateMany: (args: unknown) => mockUpdateMany(args),
        },
    },
}));

// ─── Mock auth utilities ────────────────────────────────────────────────────

const mockHashPassword = vi.fn().mockResolvedValue('new-hash-456');
const mockVerifyPassword = vi.fn();

vi.mock('@copilotkit/outpost/shared', () => ({
    hashPassword: (...args: unknown[]) => mockHashPassword(...args),
    verifyPassword: (...args: unknown[]) => mockVerifyPassword(...args),
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
import { DEFAULT_SESSION_MAX_AGE, SESSION_COOKIE_CHUNK_SIZE } from '@/lib/session-cookie';

const SECRET = 'profile-test-secret';
const COOKIE = 'next-auth.session-token';

async function sessionJwt(claims: Record<string, unknown>): Promise<string> {
    return encode({ token: claims, secret: SECRET });
}

function makeRequest(
    body: Record<string, unknown>,
    cookies: Record<string, string> = {},
): NextRequest {
    const cookieHeader = Object.entries(cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
    return new NextRequest('http://localhost:3000/api/profile', {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
        body: JSON.stringify(body),
    });
}

const passwordChange = {
    name: 'Alice Admin',
    currentPassword: 'oldpass123',
    newPassword: 'newpass1234',
    confirmNewPassword: 'newpass1234',
};

type JwtArgs = Parameters<NonNullable<NonNullable<NextAuthOptions['callbacks']>['jwt']>>[0];

/**
 * A session read (no `user`, no `account`) through the REAL jwt callback from
 * lib/auth.ts; the route itself sees the mocked authOptions. Its Prisma reads go
 * through the mocked client above.
 */
async function realSessionCheck(): Promise<(token: JWT) => Promise<JWT>> {
    const actual = await vi.importActual<{ authOptions: NextAuthOptions }>('@/lib/auth');
    const jwt = actual.authOptions.callbacks!.jwt!;
    return async (token) => {
        const args: Partial<JwtArgs> = { token };
        return jwt(args as JwtArgs);
    };
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
    const originalEnv = { ...process.env };

    beforeEach(() => {
        process.env.NEXTAUTH_SECRET = SECRET;
        process.env.NEXTAUTH_URL = 'http://localhost:3000';
        delete process.env.AUTH_PROVIDER;
        mockGetServerSession.mockReset();
        mockFindUnique.mockReset();
        mockUpdateMember.mockReset();
        mockUpdateMany.mockReset();
        mockVerifyPassword.mockReset();
        mockHashPassword.mockReset().mockResolvedValue('new-hash-456');
        mockGetServerSession.mockResolvedValue({
            user: { id: 'member-1', role: 'ADMIN', memberId: 'member-1' },
        });
    });

    afterEach(() => {
        process.env = { ...originalEnv };
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

        const res = await PUT(
            makeRequest({
                name: 'Alice Updated',
                avatarUrl: 'https://example.com/pic.png',
            }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.name).toBe('Alice Updated');
    });

    it('bumps sessionVersion with a compare-and-set and re-issues this session with sv + 1', async () => {
        mockFindUnique.mockResolvedValue(sampleMember);
        mockVerifyPassword.mockResolvedValue(true);
        mockUpdateMany.mockResolvedValue({ count: 1 });
        const jwt = await sessionJwt({
            memberId: 'member-1',
            role: 'ADMIN',
            sv: 2,
            email: 'alice@example.com',
        });

        const res = await PUT(makeRequest(passwordChange, { [COOKIE]: jwt }));

        expect(res.status).toBe(200);
        expect(mockHashPassword).toHaveBeenCalledWith('newpass1234');
        expect(mockUpdateMany).toHaveBeenCalledWith({
            where: { id: 'member-1', status: 'ACTIVE', sessionVersion: 2 },
            data: {
                name: 'Alice Admin',
                passwordHash: 'new-hash-456',
                sessionVersion: { increment: 1 },
            },
        });
        expect(mockUpdateMember).not.toHaveBeenCalled();

        const issued = res.cookies.get(COOKIE);
        expect(issued?.httpOnly).toBe(true);
        expect(issued?.sameSite).toBe('lax');
        expect(issued?.path).toBe('/');
        const claims = await decode({ token: issued!.value, secret: SECRET });
        expect(claims).toMatchObject({ memberId: 'member-1', role: 'ADMIN', sv: 3 });
    });

    it('keeps the re-issued session and revokes the old one under the real jwt callback', async () => {
        // A stateful member row: findUnique reads it, updateMany is a real compare-and-set on it.
        const row = { ...sampleMember, status: 'ACTIVE', sessionVersion: 2 };
        mockFindUnique.mockImplementation(async () => ({ ...row }));
        mockUpdateMany.mockImplementation(
            async (args: {
                where: { sessionVersion: number; status: string };
                data: Record<string, unknown>;
            }) => {
                if (
                    row.sessionVersion !== args.where.sessionVersion ||
                    row.status !== args.where.status
                ) {
                    return { count: 0 };
                }
                row.passwordHash = args.data.passwordHash as string;
                const sv = args.data.sessionVersion as { increment?: number } | undefined;
                row.sessionVersion += sv?.increment ?? 0;
                return { count: 1 };
            },
        );
        mockVerifyPassword.mockResolvedValue(true);
        const sessionCheck = await realSessionCheck();
        const claims = { memberId: 'member-1', role: 'ADMIN', sv: 2 };
        const thisSession = await sessionJwt(claims);
        const otherSession = await sessionJwt({ ...claims, name: 'other device' });

        // Before the change, both sessions pass the real session check.
        await expect(sessionCheck({ ...claims })).resolves.toMatchObject({
            sv: 2,
        });

        const res = await PUT(makeRequest(passwordChange, { [COOKIE]: thisSession }));

        expect(res.status).toBe(200);
        expect(row.sessionVersion).toBe(3);
        const reissued = await decode({ token: res.cookies.get(COOKIE)!.value, secret: SECRET });
        expect(reissued?.sv).toBe(3);
        await expect(sessionCheck(reissued!)).resolves.toMatchObject({
            memberId: 'member-1',
            sv: 3,
        });
        const other = await decode({ token: otherSession, secret: SECRET });
        await expect(sessionCheck(other!)).rejects.toThrow('SESSION_REVOKED');
    });

    it('treats a token without sv as 0', async () => {
        mockFindUnique.mockResolvedValue(sampleMember);
        mockVerifyPassword.mockResolvedValue(true);
        mockUpdateMany.mockResolvedValue({ count: 1 });
        const jwt = await sessionJwt({ memberId: 'member-1', role: 'ADMIN' });

        const res = await PUT(makeRequest(passwordChange, { [COOKIE]: jwt }));

        expect(mockUpdateMany.mock.calls[0][0].where.sessionVersion).toBe(0);
        expect((await decode({ token: res.cookies.get(COOKIE)!.value, secret: SECRET }))?.sv).toBe(
            1,
        );
    });

    it('401s, sets no cookie, and writes nothing when a concurrent revocation won', async () => {
        mockFindUnique.mockResolvedValue(sampleMember);
        mockVerifyPassword.mockResolvedValue(true);
        mockUpdateMany.mockResolvedValue({ count: 0 });
        const jwt = await sessionJwt({ memberId: 'member-1', sv: 2 });

        const res = await PUT(makeRequest(passwordChange, { [COOKIE]: jwt }));

        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'Your session has ended. Sign in again.' });
        expect(res.cookies.get(COOKIE)).toBeUndefined();
        expect(res.headers.get('set-cookie')).toBeNull();
        expect(mockUpdateMember).not.toHaveBeenCalled();
    });

    it('401s with no cookie on the request, or a token for another member', async () => {
        mockFindUnique.mockResolvedValue(sampleMember);
        mockVerifyPassword.mockResolvedValue(true);

        expect((await PUT(makeRequest(passwordChange))).status).toBe(401);
        const other = await sessionJwt({ memberId: 'someone-else', sv: 0 });
        expect((await PUT(makeRequest(passwordChange, { [COOKIE]: other }))).status).toBe(401);
        expect(mockUpdateMany).not.toHaveBeenCalled();
        expect(mockUpdateMember).not.toHaveBeenCalled();
    });

    it('expires leftover chunk cookies when the session was chunked', async () => {
        mockFindUnique.mockResolvedValue(sampleMember);
        mockVerifyPassword.mockResolvedValue(true);
        mockUpdateMany.mockResolvedValue({ count: 1 });
        const jwt = await sessionJwt({ memberId: 'member-1', sv: 0 });
        const half = Math.ceil(jwt.length / 2);

        const res = await PUT(
            makeRequest(passwordChange, {
                [`${COOKIE}.0`]: jwt.slice(0, half),
                [`${COOKIE}.1`]: jwt.slice(half),
            }),
        );

        expect(res.status).toBe(200);
        expect(res.cookies.get(`${COOKIE}.0`)?.maxAge).toBe(0);
        expect(res.cookies.get(`${COOKIE}.1`)?.maxAge).toBe(0);
        expect((await decode({ token: res.cookies.get(COOKIE)!.value, secret: SECRET }))?.sv).toBe(
            1,
        );
    });

    it('re-issues the cookie with maxAge equal to the token lifetime (exp - iat)', async () => {
        mockFindUnique.mockResolvedValue(sampleMember);
        mockVerifyPassword.mockResolvedValue(true);
        mockUpdateMany.mockResolvedValue({ count: 1 });
        const jwt = await sessionJwt({ memberId: 'member-1', sv: 0 });

        const res = await PUT(makeRequest(passwordChange, { [COOKIE]: jwt }));

        const issued = res.cookies.get(COOKIE)!;
        const claims = await decode({ token: issued.value, secret: SECRET });
        const lifetime = Number(claims!.exp) - Number(claims!.iat);
        expect(lifetime).toBe(DEFAULT_SESSION_MAX_AGE);
        expect(issued.maxAge).toBe(lifetime);
    });

    // A session larger than one cookie (e.g. a long avatarUrl in `picture`). Browsers
    // drop a single Set-Cookie over 4096 bytes, which would sign the user out.
    async function largeSessionJwt(): Promise<string> {
        const jwt = await sessionJwt({
            memberId: 'member-1',
            sv: 0,
            picture: `https://cdn.example/${'a'.repeat(5000)}`,
        });
        expect(jwt.length).toBeGreaterThan(SESSION_COOKIE_CHUNK_SIZE);
        return jwt;
    }

    function chunkCookies(res: Awaited<ReturnType<typeof PUT>>) {
        return res.cookies.getAll().filter((c) => c.name.startsWith(`${COOKIE}.`) && c.value);
    }

    it('re-issues a chunked session as NextAuth-sized chunks with the session maxAge', async () => {
        mockFindUnique.mockResolvedValue(sampleMember);
        mockVerifyPassword.mockResolvedValue(true);
        mockUpdateMany.mockResolvedValue({ count: 1 });
        const jwt = await largeSessionJwt();
        const half = SESSION_COOKIE_CHUNK_SIZE;

        const res = await PUT(
            makeRequest(passwordChange, {
                [`${COOKIE}.0`]: jwt.slice(0, half),
                [`${COOKIE}.1`]: jwt.slice(half),
            }),
        );

        expect(res.status).toBe(200);
        // No oversized single cookie.
        expect(res.cookies.get(COOKIE)).toBeUndefined();
        const chunks = chunkCookies(res);
        expect(chunks.map((c) => c.name)).toEqual([`${COOKIE}.0`, `${COOKIE}.1`]);
        // next-auth 4.24.14 CHUNK_SIZE: 4096 - 163.
        expect(chunks[0].value.length).toBe(3933);
        for (const c of chunks) {
            expect(c.value.length).toBeLessThanOrEqual(SESSION_COOKIE_CHUNK_SIZE);
            expect(c.maxAge).toBe(DEFAULT_SESSION_MAX_AGE);
            expect(c.httpOnly).toBe(true);
            expect(c.path).toBe('/');
        }
        const claims = await decode({ token: chunks.map((c) => c.value).join(''), secret: SECRET });
        expect(claims).toMatchObject({ memberId: 'member-1', sv: 1 });
        expect(Number(claims!.exp) - Number(claims!.iat)).toBe(chunks[0].maxAge);
    });

    it('expires the bare cookie when the re-issue is chunked', async () => {
        mockFindUnique.mockResolvedValue(sampleMember);
        mockVerifyPassword.mockResolvedValue(true);
        mockUpdateMany.mockResolvedValue({ count: 1 });
        const jwt = await largeSessionJwt();

        const res = await PUT(makeRequest(passwordChange, { [COOKIE]: jwt }));

        expect(res.status).toBe(200);
        expect(res.cookies.get(COOKIE)).toMatchObject({ value: '', maxAge: 0 });
        expect(chunkCookies(res).map((c) => c.name)).toEqual([`${COOKIE}.0`, `${COOKIE}.1`]);
    });

    it('a name-only edit sets no cookie and does not bump', async () => {
        mockFindUnique.mockResolvedValue(sampleMember);
        mockUpdateMember.mockResolvedValue({ ...sampleMember, name: 'New Name' });
        const jwt = await sessionJwt({ memberId: 'member-1', sv: 2 });

        const res = await PUT(makeRequest({ name: 'New Name' }, { [COOKIE]: jwt }));

        expect(res.status).toBe(200);
        expect(mockUpdateMember).toHaveBeenCalledWith({
            where: { id: 'member-1' },
            data: { name: 'New Name' },
        });
        expect(mockUpdateMany).not.toHaveBeenCalled();
        expect(res.cookies.get(COOKIE)).toBeUndefined();
    });

    it('GitHub mode: bumps without compare-and-set or re-issue', async () => {
        process.env.AUTH_PROVIDER = 'github';
        mockFindUnique.mockResolvedValue(sampleMember);
        mockVerifyPassword.mockResolvedValue(true);
        mockUpdateMember.mockResolvedValue(sampleMember);

        const res = await PUT(makeRequest(passwordChange));

        expect(res.status).toBe(200);
        expect(mockUpdateMember).toHaveBeenCalledWith({
            where: { id: 'member-1' },
            data: {
                name: 'Alice Admin',
                passwordHash: 'new-hash-456',
                sessionVersion: { increment: 1 },
            },
        });
        expect(mockUpdateMany).not.toHaveBeenCalled();
        expect(res.cookies.get(COOKIE)).toBeUndefined();
    });

    it('rejects a new password over 72 bytes', async () => {
        mockFindUnique.mockResolvedValue(sampleMember);
        mockVerifyPassword.mockResolvedValue(true);
        const p = 'é'.repeat(37);
        const res = await PUT(
            makeRequest({ ...passwordChange, newPassword: p, confirmNewPassword: p }),
        );
        expect(res.status).toBe(400);
        expect((await res.json()).errors).toContain('New password must be 72 bytes or fewer.');
        expect(mockUpdateMany).not.toHaveBeenCalled();
    });

    it('rejects password change with wrong current password', async () => {
        mockGetServerSession.mockResolvedValue({
            user: { id: 'member-1', role: 'ADMIN', memberId: 'member-1' },
        });
        mockFindUnique.mockResolvedValue(sampleMember);
        mockVerifyPassword.mockResolvedValue(false);

        const jwt = await sessionJwt({ memberId: 'member-1', sv: 2 });

        const res = await PUT(
            makeRequest(
                {
                    name: 'Alice Admin',
                    currentPassword: 'wrongpass',
                    newPassword: 'newpass1234',
                    confirmNewPassword: 'newpass1234',
                },
                { [COOKIE]: jwt },
            ),
        );

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.errors).toEqual(expect.arrayContaining([expect.stringContaining('incorrect')]));
        // No bump and no re-issue: nothing is written and no cookie is set.
        expect(mockHashPassword).not.toHaveBeenCalled();
        expect(mockUpdateMany).not.toHaveBeenCalled();
        expect(mockUpdateMember).not.toHaveBeenCalled();
        expect(res.headers.get('set-cookie')).toBeNull();
    });

    it('rejects password change with mismatched new passwords', async () => {
        mockGetServerSession.mockResolvedValue({
            user: { id: 'member-1', role: 'ADMIN', memberId: 'member-1' },
        });
        mockFindUnique.mockResolvedValue(sampleMember);
        mockVerifyPassword.mockResolvedValue(true);

        const res = await PUT(
            makeRequest({
                name: 'Alice Admin',
                currentPassword: 'oldpass123',
                newPassword: 'newpass1234',
                confirmNewPassword: 'different5678',
            }),
        );

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

        const res = await PUT(
            makeRequest({
                name: 'Alice Admin',
                currentPassword: 'oldpass123',
                newPassword: 'short',
                confirmNewPassword: 'short',
            }),
        );

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.errors).toEqual(
            expect.arrayContaining([expect.stringContaining('8 characters')]),
        );
    });
});
