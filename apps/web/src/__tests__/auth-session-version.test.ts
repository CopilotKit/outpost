import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextAuthOptions } from 'next-auth';

const mockFindUnique = vi.fn();
const mockUpdate = vi.fn();
const mockUpdateMany = vi.fn();

vi.mock('@copilotkit/outpost/db', () => ({
    prisma: {
        teamMember: {
            findUnique: (...args: unknown[]) => mockFindUnique(...args),
            update: (...args: unknown[]) => mockUpdate(...args),
            updateMany: (...args: unknown[]) => mockUpdateMany(...args),
        },
    },
}));

// Only getServerSession is replaced (for requireAdmin in the team route); the
// providers that lib/auth.ts builds come from the real next-auth.
const mockGetServerSession = vi.fn();
vi.mock('next-auth', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

const mockVerifyPassword = vi.fn();
vi.mock('@copilotkit/outpost/shared', () => ({
    verifyPassword: (...args: unknown[]) => mockVerifyPassword(...args),
}));

type JwtArgs = Parameters<NonNullable<NonNullable<NextAuthOptions['callbacks']>['jwt']>>[0];

async function loadAuth(provider: string): Promise<NextAuthOptions> {
    process.env.AUTH_PROVIDER = provider;
    vi.resetModules();
    return (await import('../lib/auth.js')).authOptions;
}

/** A session read for an existing cookie: no `user`, no `account`. */
function readSession(
    auth: NextAuthOptions,
    token: Record<string, unknown>,
    extra: Partial<JwtArgs> = {},
) {
    return auth.callbacks!.jwt!({ token, ...extra } as JwtArgs);
}

type AuthorizeFn = (credentials: Record<string, string>, req: unknown) => Promise<unknown>;

function credentialsAuthorize(auth: NextAuthOptions): AuthorizeFn {
    // next-auth v4 keeps the user-supplied authorize under `options`.
    return (auth.providers[0] as unknown as { options: { authorize: AuthorizeFn } }).options
        .authorize;
}

describe('jwt callback: sessionVersion check', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        mockFindUnique.mockReset();
        mockVerifyPassword.mockReset();
        process.env.NEXTAUTH_SECRET = 'test-secret';
        process.env.ALLOWED_EMAIL_DOMAIN = 'copilotkit.ai';
    });

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    it('passes a credentials token whose sv matches', async () => {
        const auth = await loadAuth('credentials');
        mockFindUnique.mockResolvedValue({ sessionVersion: 2, status: 'ACTIVE', role: 'MEMBER' });

        const token = await readSession(auth, { memberId: 'm1', sv: 2, role: 'MEMBER' });

        expect(token).toMatchObject({ memberId: 'm1', sv: 2, role: 'MEMBER' });
        expect(mockFindUnique).toHaveBeenCalledWith({
            where: { id: 'm1' },
            select: { sessionVersion: true, status: true, role: true },
        });
    });

    it('throws SESSION_REVOKED for a stale sv', async () => {
        const auth = await loadAuth('credentials');
        mockFindUnique.mockResolvedValue({ sessionVersion: 3, status: 'ACTIVE' });

        await expect(readSession(auth, { memberId: 'm1', sv: 2 })).rejects.toThrow(
            'SESSION_REVOKED',
        );
    });

    it('treats a missing sv as 0', async () => {
        const auth = await loadAuth('credentials');
        mockFindUnique.mockResolvedValue({ sessionVersion: 0, status: 'ACTIVE' });
        await expect(readSession(auth, { memberId: 'm1' })).resolves.toMatchObject({
            memberId: 'm1',
        });

        mockFindUnique.mockResolvedValue({ sessionVersion: 1, status: 'ACTIVE' });
        await expect(readSession(auth, { memberId: 'm1' })).rejects.toThrow('SESSION_REVOKED');
    });

    it('throws for a DISABLED member and for a missing member', async () => {
        const auth = await loadAuth('credentials');
        mockFindUnique.mockResolvedValue({ sessionVersion: 0, status: 'DISABLED' });
        await expect(readSession(auth, { memberId: 'm1', sv: 0 })).rejects.toThrow(
            'SESSION_REVOKED',
        );

        mockFindUnique.mockResolvedValue(null);
        await expect(readSession(auth, { memberId: 'gone', sv: 0 })).rejects.toThrow(
            'SESSION_REVOKED',
        );
    });

    it('fails closed when the database lookup throws', async () => {
        const auth = await loadAuth('credentials');
        mockFindUnique.mockRejectedValue(new Error('connection refused'));
        await expect(readSession(auth, { memberId: 'm1', sv: 0 })).rejects.toThrow(
            'connection refused',
        );
    });

    it('runs the check in OIDC mode too', async () => {
        const auth = await loadAuth('oidc');
        mockFindUnique.mockResolvedValue({ sessionVersion: 1, status: 'ACTIVE' });
        await expect(readSession(auth, { memberId: 'm1', sv: 0 })).rejects.toThrow(
            'SESSION_REVOKED',
        );
    });

    it('stores sv from the credentials user at sign-in without a lookup', async () => {
        const auth = await loadAuth('credentials');
        const token = await auth.callbacks!.jwt!({
            token: {},
            user: { id: 'm1', role: 'MEMBER', sessionVersion: 4 },
            account: { provider: 'credentials', type: 'credentials' },
            trigger: 'signIn',
        } as unknown as JwtArgs);

        expect(token).toMatchObject({ memberId: 'm1', sv: 4, role: 'MEMBER' });
        expect(mockFindUnique).not.toHaveBeenCalled();
    });

    it('ignores the client update() payload and still revokes', async () => {
        const auth = await loadAuth('credentials');
        mockFindUnique.mockResolvedValue({ sessionVersion: 2, status: 'ACTIVE' });

        await expect(
            readSession(
                auth,
                { memberId: 'm1', sv: 1 },
                { trigger: 'update', session: { sv: 2, memberId: 'x', role: 'ADMIN' } },
            ),
        ).rejects.toThrow('SESSION_REVOKED');

        mockFindUnique.mockResolvedValue({ sessionVersion: 1, status: 'ACTIVE', role: 'MEMBER' });
        const token = await readSession(
            auth,
            { memberId: 'm1', sv: 1, role: 'MEMBER' },
            { trigger: 'update', session: { sv: 99, role: 'ADMIN' } },
        );
        expect(token).toMatchObject({ memberId: 'm1', sv: 1, role: 'MEMBER' });
    });

    it('GitHub mode: passes a non-TeamMember memberId with no lookup', async () => {
        const auth = await loadAuth('github');
        const token = await readSession(auth, { memberId: 'gh-12345' });
        expect(token).toMatchObject({ memberId: 'gh-12345' });
        expect(mockFindUnique).not.toHaveBeenCalled();
    });

    it('GitHub mode: signIn makes no TeamMember query', async () => {
        const auth = await loadAuth('github');
        const result = await auth.callbacks!.signIn!({
            user: { id: 'gh-1', email: 'dev@copilotkit.ai' },
            account: { provider: 'github', type: 'oauth', providerAccountId: 'gh-1' },
            profile: { email: 'dev@copilotkit.ai', login: 'dev' },
        } as never);
        expect(result).toBe(true);
        expect(mockFindUnique).not.toHaveBeenCalled();
    });
});

describe('credentials authorize()', () => {
    beforeEach(() => {
        mockFindUnique.mockReset();
        mockVerifyPassword.mockReset();
    });

    it('rejects a DISABLED member even with the right password', async () => {
        const auth = await loadAuth('credentials');
        mockFindUnique.mockResolvedValue({
            id: 'm1',
            name: 'A',
            email: 'a@x.io',
            avatarUrl: null,
            role: 'MEMBER',
            status: 'DISABLED',
            passwordHash: 'h',
            sessionVersion: 0,
        });
        mockVerifyPassword.mockResolvedValue(true);

        await expect(
            credentialsAuthorize(auth)({ email: 'a@x.io', password: 'pw' }, {}),
        ).resolves.toBeNull();
    });

    it('returns sessionVersion for an ACTIVE member', async () => {
        const auth = await loadAuth('credentials');
        mockFindUnique.mockResolvedValue({
            id: 'm1',
            name: 'A',
            email: 'a@x.io',
            avatarUrl: null,
            role: 'MEMBER',
            status: 'ACTIVE',
            passwordHash: 'h',
            sessionVersion: 7,
        });
        mockVerifyPassword.mockResolvedValue(true);

        await expect(
            credentialsAuthorize(auth)({ email: 'A@x.io', password: 'pw' }, {}),
        ).resolves.toMatchObject({
            id: 'm1',
            sessionVersion: 7,
        });
    });
});

describe('disable then re-enable', () => {
    beforeEach(() => mockFindUnique.mockReset());

    it('revokes a disabled member and does not revive the old token on re-enable', async () => {
        const auth = await loadAuth('credentials');
        // After PATCH DISABLED: status DISABLED, version bumped 0 -> 1.
        mockFindUnique.mockResolvedValue({ sessionVersion: 1, status: 'DISABLED' });
        await expect(readSession(auth, { memberId: 'm2', sv: 0 })).rejects.toThrow(
            'SESSION_REVOKED',
        );

        // After PATCH ACTIVE: status ACTIVE, version still 1.
        mockFindUnique.mockResolvedValue({ sessionVersion: 1, status: 'ACTIVE' });
        await expect(readSession(auth, { memberId: 'm2', sv: 0 })).rejects.toThrow(
            'SESSION_REVOKED',
        );
    });
});

describe('team PATCH -> jwt callback, end to end', () => {
    type Row = {
        id: string;
        status: string;
        role: string;
        sessionVersion: number;
        joinedAt: Date | null;
    };
    type UpdateArgs = { where: { id: string }; data: Record<string, unknown> };
    type UpdateManyArgs = {
        where: { id: string; joinedAt?: null | { not: null } };
        data: Record<string, unknown>;
    };

    let row: Row;

    beforeEach(() => {
        mockFindUnique.mockReset();
        mockUpdate.mockReset();
        mockUpdateMany.mockReset();
        mockGetServerSession.mockReset();
        row = {
            id: 'm2',
            status: 'ACTIVE',
            role: 'MEMBER',
            sessionVersion: 0,
            joinedAt: new Date(0),
        };

        // One in-memory TeamMember row shared by the route's update() and the
        // jwt callback's findUnique(), so a write by PATCH is what the callback reads.
        // Honors `select`, so the callback sees only the columns it actually asks for.
        mockFindUnique.mockImplementation(
            async ({
                where,
                select,
            }: {
                where: { id: string };
                select: Record<string, boolean>;
            }) =>
                where.id === row.id
                    ? Object.fromEntries(
                          Object.keys(select)
                              .filter((key) => select[key])
                              .map((key) => [key, (row as Record<string, unknown>)[key]]),
                      )
                    : null,
        );
        const apply = (data: Record<string, unknown>) => {
            for (const [key, value] of Object.entries(data)) {
                if (key === 'sessionVersion' && typeof value === 'object' && value !== null) {
                    row.sessionVersion += (value as { increment: number }).increment;
                } else {
                    (row as Record<string, unknown>)[key] = value;
                }
            }
        };
        mockUpdate.mockImplementation(async ({ where, data }: UpdateArgs) => {
            expect(where.id).toBe(row.id);
            apply(data);
            return { ...row };
        });
        // The enable path writes with a joinedAt condition; honor it like Postgres.
        mockUpdateMany.mockImplementation(async ({ where, data }: UpdateManyArgs) => {
            const joinedMatches =
                where.joinedAt === undefined ||
                (where.joinedAt === null ? row.joinedAt === null : row.joinedAt !== null);
            if (where.id !== row.id || !joinedMatches) return { count: 0 };
            apply(data);
            return { count: 1 };
        });
        mockGetServerSession.mockResolvedValue({
            user: { id: 'admin-1', role: 'ADMIN', memberId: 'admin-1' },
        });
    });

    async function callPatch(id: string, body: Record<string, unknown>) {
        const { PATCH } = await import('../app/api/team/[id]/route.js');
        return PATCH(
            new Request(`http://localhost:3000/api/team/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            }),
            { params: Promise.resolve({ id }) },
        );
    }

    async function patchMember(body: Record<string, unknown>) {
        const res = await callPatch('m2', body);
        expect(res.status).toBe(200);
    }

    it('disable bumps the stored version; the old token stays revoked after re-enable', async () => {
        const auth = await loadAuth('credentials');
        const oldToken = { memberId: 'm2', sv: 0, role: 'MEMBER' };

        // The member's existing session is current before the admin acts.
        await expect(readSession(auth, { ...oldToken })).resolves.toMatchObject({ sv: 0 });

        await patchMember({ status: 'DISABLED' });
        expect(row).toMatchObject({ status: 'DISABLED', sessionVersion: 1 });
        await expect(readSession(auth, { ...oldToken })).rejects.toThrow('SESSION_REVOKED');

        await patchMember({ status: 'ACTIVE' });
        expect(row).toMatchObject({ status: 'ACTIVE', sessionVersion: 1 });
        await expect(readSession(auth, { ...oldToken })).rejects.toThrow('SESSION_REVOKED');

        // A fresh sign-in after re-enable carries the new version and is accepted.
        await expect(readSession(auth, { ...oldToken, sv: 1 })).resolves.toMatchObject({ sv: 1 });
    });

    it('a role-only change does not revoke the member', async () => {
        const auth = await loadAuth('credentials');

        await patchMember({ role: 'ADMIN' });
        expect(row).toMatchObject({ role: 'ADMIN', sessionVersion: 0 });
        await expect(readSession(auth, { memberId: 'm2', sv: 0 })).resolves.toMatchObject({
            sv: 0,
        });
    });

    it('a demoted admin stays signed in but loses admin rights on the next request', async () => {
        const auth = await loadAuth('credentials');
        row.role = 'ADMIN';
        const oldToken = { memberId: 'm2', sv: 0, role: 'ADMIN' };

        // What getServerSession does with a cookie: the real jwt callback, then the
        // real session callback, using the authOptions the caller passes in.
        type Callbacks = NonNullable<NextAuthOptions['callbacks']>;
        type SessionArgs = Parameters<NonNullable<Callbacks['session']>>[0];
        async function resolveSession(options: NextAuthOptions, token: Record<string, unknown>) {
            const callbacks = options.callbacks!;
            const next = await callbacks.jwt!({ token: { ...token } } as JwtArgs);
            return callbacks.session!({
                session: { user: {}, expires: '' },
                token: next,
            } as unknown as SessionArgs);
        }

        await expect(resolveSession(auth, oldToken)).resolves.toMatchObject({
            user: { role: 'ADMIN', memberId: 'm2' },
        });

        await patchMember({ role: 'MEMBER' });
        // Role-only change: no sessionVersion bump, so the member is not signed out.
        expect(row).toMatchObject({ role: 'MEMBER', sessionVersion: 0 });
        await expect(readSession(auth, { ...oldToken })).resolves.toMatchObject({
            sv: 0,
            role: 'MEMBER',
        });
        await expect(resolveSession(auth, oldToken)).resolves.toMatchObject({
            user: { role: 'MEMBER', memberId: 'm2' },
        });

        // The old cookie no longer passes requireAdmin(), so admin routes refuse it.
        mockGetServerSession.mockImplementation((options: NextAuthOptions) =>
            resolveSession(options, oldToken),
        );
        const { requireAdmin } = await import('../lib/require-admin.js');
        const result = await requireAdmin();
        expect(result.session).toBeNull();
        expect(result.error?.status).toBe(403);

        const res = await callPatch('m3', { role: 'ADMIN' });
        expect(res.status).toBe(403);
        expect(mockUpdate).toHaveBeenCalledTimes(1);
    });
});
