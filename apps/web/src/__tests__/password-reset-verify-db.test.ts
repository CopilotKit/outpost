// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomBytes, randomUUID } from 'crypto';
import type { NextRequest as NextRequestType } from 'next/server';
import type * as VerifyRoute from '@/app/api/password-reset/verify/route';
import type * as ResetService from '@/lib/password-reset';
import type { prisma as PrismaInstance } from '@copilotkit/outpost/db';

const url = process.env.OUTPOST_TEST_DATABASE_URL;
const requireDb = process.env.OUTPOST_REQUIRE_DB_TESTS === '1';

// Real route, real Postgres limiter, real token service; nothing is mocked.
describe.skipIf(!url && !requireDb)('POST /api/password-reset/verify against real Postgres', () => {
    let POST: typeof VerifyRoute.POST;
    let NextRequest: typeof NextRequestType;
    let prisma: typeof PrismaInstance;
    let hashResetToken: typeof ResetService.hashResetToken;
    let memberId: string;
    const logs: string[] = [];
    const tokens: string[] = [];

    beforeAll(async () => {
        if (!url) {
            throw new Error('OUTPOST_REQUIRE_DB_TESTS=1 but OUTPOST_TEST_DATABASE_URL is not set');
        }
        process.env.DATABASE_URL = url;
        process.env.AUTH_PROVIDER = 'credentials';
        vi.resetModules();
        ({ POST } = await import('@/app/api/password-reset/verify/route'));
        ({ NextRequest } = await import('next/server'));
        ({ prisma } = await import('@copilotkit/outpost/db'));
        ({ hashResetToken } = await import('@/lib/password-reset'));
        const m = await prisma.teamMember.create({
            data: {
                name: 'Verify Test',
                email: `verify-${randomUUID()}@test.local`,
                passwordHash: 'h',
                status: 'ACTIVE',
            },
        });
        memberId = m.id;
        for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
            vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
                logs.push(args.map(String).join(' '));
            });
        }
    });

    afterAll(async () => {
        vi.restoreAllMocks();
        if (!prisma) return;
        if (memberId) await prisma.teamMember.delete({ where: { id: memberId } });
        await prisma.$disconnect();
    });

    /** Inserts a token row for the test member and returns the raw token. */
    async function seed(overrides: {
        expiresAt?: Date;
        usedAt?: Date | null;
        issuedVersion?: number;
    }) {
        const raw = randomBytes(32).toString('hex');
        tokens.push(raw);
        await prisma.passwordResetToken.create({
            data: {
                memberId,
                tokenHash: hashResetToken(raw),
                issuedVersion: overrides.issuedVersion ?? 0,
                expiresAt: overrides.expiresAt ?? new Date(Date.now() + 30 * 60 * 1000),
                usedAt: overrides.usedAt ?? null,
            },
        });
        return raw;
    }

    function req(token: string, ip: string) {
        return new NextRequest('http://localhost:3000/api/password-reset/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Real-IP': ip },
            body: JSON.stringify({ token }),
        });
    }

    it('200s a live token and gives used, expired, stale and unknown tokens one identical 410', async () => {
        const live = await seed({});
        const used = await seed({ usedAt: new Date() });
        const expired = await seed({ expiresAt: new Date(Date.now() - 1000) });
        const stale = await seed({ issuedVersion: 7 });
        const unknown = randomBytes(32).toString('hex');
        tokens.push(unknown);

        // A fresh IP per call, so the limiter cannot be what answers.
        const ok = await POST(req(live, `ok-${randomUUID()}`));
        expect(ok.status).toBe(200);
        expect(await ok.text()).toBe('{"ok":true}');

        const bad: Array<{ status: number; body: string; headers: string }> = [];
        for (const t of [used, expired, stale, unknown]) {
            const res = await POST(req(t, `bad-${randomUUID()}`));
            bad.push({
                status: res.status,
                body: await res.text(),
                headers: JSON.stringify([...res.headers.entries()].sort()),
            });
        }
        expect(bad[0].status).toBe(410);
        expect(bad[0].body).toBe('{"error":"This reset link is invalid or has expired."}');
        for (const b of bad) expect(b).toEqual(bad[0]);

        // Verify only reads: the live token is still unused.
        const row = await prisma.passwordResetToken.findUnique({
            where: { tokenHash: hashResetToken(live) },
        });
        expect(row?.usedAt).toBeNull();
    });

    it('lets 20 verifies from one IP through and 429s the 21st', async () => {
        const live = await seed({});
        const ip = `limit-${randomUUID()}`;
        const statuses: number[] = [];
        for (let i = 0; i < 21; i++) statuses.push((await POST(req(live, ip))).status);
        expect(statuses.slice(0, 20)).toEqual(Array(20).fill(200));
        expect(statuses[20]).toBe(429);
    });

    it('never logs a token or its hash', () => {
        const out = logs.join('\n');
        expect(tokens.length).toBeGreaterThan(0);
        for (const t of tokens) {
            expect(out).not.toContain(t);
            expect(out).not.toContain(hashResetToken(t));
        }
    });
});
