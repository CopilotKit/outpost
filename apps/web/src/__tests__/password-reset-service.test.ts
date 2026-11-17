import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';

const mockTokenDeleteMany = vi.fn();
const mockTokenCreate = vi.fn();
const mockTokenFindUnique = vi.fn();
const mockTransaction = vi.fn();
const mockQueryRaw = vi.fn();
const mockOrgFindFirst = vi.fn();
const mockMemberUpdate = vi.fn();

vi.mock('@copilotkit/outpost/db', () => ({
    prisma: {
        passwordResetToken: {
            deleteMany: (...a: unknown[]) => mockTokenDeleteMany(...a),
            create: (...a: unknown[]) => mockTokenCreate(...a),
            findUnique: (...a: unknown[]) => mockTokenFindUnique(...a),
        },
        organization: { findFirst: (...a: unknown[]) => mockOrgFindFirst(...a) },
        teamMember: { update: (...a: unknown[]) => mockMemberUpdate(...a) },
        $transaction: (...a: unknown[]) => mockTransaction(...a),
    },
}));

const mockSendEmail = vi.fn();
vi.mock('@copilotkit/outpost/shared/server', () => ({
    sendEmail: (...a: unknown[]) => mockSendEmail(...a),
}));

import {
    generateResetToken,
    hashResetToken,
    isWellFormedResetToken,
    buildResetUrl,
    issuePasswordReset,
    isResetTokenValid,
    consumePasswordReset,
    sendPasswordChangedEmail,
} from '@/lib/password-reset';

const member = { id: 'm1', email: 'alex@acme.test', sessionVersion: 4 };
const HEX64 = /^[0-9a-f]{64}$/;

function sha256(s: string): string {
    return createHash('sha256').update(s).digest('hex');
}

function allLogOutput(spies: Array<ReturnType<typeof vi.spyOn>>): string {
    return spies
        .flatMap((s) => s.mock.calls.map((c: unknown[]) => c.map(String).join(' ')))
        .join('\n');
}

describe('token primitives', () => {
    it('generates 64 hex characters', () => {
        expect(generateResetToken()).toMatch(HEX64);
        expect(generateResetToken()).not.toBe(generateResetToken());
    });

    it('hashes with SHA-256 hex', () => {
        expect(hashResetToken('abc')).toBe(
            'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
        );
    });

    it('accepts only 64 lowercase hex characters', () => {
        expect(isWellFormedResetToken('a'.repeat(64))).toBe(true);
        expect(isWellFormedResetToken('A'.repeat(64))).toBe(false);
        expect(isWellFormedResetToken('a'.repeat(63))).toBe(false);
        expect(isWellFormedResetToken(42)).toBe(false);
    });
});

describe('buildResetUrl', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('uses NEXTAUTH_URL and puts the token in the fragment', () => {
        vi.stubEnv('NEXTAUTH_URL', 'https://outpost.example.com/');
        expect(buildResetUrl('t0k')).toBe('https://outpost.example.com/reset-password#token=t0k');
    });

    it('returns null in production when NEXTAUTH_URL is unset (no localhost fallback)', () => {
        vi.stubEnv('NEXTAUTH_URL', '');
        vi.stubEnv('NODE_ENV', 'production');
        expect(buildResetUrl('t0k')).toBeNull();
    });
});

describe('issuePasswordReset', () => {
    const ISSUED_AT = new Date('2026-01-01T00:00:00Z');
    let logSpies: Array<ReturnType<typeof vi.spyOn>>;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv('NEXTAUTH_URL', 'https://outpost.example.com');
        mockTokenCreate.mockResolvedValue({ id: 'tok-new', createdAt: ISSUED_AT });
        mockTokenDeleteMany.mockResolvedValue({ count: 0 });
        mockQueryRaw.mockResolvedValue([]);
        // The delivered-path cleanup runs in an interactive transaction.
        mockTransaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) =>
            fn({
                $queryRaw: (...a: unknown[]) => mockQueryRaw(...a),
                passwordResetToken: { deleteMany: (...a: unknown[]) => mockTokenDeleteMany(...a) },
            }),
        );
        mockOrgFindFirst.mockResolvedValue({ name: 'Acme', email: 'noreply@acme.test' });
        mockSendEmail.mockResolvedValue({ success: true, method: 'postmark' });
        logSpies = (['log', 'info', 'warn', 'error'] as const).map((m) =>
            vi.spyOn(console, m).mockImplementation(() => {}),
        );
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('stores only the hash, records issuedVersion and requestedById, and sends the fixed email', async () => {
        const result = await issuePasswordReset(member, { requestedById: null });

        expect(result).toEqual({ emailSent: true });
        // Superseding older links and the audit purge run only after a successful send,
        // in one transaction that locks the member row before any token row.
        expect(mockTransaction).toHaveBeenCalledTimes(1);
        expect(mockQueryRaw).toHaveBeenCalledTimes(1);
        const [sql, ...params] = mockQueryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
        expect(sql.join('?')).toMatch(/FROM "TeamMember" WHERE "id" = \? FOR UPDATE/);
        expect(params).toEqual(['m1']);
        expect(mockQueryRaw.mock.invocationCallOrder[0]).toBeLessThan(
            mockTokenDeleteMany.mock.invocationCallOrder[0],
        );
        expect(mockTokenDeleteMany).toHaveBeenCalledTimes(1);
        expect(mockTokenDeleteMany).toHaveBeenCalledWith({
            where: {
                memberId: 'm1',
                OR: [
                    { usedAt: null, createdAt: { lt: ISSUED_AT } },
                    // A same-millisecond tie: the greater id wins, so one link stays live.
                    { usedAt: null, createdAt: ISSUED_AT, id: { lt: 'tok-new' } },
                    { createdAt: { lt: expect.any(Date) } },
                ],
            },
        });
        expect(mockSendEmail.mock.invocationCallOrder[0]).toBeLessThan(
            mockTokenDeleteMany.mock.invocationCallOrder[0],
        );
        const created = mockTokenCreate.mock.calls[0][0].data as Record<string, unknown>;

        const send = mockSendEmail.mock.calls[0][0] as {
            dbLookup?: unknown;
            context: { reset: { url: string } };
        };
        expect(send).toMatchObject({
            to: 'alex@acme.test',
            template: 'system/password-reset',
            requireTransport: true,
            trackLinks: 'None',
        });
        expect(send.dbLookup).toBeUndefined();
        const url = send.context.reset.url as string;
        expect(url).toMatch(/^https:\/\/outpost\.example\.com\/reset-password#token=[0-9a-f]{64}$/);
        const token = url.split('#token=')[1];

        expect(created.tokenHash).toBe(sha256(token));
        expect(created.tokenHash).not.toBe(token);
        expect(created).toMatchObject({ memberId: 'm1', issuedVersion: 4, requestedById: null });
        expect((created.expiresAt as Date).getTime() - Date.now()).toBeGreaterThan(29 * 60 * 1000);
        expect((created.expiresAt as Date).getTime() - Date.now()).toBeLessThanOrEqual(
            30 * 60 * 1000,
        );
        expect(send.context).toEqual({
            org: { name: 'Acme', email: 'noreply@acme.test' },
            member: { email: 'alex@acme.test' },
            reset: { url, expiresIn: '30 minutes' },
        });
        expect(mockMemberUpdate).not.toHaveBeenCalled();

        const logs = allLogOutput(logSpies);
        expect(logs).toContain('[PASSWORD_RESET] issued memberId=m1');
        expect(logs).not.toContain(token);
        expect(logs).not.toContain(created.tokenHash as string);
        expect(logs).not.toContain('reset-password');
    });

    it('logs an admin-issued line with the admin id', async () => {
        await issuePasswordReset(member, { requestedById: 'admin-1' });
        expect(mockTokenCreate.mock.calls[0][0].data.requestedById).toBe('admin-1');
        expect(allLogOutput(logSpies)).toContain(
            '[PASSWORD_RESET] admin-issued memberId=m1 by=admin-1',
        );
    });

    it('reports a failed send without leaking the link', async () => {
        mockSendEmail.mockResolvedValue({
            success: false,
            error: 'No email transport configured',
            method: 'console',
        });

        await expect(issuePasswordReset(member, { requestedById: null })).resolves.toEqual({
            emailSent: false,
        });
        const logs = allLogOutput(logSpies);
        expect(logs).toContain(
            '[PASSWORD_RESET] send failed memberId=m1 error=No email transport configured',
        );
        expect(logs).not.toContain('reset-password');
        // Only the undelivered row is dropped; earlier links are left alone.
        expect(mockTokenDeleteMany).toHaveBeenCalledTimes(1);
        expect(mockTokenDeleteMany).toHaveBeenCalledWith({ where: { id: 'tok-new' } });
    });

    it('drops only the undelivered row when the send throws', async () => {
        mockSendEmail.mockRejectedValue(new Error('smtp down'));

        await expect(issuePasswordReset(member, { requestedById: null })).resolves.toEqual({
            emailSent: false,
        });
        expect(allLogOutput(logSpies)).toContain(
            '[PASSWORD_RESET] send failed memberId=m1 error=smtp down',
        );
        expect(mockTokenDeleteMany).toHaveBeenCalledTimes(1);
        expect(mockTokenDeleteMany).toHaveBeenCalledWith({ where: { id: 'tok-new' } });
    });

    it('still reports a delivered email when the cleanup after it fails', async () => {
        mockTokenDeleteMany.mockRejectedValue(new Error('db gone'));

        await expect(issuePasswordReset(member, { requestedById: null })).resolves.toEqual({
            emailSent: true,
        });
        expect(allLogOutput(logSpies)).toContain(
            '[PASSWORD_RESET] token cleanup failed memberId=m1 error=db gone',
        );
    });

    it('sends nothing and writes nothing when NEXTAUTH_URL is unset in production', async () => {
        vi.stubEnv('NEXTAUTH_URL', '');
        vi.stubEnv('NODE_ENV', 'production');

        await expect(issuePasswordReset(member, { requestedById: null })).resolves.toEqual({
            emailSent: false,
        });
        expect(mockTokenCreate).not.toHaveBeenCalled();
        expect(mockSendEmail).not.toHaveBeenCalled();
    });
});

describe('isResetTokenValid', () => {
    const token = 'b'.repeat(64);
    const future = new Date(Date.now() + 60_000);
    const past = new Date(Date.now() - 60_000);
    const row = (over: Record<string, unknown> = {}, memberOver: Record<string, unknown> = {}) => ({
        usedAt: null,
        expiresAt: future,
        issuedVersion: 2,
        member: { status: 'ACTIVE', sessionVersion: 2, ...memberOver },
        ...over,
    });

    beforeEach(() => mockTokenFindUnique.mockReset());

    it('looks up by hash and accepts a live token', async () => {
        mockTokenFindUnique.mockResolvedValue(row());
        await expect(isResetTokenValid(token)).resolves.toBe(true);
        expect(mockTokenFindUnique.mock.calls[0][0].where).toEqual({ tokenHash: sha256(token) });
    });

    it.each([
        ['unknown', null],
        ['used', row({ usedAt: new Date() })],
        ['expired', row({ expiresAt: past })],
        ['version-mismatched', row({}, { sessionVersion: 3 })],
        ['member DISABLED', row({}, { status: 'DISABLED' })],
    ])('rejects a %s token', async (_label, value) => {
        mockTokenFindUnique.mockResolvedValue(value);
        await expect(isResetTokenValid(token)).resolves.toBe(false);
    });

    it('rejects a malformed token without a lookup', async () => {
        await expect(isResetTokenValid('not-hex')).resolves.toBe(false);
        expect(mockTokenFindUnique).not.toHaveBeenCalled();
    });
});

describe('consumePasswordReset', () => {
    const token = 'c'.repeat(64);
    type MockFn = ReturnType<typeof vi.fn>;
    let tx: {
        $queryRaw: MockFn;
        passwordResetToken: { updateMany: MockFn; findUnique: MockFn };
        teamMember: { updateMany: MockFn };
    };

    beforeEach(() => {
        vi.clearAllMocks();
        tx = {
            $queryRaw: vi.fn().mockResolvedValue([]),
            passwordResetToken: { updateMany: vi.fn(), findUnique: vi.fn() },
            teamMember: { updateMany: vi.fn() },
        };
        mockTransaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(tx));
    });

    it('claims with a conditional update on usedAt and expiresAt', async () => {
        tx.passwordResetToken.updateMany.mockResolvedValueOnce({ count: 0 });
        await expect(consumePasswordReset(token, 'new-hash')).resolves.toEqual({ ok: false });
        expect(tx.passwordResetToken.updateMany.mock.calls[0][0]).toEqual({
            where: { tokenHash: sha256(token), usedAt: null, expiresAt: { gt: expect.any(Date) } },
            data: { usedAt: expect.any(Date) },
        });
        expect(tx.teamMember.updateMany).not.toHaveBeenCalled();
    });

    it('sets the password, bumps sessionVersion with a compare-and-set, and burns other tokens', async () => {
        tx.passwordResetToken.updateMany
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 2 });
        tx.passwordResetToken.findUnique.mockResolvedValue({
            memberId: 'm1',
            issuedVersion: 4,
            member: { id: 'm1', email: 'alex@acme.test', status: 'ACTIVE', sessionVersion: 4 },
        });
        tx.teamMember.updateMany.mockResolvedValue({ count: 1 });

        await expect(consumePasswordReset(token, 'new-hash')).resolves.toEqual({
            ok: true,
            member: { id: 'm1', email: 'alex@acme.test' },
        });
        // Member row locked before any token row (the DB test proves the deadlock this prevents).
        expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
        expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
            tx.passwordResetToken.updateMany.mock.invocationCallOrder[0],
        );
        expect(tx.teamMember.updateMany).toHaveBeenCalledWith({
            where: { id: 'm1', status: 'ACTIVE', sessionVersion: 4 },
            data: { passwordHash: 'new-hash', sessionVersion: { increment: 1 } },
        });
        expect(tx.passwordResetToken.updateMany.mock.calls[1][0]).toEqual({
            where: { memberId: 'm1', usedAt: null },
            data: { usedAt: expect.any(Date) },
        });
    });

    it('rolls back and refuses when the member version moved', async () => {
        tx.passwordResetToken.updateMany.mockResolvedValueOnce({ count: 1 });
        tx.passwordResetToken.findUnique.mockResolvedValue({
            memberId: 'm1',
            issuedVersion: 4,
            member: { id: 'm1', email: 'a', status: 'ACTIVE', sessionVersion: 5 },
        });

        await expect(consumePasswordReset(token, 'new-hash')).resolves.toEqual({ ok: false });
        expect(tx.teamMember.updateMany).not.toHaveBeenCalled();
    });

    it('rolls back and refuses when the member write loses its compare-and-set', async () => {
        tx.passwordResetToken.updateMany.mockResolvedValueOnce({ count: 1 });
        tx.passwordResetToken.findUnique.mockResolvedValue({
            memberId: 'm1',
            issuedVersion: 4,
            member: { id: 'm1', email: 'a', status: 'ACTIVE', sessionVersion: 4 },
        });
        tx.teamMember.updateMany.mockResolvedValue({ count: 0 });

        await expect(consumePasswordReset(token, 'new-hash')).resolves.toEqual({ ok: false });
    });

    it('refuses a malformed token without a transaction', async () => {
        await expect(consumePasswordReset('zz', 'h')).resolves.toEqual({ ok: false });
        expect(mockTransaction).not.toHaveBeenCalled();
    });
});

describe('sendPasswordChangedEmail', () => {
    it('sends the fixed changed email and requires a transport', async () => {
        vi.clearAllMocks();
        mockOrgFindFirst.mockResolvedValue(null);
        mockSendEmail.mockResolvedValue({ success: true, method: 'smtp' });

        await sendPasswordChangedEmail({ id: 'm1', email: 'alex@acme.test' });

        expect(mockSendEmail.mock.calls[0][0]).toMatchObject({
            to: 'alex@acme.test',
            template: 'system/password-changed',
            requireTransport: true,
            context: {
                org: { name: 'Outpost', email: 'noreply@outpost.dev' },
                member: { email: 'alex@acme.test' },
            },
        });
    });
});
