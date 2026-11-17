// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as NextServer from 'next/server';
import type * as PasswordResetService from '@/lib/password-reset';

// after() needs a live Next request scope; queue the callbacks and run them by hand.
const afterQueue: Array<() => unknown> = [];
vi.mock('next/server', async (importOriginal) => {
    const actual = await importOriginal<typeof NextServer>();
    return {
        ...actual,
        after: (fn: () => unknown) => {
            afterQueue.push(fn);
        },
    };
});

const mockHit = vi.fn();
vi.mock('@/lib/rate-limit', () => ({ hit: (...a: unknown[]) => mockHit(...a) }));
const mockConsume = vi.fn();
const mockChangedEmail = vi.fn();
vi.mock('@/lib/password-reset', async (importOriginal) => {
    const actual = await importOriginal<typeof PasswordResetService>();
    return {
        isWellFormedResetToken: actual.isWellFormedResetToken,
        consumePasswordReset: (...a: unknown[]) => mockConsume(...a),
        sendPasswordChangedEmail: (...a: unknown[]) => mockChangedEmail(...a),
    };
});
const mockHashPassword = vi.fn();
vi.mock('@copilotkit/outpost/shared', () => ({
    hashPassword: (...a: unknown[]) => mockHashPassword(...a),
}));
vi.mock('@copilotkit/outpost/db', () => ({ prisma: {} }));
vi.mock('@copilotkit/outpost/shared/server', () => ({ sendEmail: vi.fn() }));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/password-reset/confirm/route';

const token = 'e'.repeat(64);
function req(body: unknown, headers: Record<string, string> = {}) {
    return new NextRequest('http://localhost:3000/api/password-reset/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
}

// Media types that merely start with or contain application/json are not JSON.
// text/plain is CORS-simple, so a cross-origin form could send it with no preflight.
const NOT_JSON = [
    'application/json-patch+json',
    'application/json.evil',
    'application/jsonx',
    'text/plain; x=application/json',
];
const JSON_TYPES = [
    'Application/JSON; charset=utf-8',
    'application/json;charset=utf-8',
    'application/json ; charset=utf-8',
];

describe('POST /api/password-reset/confirm', () => {
    let spies: Array<ReturnType<typeof vi.spyOn>>;

    beforeEach(() => {
        vi.clearAllMocks();
        afterQueue.length = 0;
        vi.stubEnv('AUTH_PROVIDER', 'credentials');
        mockHit.mockResolvedValue({ allowed: true });
        mockHashPassword.mockResolvedValue('bcrypt-hash');
        spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
            vi.spyOn(console, m).mockImplementation(() => {}),
        );
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    function logged(): string {
        return spies.flatMap((s) => s.mock.calls.flat().map(String)).join('\n');
    }

    it('hashes first, consumes, then sends the changed email after the response', async () => {
        mockConsume.mockResolvedValue({ ok: true, member: { id: 'm1', email: 'alex@acme.test' } });

        const res = await POST(
            req({ token, password: 'new-pass-1', confirmPassword: 'new-pass-1' }),
        );

        expect(res.status).toBe(200);
        const text = await res.text();
        expect(JSON.parse(text)).toEqual({ ok: true });
        expect(text).not.toContain(token);
        expect(mockHit).toHaveBeenCalledWith('pwreset:confirm:ip:unknown', 20, 900);
        expect(mockHashPassword).toHaveBeenCalledWith('new-pass-1');
        expect(mockConsume).toHaveBeenCalledWith(token, 'bcrypt-hash');
        expect(mockChangedEmail).not.toHaveBeenCalled();
        expect(afterQueue).toHaveLength(1);
        await afterQueue.shift()!();
        expect(mockChangedEmail).toHaveBeenCalledWith({ id: 'm1', email: 'alex@acme.test' });

        const out = logged();
        expect(out).toContain('[PASSWORD_RESET] consumed memberId=m1');
        expect(out).not.toContain(token);
        expect(out).not.toContain('new-pass-1');
        expect(out).not.toContain('bcrypt-hash');
    });

    it('keys the limit on X-Real-IP, shared with verify', async () => {
        mockConsume.mockResolvedValue({ ok: false });
        await POST(
            req(
                { token, password: 'new-pass-1', confirmPassword: 'new-pass-1' },
                { 'X-Real-IP': '198.51.100.7' },
            ),
        );
        expect(mockHit).toHaveBeenCalledWith('pwreset:confirm:ip:198.51.100.7', 20, 900);
    });

    it('410s a used, expired or stale token with the uniform message', async () => {
        mockConsume.mockResolvedValue({ ok: false });
        const res = await POST(
            req({ token, password: 'new-pass-1', confirmPassword: 'new-pass-1' }),
        );
        expect(res.status).toBe(410);
        const text = await res.text();
        expect(JSON.parse(text)).toEqual({ error: 'This reset link is invalid or has expired.' });
        expect(text).not.toContain(token);
        expect(afterQueue).toHaveLength(0);
        expect(mockChangedEmail).not.toHaveBeenCalled();
        expect(logged()).not.toContain(token);
    });

    it.each([
        ['short', 'short', 'short', 'Password must be at least 8 characters.'],
        ['over 72 bytes', 'é'.repeat(37), 'é'.repeat(37), 'Password must be 72 bytes or fewer.'],
        ['mismatch', 'new-pass-1', 'new-pass-2', 'Passwords do not match.'],
        ['missing', undefined, undefined, 'Password is required.'],
    ])(
        '400s a %s password without hashing or touching the token',
        async (_l, password, confirmPassword, message) => {
            const res = await POST(req({ token, password, confirmPassword }));
            expect(res.status).toBe(400);
            expect((await res.json()).errors).toContain(message);
            expect(mockHashPassword).not.toHaveBeenCalled();
            expect(mockConsume).not.toHaveBeenCalled();
        },
    );

    it.each([['nope'], [undefined], [123], ['E'.repeat(64)]])(
        '410s a malformed token (%s) without hashing',
        async (bad) => {
            const res = await POST(
                req({ token: bad, password: 'new-pass-1', confirmPassword: 'new-pass-1' }),
            );
            expect(res.status).toBe(410);
            expect(await res.json()).toEqual({
                error: 'This reset link is invalid or has expired.',
            });
            expect(mockHashPassword).not.toHaveBeenCalled();
            expect(mockConsume).not.toHaveBeenCalled();
        },
    );

    it('429s before validating or hashing', async () => {
        mockHit.mockResolvedValue({ allowed: false });
        const res = await POST(req({ token, password: 'x', confirmPassword: 'y' }));
        expect(res.status).toBe(429);
        expect(mockHashPassword).not.toHaveBeenCalled();
        expect(mockConsume).not.toHaveBeenCalled();
    });

    it('500s when the limiter fails (never fails open)', async () => {
        mockHit.mockRejectedValue(new Error('db down'));
        const res = await POST(
            req({ token, password: 'new-pass-1', confirmPassword: 'new-pass-1' }),
        );
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: 'Something went wrong. Try again.' });
        expect(mockHashPassword).not.toHaveBeenCalled();
        expect(mockConsume).not.toHaveBeenCalled();
        expect(afterQueue).toHaveLength(0);
    });

    it('500s with a generic message when consume throws, without leaking the token', async () => {
        mockConsume.mockRejectedValue(new Error('connection refused'));
        const res = await POST(
            req({ token, password: 'new-pass-1', confirmPassword: 'new-pass-1' }),
        );
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: 'Something went wrong. Try again.' });
        expect(logged()).not.toContain(token);
    });

    it('404s outside credentials mode', async () => {
        vi.stubEnv('AUTH_PROVIDER', 'github');
        const res = await POST(
            req({ token, password: 'new-pass-1', confirmPassword: 'new-pass-1' }),
        );
        expect(res.status).toBe(404);
        expect(mockHit).not.toHaveBeenCalled();
    });

    it.each(NOT_JSON)('415s Content-Type %s before the limiter', async (contentType) => {
        const res = await POST(
            req(
                { token, password: 'new-pass-1', confirmPassword: 'new-pass-1' },
                { 'Content-Type': contentType },
            ),
        );
        expect(res.status).toBe(415);
        expect(mockHit).not.toHaveBeenCalled();
        expect(mockHashPassword).not.toHaveBeenCalled();
        expect(mockConsume).not.toHaveBeenCalled();
    });

    it.each(JSON_TYPES)('accepts Content-Type %s', async (contentType) => {
        mockConsume.mockResolvedValue({ ok: true, member: { id: 'm1', email: 'alex@acme.test' } });
        const res = await POST(
            req(
                { token, password: 'new-pass-1', confirmPassword: 'new-pass-1' },
                { 'Content-Type': contentType },
            ),
        );
        expect(res.status).toBe(200);
        expect(mockConsume).toHaveBeenCalledWith(token, 'bcrypt-hash');
    });

    it('415s a non-JSON body', async () => {
        const res = await POST(
            new NextRequest('http://localhost:3000/api/password-reset/confirm', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `token=${token}&password=new-pass-1&confirmPassword=new-pass-1`,
            }),
        );
        expect(res.status).toBe(415);
        expect(mockConsume).not.toHaveBeenCalled();
    });
});
