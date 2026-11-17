// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import { NextRequest } from 'next/server';
import type * as NextServer from 'next/server';

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
async function drainAfter() {
    while (afterQueue.length) await afterQueue.shift()!();
}

const mockHit = vi.fn();
vi.mock('@/lib/rate-limit', () => ({ hit: (...a: unknown[]) => mockHit(...a) }));

const mockMemberFindUnique = vi.fn();
const mockTokenCreate = vi.fn();
const mockTokenDeleteMany = vi.fn();
const mockQueryRaw = vi.fn();
vi.mock('@copilotkit/outpost/db', () => ({
    prisma: {
        teamMember: { findUnique: (...a: unknown[]) => mockMemberFindUnique(...a) },
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

import { POST } from '@/app/api/password-reset/request/route';

const ACTIVE = {
    id: 'm1',
    email: 'alex@acme.test',
    status: 'ACTIVE',
    passwordHash: 'h',
    sessionVersion: 0,
};

function req(body: unknown, headers: Record<string, string> = {}) {
    return new NextRequest('http://localhost:3000/api/password-reset/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Real-IP': '203.0.113.9', ...headers },
        body: JSON.stringify(body),
    });
}

/** Status, body bytes, and every header, so two responses can be compared exactly. */
async function snapshot(res: Response) {
    return {
        status: res.status,
        body: await res.text(),
        headers: [...res.headers.entries()].sort(([a], [b]) => a.localeCompare(b)),
    };
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

describe('POST /api/password-reset/request', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        afterQueue.length = 0;
        vi.stubEnv('AUTH_PROVIDER', 'credentials');
        vi.stubEnv('NEXTAUTH_URL', 'https://outpost.example.com');
        mockHit.mockResolvedValue({ allowed: true });
        mockSendEmail.mockResolvedValue({ success: true, method: 'smtp' });
        mockTokenCreate.mockResolvedValue({ id: 'tok-new', createdAt: new Date() });
        mockTokenDeleteMany.mockResolvedValue({ count: 0 });
        mockQueryRaw.mockResolvedValue([]);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('returns before the lookup, then emails a known ACTIVE member', async () => {
        const logs = captureConsole();
        mockMemberFindUnique.mockResolvedValue(ACTIVE);

        const res = await POST(req({ email: '  Alex@Acme.test ' }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
        expect(mockMemberFindUnique).not.toHaveBeenCalled();

        await drainAfter();
        expect(mockMemberFindUnique.mock.calls[0][0].where).toEqual({ email: 'alex@acme.test' });
        expect(mockSendEmail).toHaveBeenCalledTimes(1);
        // The delivered-path cleanup really ran, under the member lock, and did not fail.
        expect(mockQueryRaw).toHaveBeenCalledTimes(1);
        expect(mockTokenDeleteMany).toHaveBeenCalledTimes(1);
        expect(logs()).not.toContain('token cleanup failed');
    });

    it('builds the link from NEXTAUTH_URL even with a forged Host', async () => {
        mockMemberFindUnique.mockResolvedValue(ACTIVE);
        await POST(
            req(
                { email: 'alex@acme.test' },
                { Host: 'evil.example', 'X-Forwarded-Host': 'evil.example' },
            ),
        );
        await drainAfter();
        expect(mockSendEmail.mock.calls[0][0].context.reset.url).toMatch(
            /^https:\/\/outpost\.example\.com\/reset-password#token=[0-9a-f]{64}$/,
        );
    });

    it.each([
        ['unknown', null],
        ['no password', { ...ACTIVE, passwordHash: null }],
        ['INVITED', { ...ACTIVE, status: 'INVITED' }],
        ['DISABLED', { ...ACTIVE, status: 'DISABLED' }],
    ])('gives a %s account the identical response and no email', async (_label, member) => {
        mockMemberFindUnique.mockResolvedValue(member);
        const res = await POST(req({ email: 'alex@acme.test' }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
        await drainAfter();
        expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it('answers an existing and an unknown email with byte-identical responses', async () => {
        mockMemberFindUnique.mockImplementation(async ({ where }: { where: { email: string } }) =>
            where.email === ACTIVE.email ? ACTIVE : null,
        );

        const known = await snapshot(await POST(req({ email: 'alex@acme.test' })));
        const unknown = await snapshot(await POST(req({ email: 'nobody@acme.test' })));
        await drainAfter();

        expect(known.status).toBe(200);
        expect(known.body).toBe('{"ok":true}');
        expect(unknown).toEqual(known);
        // The lookup really did tell them apart: only the known member got an email.
        expect(mockSendEmail).toHaveBeenCalledTimes(1);
        expect(mockSendEmail.mock.calls[0][0].to).toBe('alex@acme.test');
    });

    it('never puts the token, its hash, or the URL in the response or a log line', async () => {
        const logs = captureConsole();
        mockMemberFindUnique.mockResolvedValue(ACTIVE);

        const res = await POST(req({ email: 'alex@acme.test' }));
        const snap = await snapshot(res);
        await drainAfter();

        const url: string = mockSendEmail.mock.calls[0][0].context.reset.url;
        const token = url.split('#token=')[1];
        expect(token).toMatch(/^[0-9a-f]{64}$/);
        const hash = createHash('sha256').update(token).digest('hex');
        const surfaces = [snap.body, JSON.stringify(snap.headers), logs()];
        for (const s of surfaces) {
            expect(s).not.toContain(token);
            expect(s).not.toContain(hash);
            expect(s).not.toContain('reset-password');
        }
        expect(logs()).not.toContain('token cleanup failed');
    });

    it('400s a bad email shape', async () => {
        const res = await POST(req({ email: 'not-an-email' }));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'Enter a valid email address.' });
        expect(mockHit).not.toHaveBeenCalled();
    });

    it('429s on the IP limit without consulting the email limit', async () => {
        mockHit.mockResolvedValueOnce({ allowed: false });
        const res = await POST(req({ email: 'alex@acme.test' }));
        expect(res.status).toBe(429);
        expect(await res.json()).toEqual({ error: 'Too many requests. Try again later.' });
        expect(mockHit).toHaveBeenCalledTimes(1);
        expect(mockHit.mock.calls[0]).toEqual(['pwreset:req:ip:203.0.113.9', 10, 900]);
        expect(afterQueue).toHaveLength(0);
    });

    it('keys the email limit by sha256(email) and answers 200 with no send when over it', async () => {
        mockHit.mockResolvedValueOnce({ allowed: true }).mockResolvedValueOnce({ allowed: false });
        const res = await POST(req({ email: 'Alex@Acme.test' }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
        const emailKey = createHash('sha256').update('alex@acme.test').digest('hex');
        expect(mockHit.mock.calls[1]).toEqual([`pwreset:req:email:${emailKey}`, 3, 3600]);
        await drainAfter();
        expect(mockMemberFindUnique).not.toHaveBeenCalled();
        expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it('415s a non-JSON body', async () => {
        const plain = new NextRequest('http://localhost:3000/api/password-reset/request', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: 'email=a@b.co',
        });
        expect((await POST(plain)).status).toBe(415);
        expect(mockHit).not.toHaveBeenCalled();
    });

    it.each(NOT_JSON)('415s Content-Type %s before the limiter', async (contentType) => {
        const res = await POST(req({ email: 'alex@acme.test' }, { 'Content-Type': contentType }));
        expect(res.status).toBe(415);
        expect(mockHit).not.toHaveBeenCalled();
    });

    it.each(JSON_TYPES)('accepts Content-Type %s', async (contentType) => {
        const res = await POST(req({ email: 'alex@acme.test' }, { 'Content-Type': contentType }));
        expect(res.status).toBe(200);
        expect(mockHit).toHaveBeenCalled();
    });

    it.each(['oidc', 'github'])(
        '404s in %s mode with no limiter hit and no lookup',
        async (provider) => {
            vi.stubEnv('AUTH_PROVIDER', provider);
            const res = await POST(req({ email: 'alex@acme.test' }));
            expect(res.status).toBe(404);
            expect(await res.json()).toEqual({ error: 'Not found' });
            expect(mockHit).not.toHaveBeenCalled();
            expect(afterQueue).toHaveLength(0);
        },
    );

    it('500s when the limiter fails (never fails open)', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        mockHit.mockRejectedValue(new Error('db down'));
        const res = await POST(req({ email: 'alex@acme.test' }));
        expect(res.status).toBe(500);
        expect(afterQueue).toHaveLength(0);
    });

    it('never logs an unknown submitted email', async () => {
        const logs = captureConsole();
        mockMemberFindUnique.mockResolvedValue(null);
        await POST(req({ email: 'nobody@acme.test' }));
        await drainAfter();
        expect(logs()).not.toContain('nobody@acme.test');
    });
});
