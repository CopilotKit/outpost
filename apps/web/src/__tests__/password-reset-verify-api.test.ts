// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import { NextRequest } from 'next/server';

const mockHit = vi.fn();
vi.mock('@/lib/rate-limit', () => ({ hit: (...a: unknown[]) => mockHit(...a) }));
const mockIsValid = vi.fn();
vi.mock('@/lib/password-reset', () => ({
    isResetTokenValid: (...a: unknown[]) => mockIsValid(...a),
}));

import { POST } from '@/app/api/password-reset/verify/route';

const token = 'd'.repeat(64);
const INVALID = { error: 'This reset link is invalid or has expired.' };

function req(body: unknown, headers: Record<string, string> = {}) {
    return new NextRequest('http://localhost:3000/api/password-reset/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Real-IP': '198.51.100.7', ...headers },
        body: JSON.stringify(body),
    });
}

function captureConsole() {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
        vi.spyOn(console, m).mockImplementation(() => {}),
    );
    return () => spies.flatMap((s) => s.mock.calls.flat().map(String)).join('\n');
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

describe('POST /api/password-reset/verify', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv('AUTH_PROVIDER', 'credentials');
        mockHit.mockResolvedValue({ allowed: true });
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('200s a valid token, using the shared confirm IP limit', async () => {
        mockIsValid.mockResolvedValue(true);
        const res = await POST(req({ token }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
        expect(mockHit).toHaveBeenCalledWith('pwreset:confirm:ip:198.51.100.7', 20, 900);
        expect(mockIsValid).toHaveBeenCalledWith(token);
    });

    it('410s every bad token with one byte-identical message', async () => {
        mockIsValid.mockResolvedValue(false);
        const bodies = new Set<string>();
        for (const body of [{ token }, { token: 'junk' }, { token: 42 }, {}, []]) {
            const res = await POST(req(body));
            expect(res.status).toBe(410);
            bodies.add(await res.text());
        }
        expect([...bodies]).toEqual([JSON.stringify(INVALID)]);
    });

    it('429s over the limit without checking the token', async () => {
        mockHit.mockResolvedValue({ allowed: false });
        const res = await POST(req({ token }));
        expect(res.status).toBe(429);
        expect(await res.json()).toEqual({ error: 'Too many requests. Try again later.' });
        expect(mockIsValid).not.toHaveBeenCalled();
    });

    it.each(['github', 'oidc'])('404s in %s mode with no limiter hit', async (provider) => {
        vi.stubEnv('AUTH_PROVIDER', provider);
        const res = await POST(req({ token }));
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Not found' });
        expect(mockHit).not.toHaveBeenCalled();
        expect(mockIsValid).not.toHaveBeenCalled();
    });

    it('415s a non-JSON body', async () => {
        const plain = new NextRequest('http://localhost:3000/api/password-reset/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: `token=${token}`,
        });
        expect((await POST(plain)).status).toBe(415);
        expect(mockHit).not.toHaveBeenCalled();
    });

    it.each(NOT_JSON)('415s Content-Type %s before the limiter', async (contentType) => {
        const res = await POST(req({ token }, { 'Content-Type': contentType }));
        expect(res.status).toBe(415);
        expect(mockHit).not.toHaveBeenCalled();
        expect(mockIsValid).not.toHaveBeenCalled();
    });

    it.each(JSON_TYPES)('accepts Content-Type %s', async (contentType) => {
        mockIsValid.mockResolvedValue(true);
        const res = await POST(req({ token }, { 'Content-Type': contentType }));
        expect(res.status).toBe(200);
        expect(mockIsValid).toHaveBeenCalledWith(token);
    });

    it('500s when the limiter fails (never fails open)', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        mockHit.mockRejectedValue(new Error('db down'));
        const res = await POST(req({ token }));
        expect(res.status).toBe(500);
        expect(mockIsValid).not.toHaveBeenCalled();
    });

    it('never puts the token or its hash in a response or a log line', async () => {
        const logs = captureConsole();
        const hash = createHash('sha256').update(token).digest('hex');
        const surfaces: string[] = [];
        for (const setup of [
            () => mockIsValid.mockResolvedValue(true),
            () => mockIsValid.mockResolvedValue(false),
            () => mockHit.mockResolvedValueOnce({ allowed: false }),
            () => mockIsValid.mockRejectedValueOnce(new Error('boom')),
        ]) {
            setup();
            const res = await POST(req({ token }));
            surfaces.push(await res.text(), JSON.stringify([...res.headers.entries()]));
        }
        surfaces.push(logs());
        for (const s of surfaces) {
            expect(s).not.toContain(token);
            expect(s).not.toContain(hash);
        }
    });
});
