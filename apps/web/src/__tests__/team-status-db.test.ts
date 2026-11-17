// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import type { NextAuthOptions } from 'next-auth';
import type * as TeamMemberRoute from '@/app/api/team/[id]/route';
import type * as AcceptRoute from '@/app/api/team/invite/accept/route';
import type { prisma as PrismaInstance } from '@copilotkit/outpost/db';

// Only the admin session is stubbed. The PATCH and invite-accept handlers, the
// credentials authorize(), Prisma, Postgres and bcrypt are all real.
const caller = vi.hoisted(() => ({ memberId: 'status-db-admin' }));
vi.mock('@/lib/require-admin', () => ({
    requireAdmin: async () => ({
        error: null,
        session: { user: { id: caller.memberId, role: 'ADMIN', memberId: caller.memberId } },
    }),
}));

type AuthorizeFn = (credentials: Record<string, string>, req: unknown) => Promise<unknown>;

const url = process.env.OUTPOST_TEST_DATABASE_URL;
const requireDb = process.env.OUTPOST_REQUIRE_DB_TESTS === '1';

describe.skipIf(!url && !requireDb)('PATCH /api/team/[id] status against real Postgres', () => {
    let realPATCH: typeof TeamMemberRoute.PATCH;
    let realAccept: typeof AcceptRoute.POST;
    let prisma: typeof PrismaInstance;
    let authorize: AuthorizeFn;
    let hashPassword: (plain: string) => Promise<string>;
    const memberIds: string[] = [];

    beforeAll(async () => {
        if (!url) {
            throw new Error('OUTPOST_REQUIRE_DB_TESTS=1 but OUTPOST_TEST_DATABASE_URL is not set');
        }
        process.env.DATABASE_URL = url;
        process.env.AUTH_PROVIDER = 'credentials';
        vi.resetModules();
        ({ PATCH: realPATCH } = await import('@/app/api/team/[id]/route'));
        ({ POST: realAccept } = await import('@/app/api/team/invite/accept/route'));
        ({ prisma } = await import('@copilotkit/outpost/db'));
        ({ hashPassword } = await import('@copilotkit/outpost/shared'));
        const { authOptions }: { authOptions: NextAuthOptions } = await import('@/lib/auth');
        // next-auth v4 keeps the user-supplied authorize under `options`.
        authorize = (authOptions.providers[0] as unknown as { options: { authorize: AuthorizeFn } })
            .options.authorize;
    });

    afterEach(() => {
        caller.memberId = 'status-db-admin';
    });

    afterAll(async () => {
        if (!prisma) return;
        if (memberIds.length) {
            await prisma.teamMember.deleteMany({ where: { id: { in: memberIds } } });
        }
        await prisma.$disconnect();
    });

    async function seedNeverJoined(status: 'INVITED' | 'DISABLED') {
        const member = await prisma.teamMember.create({
            data: {
                name: 'Pending',
                email: `status-${randomUUID()}@example.test`,
                status,
                invitedAt: new Date(),
            },
        });
        memberIds.push(member.id);
        const token = `invite-${randomUUID()}`;
        await prisma.inviteToken.create({
            data: { memberId: member.id, token, expiresAt: new Date(Date.now() + 3_600_000) },
        });
        return { member, token };
    }

    async function seedJoined() {
        const member = await prisma.teamMember.create({
            data: {
                name: 'Joined',
                email: `status-${randomUUID()}@example.test`,
                status: 'ACTIVE',
                invitedAt: new Date(),
                joinedAt: new Date(),
                passwordHash: 'existing-hash',
            },
        });
        memberIds.push(member.id);
        return member;
    }

    const PASSWORD = 'correct-horse-battery';
    // Real bcrypt at cost 12, one hash plus several verifies per test: past the 5s
    // default on a loaded machine.
    const BCRYPT_TIMEOUT_MS = 30_000;

    /**
     * The row scripts/create-admin.ts and packages/outpost/db/src/seed.ts write: a
     * password and the default ACTIVE status, but no joinedAt.
     */
    async function seedPasswordWithoutJoinedAt() {
        const member = await prisma.teamMember.create({
            data: {
                name: 'Created Admin',
                email: `status-${randomUUID()}@example.test`,
                passwordHash: await hashPassword(PASSWORD),
                role: 'ADMIN',
            },
        });
        memberIds.push(member.id);
        expect(member.status).toBe('ACTIVE');
        expect(member.joinedAt).toBeNull();
        return member;
    }

    function signIn(email: string) {
        return authorize({ email, password: PASSWORD }, {});
    }

    function patch(id: string, body: Record<string, unknown>) {
        return realPATCH(
            new Request(`http://localhost:3000/api/team/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            }),
            { params: Promise.resolve({ id }) },
        );
    }

    function accept(token: string) {
        return realAccept(
            new Request('http://localhost:3000/api/team/invite/accept', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    token,
                    name: 'Accepted',
                    password: 'correct-horse-battery',
                    confirmPassword: 'correct-horse-battery',
                }),
            }),
        );
    }

    for (const start of ['INVITED', 'DISABLED'] as const) {
        it(`enabling a never-joined ${start} member restores INVITED, and the invite still works`, async () => {
            const { member, token } = await seedNeverJoined(start);

            const res = await patch(member.id, { status: 'ACTIVE' });

            expect(res.status).toBe(200);
            expect((await res.json()).status).toBe('INVITED');
            const enabled = await prisma.teamMember.findUniqueOrThrow({ where: { id: member.id } });
            expect(enabled.status).toBe('INVITED');
            expect(enabled.passwordHash).toBeNull();
            expect(enabled.joinedAt).toBeNull();

            const accepted = await accept(token);

            expect(accepted.status).toBe(200);
            const after = await prisma.teamMember.findUniqueOrThrow({ where: { id: member.id } });
            expect(after.status).toBe('ACTIVE');
            expect(after.passwordHash).not.toBeNull();
            expect(after.joinedAt).not.toBeNull();
            const invite = await prisma.inviteToken.findUniqueOrThrow({ where: { token } });
            expect(invite.usedAt).not.toBeNull();
        });
    }

    it('disables and re-enables a joined member as ACTIVE; only disabling bumps sessionVersion', async () => {
        const member = await seedJoined();

        const disabled = await patch(member.id, { status: 'DISABLED' });

        expect(disabled.status).toBe(200);
        const afterDisable = await prisma.teamMember.findUniqueOrThrow({
            where: { id: member.id },
        });
        expect(afterDisable.status).toBe('DISABLED');
        expect(afterDisable.sessionVersion).toBe(member.sessionVersion + 1);

        const enabled = await patch(member.id, { status: 'ACTIVE' });

        expect(enabled.status).toBe(200);
        expect((await enabled.json()).status).toBe('ACTIVE');
        const afterEnable = await prisma.teamMember.findUniqueOrThrow({ where: { id: member.id } });
        expect(afterEnable.status).toBe('ACTIVE');
        expect(afterEnable.sessionVersion).toBe(member.sessionVersion + 1);
        expect(afterEnable.passwordHash).toBe('existing-hash');
    });

    it(
        're-enables a member with a password but no joinedAt as ACTIVE, and they can sign in',
        async () => {
            const member = await seedPasswordWithoutJoinedAt();
            expect(await signIn(member.email)).toMatchObject({ id: member.id });

            const disabled = await patch(member.id, { status: 'DISABLED' });

            expect(disabled.status).toBe(200);
            expect(await signIn(member.email)).toBeNull();

            const enabled = await patch(member.id, { status: 'ACTIVE' });

            expect(enabled.status).toBe(200);
            expect((await enabled.json()).status).toBe('ACTIVE');
            const after = await prisma.teamMember.findUniqueOrThrow({ where: { id: member.id } });
            expect(after.status).toBe('ACTIVE');
            expect(after.passwordHash).toBe(member.passwordHash);
            expect(await signIn(member.email)).toMatchObject({ id: member.id });
        },
        BCRYPT_TIMEOUT_MS,
    );

    it(
        'an admin with a password but no joinedAt who PATCHes their own status to ACTIVE stays ACTIVE',
        async () => {
            const admin = await seedPasswordWithoutJoinedAt();
            caller.memberId = admin.id;

            const res = await patch(admin.id, { status: 'ACTIVE' });

            expect(res.status).toBe(200);
            expect((await res.json()).status).toBe('ACTIVE');
            const after = await prisma.teamMember.findUniqueOrThrow({ where: { id: admin.id } });
            expect(after.status).toBe('ACTIVE');
            expect(await signIn(admin.email)).toMatchObject({ id: admin.id });
        },
        BCRYPT_TIMEOUT_MS,
    );
});
