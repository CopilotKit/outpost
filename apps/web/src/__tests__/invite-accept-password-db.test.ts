// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type * as AcceptRoute from '@/app/api/team/invite/accept/route';
import type { prisma as PrismaInstance } from '@copilotkit/outpost/db';

const url = process.env.OUTPOST_TEST_DATABASE_URL;
const requireDb = process.env.OUTPOST_REQUIRE_DB_TESTS === '1';

// Real route, real Postgres, real bcrypt; nothing is mocked.
describe.skipIf(!url && !requireDb)('POST /api/team/invite/accept against real Postgres', () => {
    let realPOST: typeof AcceptRoute.POST;
    let realGET: typeof AcceptRoute.GET;
    let prisma: typeof PrismaInstance;
    const memberIds: string[] = [];

    beforeAll(async () => {
        if (!url) {
            throw new Error('OUTPOST_REQUIRE_DB_TESTS=1 but OUTPOST_TEST_DATABASE_URL is not set');
        }
        process.env.DATABASE_URL = url;
        vi.resetModules();
        ({ POST: realPOST, GET: realGET } = await import('@/app/api/team/invite/accept/route'));
        ({ prisma } = await import('@copilotkit/outpost/db'));
    });

    afterAll(async () => {
        if (!prisma) return;
        if (memberIds.length) {
            await prisma.teamMember.deleteMany({ where: { id: { in: memberIds } } });
        }
        await prisma.$disconnect();
    });

    async function seed(status: 'INVITED' | 'DISABLED') {
        const member = await prisma.teamMember.create({
            data: {
                name: 'Pending',
                email: `invitee-${randomUUID()}@example.test`,
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

    function accept(token: string) {
        return realPOST(
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

    it('refuses a DISABLED invitee and writes no password, status, or token use', async () => {
        const { member, token } = await seed('DISABLED');

        const res = await accept(token);

        expect(res.status).toBe(410);
        expect((await res.json()).error).toBe('This invite is no longer valid');
        const after = await prisma.teamMember.findUniqueOrThrow({ where: { id: member.id } });
        expect(after.status).toBe('DISABLED');
        expect(after.passwordHash).toBeNull();
        expect(after.joinedAt).toBeNull();
        expect(after.name).toBe('Pending');
        const invite = await prisma.inviteToken.findUniqueOrThrow({ where: { token } });
        expect(invite.usedAt).toBeNull();
    });

    it('refuses when the member is disabled after the invite is read (conditional update)', async () => {
        const { member, token } = await seed('INVITED');
        const realFind = prisma.inviteToken.findUnique.bind(prisma.inviteToken);
        // Return the INVITED snapshot, then disable the member before the route writes.
        const spy = vi.spyOn(prisma.inviteToken, 'findUnique').mockImplementationOnce((async (
            args: Parameters<typeof realFind>[0],
        ) => {
            const snapshot = await realFind(args);
            await prisma.teamMember.update({
                where: { id: member.id },
                data: { status: 'DISABLED' },
            });
            return snapshot;
        }) as unknown as typeof prisma.inviteToken.findUnique);

        let res: Response;
        try {
            res = await accept(token);
        } finally {
            spy.mockRestore();
        }

        expect(res.status).toBe(410);
        const after = await prisma.teamMember.findUniqueOrThrow({ where: { id: member.id } });
        expect(after.status).toBe('DISABLED');
        expect(after.passwordHash).toBeNull();
        const invite = await prisma.inviteToken.findUniqueOrThrow({ where: { token } });
        expect(invite.usedAt).toBeNull();
    });

    it('GET refuses to show the invite form to a DISABLED invitee', async () => {
        const { token } = await seed('DISABLED');

        const res = await realGET(
            new Request(`http://localhost:3000/api/team/invite/accept?token=${token}`),
        );

        expect(res.status).toBe(410);
        expect((await res.json()).error).toBe('This invite is no longer valid');
    });

    it('still activates an INVITED invitee', async () => {
        const { member, token } = await seed('INVITED');

        const res = await accept(token);

        expect(res.status).toBe(200);
        const after = await prisma.teamMember.findUniqueOrThrow({ where: { id: member.id } });
        expect(after.status).toBe('ACTIVE');
        expect(after.passwordHash).not.toBeNull();
        const invite = await prisma.inviteToken.findUniqueOrThrow({ where: { token } });
        expect(invite.usedAt).not.toBeNull();
    });
});
