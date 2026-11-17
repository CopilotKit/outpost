// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type * as NextServer from 'next/server';
import type { NextRequest as NextRequestType } from 'next/server';
import type * as RequestRoute from '@/app/api/password-reset/request/route';
import type { prisma as PrismaInstance } from '@copilotkit/outpost/db';

const url = process.env.OUTPOST_TEST_DATABASE_URL;
const requireDb = process.env.OUTPOST_REQUIRE_DB_TESTS === '1';

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
async function drainAfter() {
    while (afterQueue.length) await afterQueue.shift()!();
}

const sent: Array<{ to: string; context: { reset?: { url: string } } }> = [];
vi.mock('@copilotkit/outpost/shared/server', () => ({
    sendEmail: async (opts: { to: string; context: { reset?: { url: string } } }) => {
        sent.push(opts);
        return { success: true, method: 'smtp' };
    },
}));

// Real route, real Postgres limiter, real token service; only the mail transport is faked.
describe.skipIf(!url && !requireDb)(
    'POST /api/password-reset/request against real Postgres',
    () => {
        let POST: typeof RequestRoute.POST;
        let NextRequest: typeof NextRequestType;
        let prisma: typeof PrismaInstance;
        let memberId: string;
        let memberEmail: string;
        const logs: string[] = [];

        beforeAll(async () => {
            if (!url) {
                throw new Error(
                    'OUTPOST_REQUIRE_DB_TESTS=1 but OUTPOST_TEST_DATABASE_URL is not set',
                );
            }
            process.env.DATABASE_URL = url;
            process.env.AUTH_PROVIDER = 'credentials';
            process.env.NEXTAUTH_URL = 'http://localhost:3000';
            vi.resetModules();
            ({ POST } = await import('@/app/api/password-reset/request/route'));
            ({ NextRequest } = await import('next/server'));
            ({ prisma } = await import('@copilotkit/outpost/db'));
            memberEmail = `req-${randomUUID()}@test.local`;
            const m = await prisma.teamMember.create({
                data: { name: 'Req Test', email: memberEmail, passwordHash: 'h', status: 'ACTIVE' },
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

        function req(email: string, ip: string) {
            return new NextRequest('http://localhost:3000/api/password-reset/request', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Real-IP': ip },
                body: JSON.stringify({ email }),
            });
        }

        it('lets 10 requests from one IP through and 429s the 11th', async () => {
            const ip = `198.51.100.${Math.floor(Math.random() * 250) + 1}-${randomUUID()}`;
            const statuses: number[] = [];
            for (let i = 0; i < 11; i++) {
                // A fresh unknown email each time, so only the IP limit can trip.
                statuses.push((await POST(req(`ip-${i}-${randomUUID()}@test.local`, ip))).status);
            }
            await drainAfter();
            expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200));
            expect(statuses[10]).toBe(429);
        });

        it('answers the 4th request for one email in an hour with the same 200 and sends nothing', async () => {
            sent.length = 0;
            const bodies: string[] = [];
            for (let i = 0; i < 4; i++) {
                // A fresh IP each time, so only the email limit can trip.
                const res = await POST(req(memberEmail, `email-limit-${randomUUID()}`));
                expect(res.status).toBe(200);
                bodies.push(await res.text());
                await drainAfter();
                expect(sent).toHaveLength(Math.min(i + 1, 3));
            }
            expect(new Set(bodies)).toEqual(new Set(['{"ok":true}']));
            expect(sent.every((s) => s.to === memberEmail)).toBe(true);

            // Exactly one live token survives (one live link per member).
            const live = await prisma.passwordResetToken.count({
                where: { memberId, usedAt: null },
            });
            expect(live).toBe(1);

            // No token, hash, or URL reaches any log line.
            const out = logs.join('\n');
            for (const s of sent) {
                const token = s.context.reset!.url.split('#token=')[1];
                expect(token).toMatch(/^[0-9a-f]{64}$/);
                expect(out).not.toContain(token);
            }
            const hashes = await prisma.passwordResetToken.findMany({
                where: { memberId },
                select: { tokenHash: true },
            });
            for (const h of hashes) expect(out).not.toContain(h.tokenHash);
            expect(out).not.toContain('reset-password');
        });
    },
);
