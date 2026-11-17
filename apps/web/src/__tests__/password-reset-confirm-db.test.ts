// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { NextAuthOptions } from 'next-auth';
import type * as NextServer from 'next/server';
import type { NextRequest as NextRequestType } from 'next/server';
import type * as ConfirmRoute from '@/app/api/password-reset/confirm/route';
import type * as PasswordResetService from '@/lib/password-reset';
import type * as SharedAuth from '@copilotkit/outpost/shared';
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

const sent: Array<{ to: string; template: string; context: { reset?: { url: string } } }> = [];
vi.mock('@copilotkit/outpost/shared/server', () => ({
    sendEmail: async (opts: {
        to: string;
        template: string;
        context: { reset?: { url: string } };
    }) => {
        sent.push(opts);
        return { success: true, method: 'smtp' };
    },
}));

type JwtArgs = Parameters<NonNullable<NonNullable<NextAuthOptions['callbacks']>['jwt']>>[0];

// Real route, real Postgres limiter, real token service, real bcrypt, real jwt callback;
// only the mail transport is faked.
describe.skipIf(!url && !requireDb)(
    'POST /api/password-reset/confirm against real Postgres',
    () => {
        let POST: typeof ConfirmRoute.POST;
        let NextRequest: typeof NextRequestType;
        let svc: typeof PasswordResetService;
        let verifyPassword: typeof SharedAuth.verifyPassword;
        let authOptions: NextAuthOptions;
        let prisma: typeof PrismaInstance;
        const memberIds: string[] = [];
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
            process.env.NEXTAUTH_SECRET = 'test-secret';
            vi.resetModules();
            ({ POST } = await import('@/app/api/password-reset/confirm/route'));
            ({ NextRequest } = await import('next/server'));
            svc = await import('@/lib/password-reset');
            ({ verifyPassword } = await import('@copilotkit/outpost/shared'));
            ({ authOptions } = await import('@/lib/auth'));
            ({ prisma } = await import('@copilotkit/outpost/db'));
            for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
                vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
                    logs.push(args.map(String).join(' '));
                });
            }
        });

        afterAll(async () => {
            vi.restoreAllMocks();
            if (!prisma) return;
            if (memberIds.length) {
                await prisma.teamMember.deleteMany({ where: { id: { in: memberIds } } });
            }
            await prisma.$disconnect();
        });

        async function newMember() {
            const m = await prisma.teamMember.create({
                data: {
                    name: 'Confirm Test',
                    email: `confirm-${randomUUID()}@test.local`,
                    passwordHash: 'old-hash',
                    status: 'ACTIVE',
                },
            });
            memberIds.push(m.id);
            return m;
        }

        async function issueToken(member: { id: string; email: string; sessionVersion: number }) {
            await svc.issuePasswordReset(member, { requestedById: null });
            const last = sent[sent.length - 1];
            expect(last.template).toBe('system/password-reset');
            const token = last.context.reset!.url.split('#token=')[1];
            expect(token).toMatch(/^[0-9a-f]{64}$/);
            return token;
        }

        function req(body: unknown, ip = `confirm-${randomUUID()}`) {
            return new NextRequest('http://localhost:3000/api/password-reset/confirm', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Real-IP': ip },
                body: JSON.stringify(body),
            });
        }

        function readSession(token: Record<string, unknown>) {
            return authOptions.callbacks!.jwt!({ token } as JwtArgs);
        }

        it('refuses a weak or over-72-byte password before the token is touched', async () => {
            const m = await newMember();
            const token = await issueToken(m);
            for (const password of ['short', 'é'.repeat(37)]) {
                const res = await POST(req({ token, password, confirmPassword: password }));
                expect(res.status).toBe(400);
            }
            const row = await prisma.passwordResetToken.findFirstOrThrow({
                where: { memberId: m.id, usedAt: null },
            });
            expect(row.usedAt).toBeNull();
            const after = await prisma.teamMember.findUniqueOrThrow({ where: { id: m.id } });
            expect(after.passwordHash).toBe('old-hash');
            expect(after.sessionVersion).toBe(m.sessionVersion);
            await expect(svc.isResetTokenValid(token)).resolves.toBe(true);
        });

        it('sets the password, revokes old sessions, emails, and refuses reuse', async () => {
            const m = await newMember();
            const oldSession = { memberId: m.id, sv: m.sessionVersion, role: 'MEMBER' };
            // The old session passes the real jwt callback before the reset.
            await expect(readSession(oldSession)).resolves.toMatchObject({ memberId: m.id });

            const token = await issueToken(m);
            sent.length = 0;
            const body = { token, password: 'new-pass-123', confirmPassword: 'new-pass-123' };

            const res = await POST(req(body));
            const text = await res.text();
            expect(res.status).toBe(200);
            expect(JSON.parse(text)).toEqual({ ok: true });
            expect(text).not.toContain(token);

            const after = await prisma.teamMember.findUniqueOrThrow({ where: { id: m.id } });
            expect(after.sessionVersion).toBe(m.sessionVersion + 1);
            await expect(verifyPassword('new-pass-123', after.passwordHash!)).resolves.toBe(true);
            await expect(readSession(oldSession)).rejects.toThrow('SESSION_REVOKED');

            // The "password changed" email goes out after the response.
            expect(sent).toHaveLength(0);
            await drainAfter();
            expect(sent).toHaveLength(1);
            expect(sent[0]).toMatchObject({ to: m.email, template: 'system/password-changed' });

            // Reuse: same uniform reply as any bad link; nothing changes.
            const again = await POST(
                req({ token, password: 'other-pass-1', confirmPassword: 'other-pass-1' }),
            );
            const againText = await again.text();
            expect(again.status).toBe(410);
            expect(JSON.parse(againText)).toEqual({
                error: 'This reset link is invalid or has expired.',
            });
            expect(againText).not.toContain(token);
            const unknown = await POST(req({ ...body, token: 'f'.repeat(64) }));
            expect(unknown.status).toBe(410);
            expect(await unknown.text()).toBe(againText);
            await drainAfter();
            expect(sent).toHaveLength(1);
            const final = await prisma.teamMember.findUniqueOrThrow({ where: { id: m.id } });
            expect(final.sessionVersion).toBe(m.sessionVersion + 1);
            await expect(verifyPassword('new-pass-123', final.passwordHash!)).resolves.toBe(true);

            const out = logs.join('\n');
            expect(out).toContain(`[PASSWORD_RESET] consumed memberId=${m.id}`);
            expect(out).not.toContain(token);
            expect(out).not.toContain(svc.hashResetToken(token));
            expect(out).not.toContain('new-pass-123');
            expect(out).not.toContain('reset-password');
        });

        it('lets exactly one of two concurrent confirms with the same token succeed', async () => {
            const m = await newMember();
            const token = await issueToken(m);
            sent.length = 0;

            const responses = await Promise.all(
                ['concurrent-pass-a', 'concurrent-pass-b'].map((p) =>
                    POST(req({ token, password: p, confirmPassword: p })),
                ),
            );
            const statuses = responses.map((r) => r.status).sort();
            expect(statuses).toEqual([200, 410]);

            const after = await prisma.teamMember.findUniqueOrThrow({ where: { id: m.id } });
            expect(after.sessionVersion).toBe(m.sessionVersion + 1);
            const matches = await Promise.all(
                ['concurrent-pass-a', 'concurrent-pass-b'].map((p) =>
                    verifyPassword(p, after.passwordHash!),
                ),
            );
            expect(matches.filter(Boolean)).toHaveLength(1);

            await drainAfter();
            expect(sent.filter((s) => s.template === 'system/password-changed')).toHaveLength(1);
        });

        it('serializes concurrent confirms of two live links for one member (no deadlock 500)', async () => {
            // Two links can be live at once: issuePasswordReset only retires the older one
            // after the newer one is delivered. Seed that overlap directly, every round.
            for (let round = 0; round < 5; round++) {
                const m = await newMember();
                const tokens = [svc.generateResetToken(), svc.generateResetToken()];
                await prisma.passwordResetToken.createMany({
                    data: tokens.map((t) => ({
                        memberId: m.id,
                        tokenHash: svc.hashResetToken(t),
                        issuedVersion: m.sessionVersion,
                        expiresAt: new Date(Date.now() + svc.RESET_TTL_MS),
                    })),
                });
                sent.length = 0;

                const responses = await Promise.all(
                    tokens.map((token, i) => {
                        const p = `sibling-pass-${i}`;
                        return POST(req({ token, password: p, confirmPassword: p }));
                    }),
                );
                // A Postgres 40P01 between the two transactions surfaces here as a 500.
                expect(responses.map((r) => r.status).sort()).toEqual([200, 410]);

                const after = await prisma.teamMember.findUniqueOrThrow({ where: { id: m.id } });
                expect(after.sessionVersion).toBe(m.sessionVersion + 1);
                for (const t of tokens) await expect(svc.isResetTokenValid(t)).resolves.toBe(false);
                await drainAfter();
                expect(sent.filter((s) => s.template === 'system/password-changed')).toHaveLength(
                    1,
                );
            }
        }, 30_000);

        // Backends (other than `self`) that are waiting on a lock held or queued by `holders`.
        async function blockedBy(holders: number[], self: number[] = []): Promise<number[]> {
            const rows = await prisma.$queryRaw<Array<{ pid: number }>>`
                SELECT pid FROM pg_stat_activity
                WHERE datname = current_database()
                  AND pid <> ALL(${self}::int[])
                  AND pg_blocking_pids(pid) && ${holders}::int[]`;
            return rows.map((r) => r.pid);
        }

        async function waitForBlocked(holders: number[], self: number[] = []): Promise<number> {
            for (let i = 0; i < 400; i++) {
                const pids = await blockedBy(holders, self);
                if (pids.length) return pids[0];
                await new Promise((r) => setTimeout(r, 10));
            }
            throw new Error(`no backend blocked by ${holders.join(',')} within 4s`);
        }

        it('does not deadlock a confirm against the cleanup of a newer delivered link', async () => {
            // The member has two older live links, A and B. A third connection holds A's row
            // lock so the interleaving is deterministic: the issue cleanup queues on A first,
            // then a confirm of B starts. When A is released, a cleanup that does not take
            // the member row first deletes A, waits on B (claimed by the confirm), while the
            // confirm's sibling sweep waits on A: Postgres 40P01, a 500 for the user.
            for (let round = 0; round < 10; round++) {
                const m = await newMember();
                const [a, b] = [svc.generateResetToken(), svc.generateResetToken()];
                const older = new Date(Date.now() - 60_000);
                const rowA = await prisma.passwordResetToken.create({
                    data: {
                        memberId: m.id,
                        tokenHash: svc.hashResetToken(a),
                        issuedVersion: m.sessionVersion,
                        expiresAt: new Date(Date.now() + svc.RESET_TTL_MS),
                        createdAt: older,
                    },
                });
                await prisma.passwordResetToken.create({
                    data: {
                        memberId: m.id,
                        tokenHash: svc.hashResetToken(b),
                        issuedVersion: m.sessionVersion,
                        expiresAt: new Date(Date.now() + svc.RESET_TTL_MS),
                        createdAt: older,
                    },
                });
                sent.length = 0;
                logs.length = 0;

                let release!: () => void;
                const released = new Promise<void>((r) => (release = r));
                let holderPid!: number;
                let locked!: () => void;
                const isLocked = new Promise<void>((r) => (locked = r));
                const holder = prisma.$transaction(
                    async (tx) => {
                        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`
                            SELECT pg_backend_pid() AS pid`;
                        holderPid = pid;
                        await tx.$queryRaw`
                            SELECT "id" FROM "PasswordResetToken" WHERE "id" = ${rowA.id} FOR UPDATE`;
                        locked();
                        await released;
                    },
                    { timeout: 20_000 },
                );
                await isLocked;

                try {
                    const issue = svc.issuePasswordReset(m, { requestedById: null });
                    const issuePid = await waitForBlocked([holderPid]);
                    const p = 'interleave-pass-1';
                    const confirm = POST(req({ token: b, password: p, confirmPassword: p }));
                    await waitForBlocked([holderPid, issuePid], [issuePid]);
                    release();
                    await holder;

                    const [issued, res] = await Promise.all([issue, confirm]);
                    // A 40P01 on the confirm side is a 500. The cleanup held the member row
                    // first, so B was superseded before the confirm could claim it: the
                    // uniform invalid-link reply, and nothing changed.
                    expect(res.status).toBe(410);
                    // A 40P01 on the issue side is a cleanup failure that leaves A and B live.
                    const out = logs.join('\n');
                    expect(out).not.toContain('deadlock');
                    expect(out).not.toContain('token cleanup failed');
                    expect(issued).toEqual({ emailSent: true });
                } finally {
                    release();
                    await holder.catch(() => {});
                }

                const live = await prisma.passwordResetToken.findMany({
                    where: { memberId: m.id, usedAt: null },
                });
                expect(live).toHaveLength(1);
                const c = sent[sent.length - 1].context.reset!.url.split('#token=')[1];
                expect(live[0].tokenHash).toBe(svc.hashResetToken(c));
                await expect(svc.isResetTokenValid(c)).resolves.toBe(true);
                const after = await prisma.teamMember.findUniqueOrThrow({ where: { id: m.id } });
                expect(after.sessionVersion).toBe(m.sessionVersion);
                expect(after.passwordHash).toBe('old-hash');
            }
        }, 60_000);
    },
);
