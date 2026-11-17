import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGetServerSession = vi.fn();
vi.mock('next-auth', () => ({ getServerSession: (...a: unknown[]) => mockGetServerSession(...a) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const mockHit = vi.fn();
vi.mock('@/lib/rate-limit', () => ({ hit: (...a: unknown[]) => mockHit(...a) }));

const mockFindUnique = vi.fn();
const mockMemberUpdate = vi.fn();
const mockMemberUpdateMany = vi.fn();
const mockTokenCreate = vi.fn();
const mockTokenDeleteMany = vi.fn();
const mockQueryRaw = vi.fn();
vi.mock('@copilotkit/outpost/db', () => ({
    prisma: {
        teamMember: {
            findUnique: (...a: unknown[]) => mockFindUnique(...a),
            update: (...a: unknown[]) => mockMemberUpdate(...a),
            updateMany: (...a: unknown[]) => mockMemberUpdateMany(...a),
        },
        passwordResetToken: {
            create: (...a: unknown[]) => mockTokenCreate(...a),
            deleteMany: (...a: unknown[]) => mockTokenDeleteMany(...a),
        },
        organization: { findFirst: vi.fn().mockResolvedValue(null) },
        // The delivered-path cleanup locks the member row, then deletes, in one transaction.
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
            fn({
                $queryRaw: (...a: unknown[]) => mockQueryRaw(...a),
                passwordResetToken: { deleteMany: (...a: unknown[]) => mockTokenDeleteMany(...a) },
            }),
    },
}));

const mockSendEmail = vi.fn();
vi.mock('@copilotkit/outpost/shared/server', () => ({
    sendEmail: (...a: unknown[]) => mockSendEmail(...a),
}));

import { POST } from '@/app/api/team/[id]/password-reset/route';

const ADMIN = { user: { role: 'ADMIN', memberId: 'admin-1' } };
const TARGET = {
    id: 'm2',
    email: 'bob@acme.test',
    status: 'ACTIVE',
    passwordHash: 'h',
    sessionVersion: 5,
};

function call(id: string) {
    return POST(
        new Request(`http://localhost:3000/api/team/${id}/password-reset`, { method: 'POST' }),
        {
            params: Promise.resolve({ id }),
        },
    );
}

describe('POST /api/team/[id]/password-reset', () => {
    let spies: Array<ReturnType<typeof vi.spyOn>>;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv('AUTH_PROVIDER', 'credentials');
        vi.stubEnv('NEXTAUTH_URL', 'https://outpost.example.com');
        mockGetServerSession.mockResolvedValue(ADMIN);
        mockFindUnique.mockResolvedValue(TARGET);
        mockHit.mockResolvedValue({ allowed: true });
        mockTokenCreate.mockResolvedValue({ id: 'tok-new', createdAt: new Date() });
        mockTokenDeleteMany.mockResolvedValue({ count: 0 });
        mockQueryRaw.mockResolvedValue([]);
        mockSendEmail.mockResolvedValue({ success: true, method: 'postmark' });
        spies = (['log', 'info', 'warn', 'error'] as const).map((m) =>
            vi.spyOn(console, m).mockImplementation(() => {}),
        );
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('issues a link for an ACTIVE member with a password, and never returns it', async () => {
        const res = await call('m2');
        const text = await res.text();

        expect(res.status).toBe(200);
        expect(JSON.parse(text)).toEqual({ ok: true, emailSent: true });
        expect(mockHit).toHaveBeenCalledWith('pwreset:admin:member:m2', 3, 3600);

        const created = mockTokenCreate.mock.calls[0][0].data;
        expect(created).toMatchObject({
            memberId: 'm2',
            issuedVersion: 5,
            requestedById: 'admin-1',
        });
        expect(mockTokenDeleteMany).toHaveBeenCalledWith({
            where: {
                memberId: 'm2',
                OR: [
                    { usedAt: null, createdAt: { lt: expect.any(Date) } },
                    { usedAt: null, createdAt: expect.any(Date), id: { lt: 'tok-new' } },
                    { createdAt: { lt: expect.any(Date) } },
                ],
            },
        });

        const send = mockSendEmail.mock.calls[0][0];
        expect(send).toMatchObject({
            to: 'bob@acme.test',
            template: 'system/password-reset',
            requireTransport: true,
            trackLinks: 'None',
        });
        const token = (send.context.reset.url as string).split('#token=')[1];
        expect(token).toMatch(/^[0-9a-f]{64}$/);
        expect(text).not.toContain('reset-password');
        expect(text).not.toContain(token);
        expect(text).not.toContain(created.tokenHash);

        const logs = spies.flatMap((s) => s.mock.calls.flat().map(String)).join('\n');
        expect(logs).toContain('[PASSWORD_RESET] admin-issued memberId=m2 by=admin-1');
        expect(logs).not.toContain('token cleanup failed');
        expect(logs).not.toContain(token);
        expect(logs).not.toContain(created.tokenHash);
        expect(logs).not.toContain('reset-password');
    });

    it('does not bump sessionVersion: sending revokes nothing', async () => {
        const res = await call('m2');
        expect(res.status).toBe(200);
        expect(mockMemberUpdate).not.toHaveBeenCalled();
        expect(mockMemberUpdateMany).not.toHaveBeenCalled();
        // The only writes are the token create and, after the send, one token delete
        // under a lock on the member row (a lock, not a write).
        expect(mockTokenDeleteMany).toHaveBeenCalledTimes(1);
        expect(mockQueryRaw).toHaveBeenCalledTimes(1);
        expect(mockTokenCreate).toHaveBeenCalledTimes(1);
        expect(mockTokenCreate.mock.calls[0][0].data.issuedVersion).toBe(5);
    });

    it('reports emailSent: false when the send fails', async () => {
        mockSendEmail.mockResolvedValue({
            success: false,
            error: 'No email transport configured',
            method: 'console',
        });
        const res = await call('m2');
        expect(await res.json()).toEqual({ ok: true, emailSent: false });
    });

    it('401s unauthenticated and 403s a non-admin, creating no token', async () => {
        mockGetServerSession.mockResolvedValueOnce(null);
        expect((await call('m2')).status).toBe(401);
        mockGetServerSession.mockResolvedValueOnce({ user: { role: 'MEMBER', memberId: 'm9' } });
        expect((await call('m2')).status).toBe(403);
        expect(mockTokenCreate).not.toHaveBeenCalled();
        expect(mockSendEmail).not.toHaveBeenCalled();
        expect(mockHit).not.toHaveBeenCalled();
    });

    it('404s outside credentials mode', async () => {
        vi.stubEnv('AUTH_PROVIDER', 'oidc');
        expect((await call('m2')).status).toBe(404);
        expect(mockTokenCreate).not.toHaveBeenCalled();
    });

    it('400s a self-target', async () => {
        const res = await call('admin-1');
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
            error: 'Use Forgot password or your profile to change your own password.',
        });
        expect(mockTokenCreate).not.toHaveBeenCalled();
    });

    it('404s an unknown member', async () => {
        mockFindUnique.mockResolvedValue(null);
        const res = await call('nope');
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Member not found' });
    });

    it.each([
        ['INVITED', { ...TARGET, status: 'INVITED' }],
        ['DISABLED', { ...TARGET, status: 'DISABLED' }],
        ['no password', { ...TARGET, passwordHash: null }],
    ])('409s a %s member', async (_l, member) => {
        mockFindUnique.mockResolvedValue(member);
        const res = await call('m2');
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({
            error: 'This member has no password to reset. Only active members who sign in with a password can get a reset link.',
        });
        expect(mockTokenCreate).not.toHaveBeenCalled();
    });

    it('429s over the per-member limit', async () => {
        mockHit.mockResolvedValue({ allowed: false });
        const res = await call('m2');
        expect(res.status).toBe(429);
        expect(await res.json()).toEqual({
            error: 'Too many reset attempts for this member. Try again later.',
        });
        expect(mockTokenCreate).not.toHaveBeenCalled();
    });

    it('counts failed sends, so the 429 does not claim a link was sent', async () => {
        // The limiter runs before the issue to bound abuse, so a failed send still
        // uses a slot. The 429 must not say a link was sent when none was.
        const counts = new Map<string, number>();
        mockHit.mockImplementation(async (key: string, limit: number) => {
            const n = (counts.get(key) ?? 0) + 1;
            counts.set(key, n);
            return { allowed: n <= limit };
        });
        mockSendEmail.mockResolvedValue({
            success: false,
            error: 'No email transport configured',
            method: 'console',
        });

        const statuses: number[] = [];
        const bodies: unknown[] = [];
        for (let i = 0; i < 4; i++) {
            const res = await call('m2');
            statuses.push(res.status);
            bodies.push(await res.json());
        }

        expect(statuses).toEqual([200, 200, 200, 429]);
        expect(bodies.slice(0, 3)).toEqual(Array(3).fill({ ok: true, emailSent: false }));
        expect(bodies[3]).toEqual({
            error: 'Too many reset attempts for this member. Try again later.',
        });
        expect(JSON.stringify(bodies[3])).not.toContain('sent');
    });

    it('500s when the limiter fails, issuing no token and sending no email', async () => {
        mockHit.mockRejectedValue(new Error('db down'));
        const res = await call('m2');
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: 'Something went wrong. Try again.' });
        // issuePasswordReset writes create, then deleteMany: neither may run.
        expect(mockTokenCreate).not.toHaveBeenCalled();
        expect(mockTokenDeleteMany).not.toHaveBeenCalled();
        expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it('allows three sends to one member within an hour and refuses the fourth', async () => {
        // A counting limiter with the real hit() contract: allowed while count <= limit.
        const counts = new Map<string, number>();
        mockHit.mockImplementation(async (key: string, limit: number) => {
            const n = (counts.get(key) ?? 0) + 1;
            counts.set(key, n);
            return { allowed: n <= limit };
        });

        const statuses: number[] = [];
        for (let i = 0; i < 4; i++) statuses.push((await call('m2')).status);

        expect(statuses).toEqual([200, 200, 200, 429]);
        expect(mockTokenCreate).toHaveBeenCalledTimes(3);
        expect(mockSendEmail).toHaveBeenCalledTimes(3);
        for (const c of mockHit.mock.calls) {
            expect(c).toEqual(['pwreset:admin:member:m2', 3, 3600]);
        }
    });
});
