// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type * as PasswordResetService from '@/lib/password-reset';
import type { prisma as PrismaInstance } from '@copilotkit/outpost/db';

const url = process.env.OUTPOST_TEST_DATABASE_URL;
const mockSent: Array<{ context: { reset?: { url: string } } }> = [];
// What the next send does after it records its options. Every test sets it back to 'ok'.
let sendOutcome: 'ok' | 'fail' | 'throw' = 'ok';
// When set, every send waits for it after recording its options.
let sendGate: Promise<void> | null = null;

vi.mock('@copilotkit/outpost/shared/server', () => ({
    sendEmail: async (opts: { context: { reset?: { url: string } } }) => {
        mockSent.push(opts);
        if (sendGate) await sendGate;
        if (sendOutcome === 'throw') throw new Error('smtp connection refused');
        if (sendOutcome === 'fail') return { success: false, error: 'rejected', method: 'smtp' };
        return { success: true, method: 'smtp' };
    },
}));

// CI runs this file in its Test step with OUTPOST_REQUIRE_DB_TESTS=1. With that flag set, a
// missing OUTPOST_TEST_DATABASE_URL fails the file in beforeAll instead of skipping it.
const requireDb = process.env.OUTPOST_REQUIRE_DB_TESTS === '1';

describe.skipIf(!url && !requireDb)('password reset against real Postgres', () => {
    let svc: typeof PasswordResetService;
    let prisma: typeof PrismaInstance;
    let memberId: string;

    beforeAll(async () => {
        if (!url) {
            throw new Error('OUTPOST_REQUIRE_DB_TESTS=1 but OUTPOST_TEST_DATABASE_URL is not set');
        }
        process.env.DATABASE_URL = url;
        process.env.NEXTAUTH_URL = 'http://localhost:3000';
        vi.resetModules();
        svc = await import('@/lib/password-reset');
        ({ prisma } = await import('@copilotkit/outpost/db'));
        const m = await prisma.teamMember.create({
            data: {
                name: 'DB Test',
                email: `db-${randomUUID()}@test.local`,
                passwordHash: 'old',
                status: 'ACTIVE',
            },
        });
        memberId = m.id;
    });

    afterAll(async () => {
        if (!prisma) return; // beforeAll failed before connecting (missing URL)
        if (memberId) await prisma.teamMember.delete({ where: { id: memberId } });
        await prisma.$disconnect();
    });

    function lastToken(): string {
        return mockSent[mockSent.length - 1].context.reset!.url.split('#token=')[1];
    }

    it('keeps only the latest link live', async () => {
        const m = await prisma.teamMember.findUniqueOrThrow({ where: { id: memberId } });
        await svc.issuePasswordReset(m, { requestedById: null });
        const first = lastToken();
        await svc.issuePasswordReset(m, { requestedById: null });
        const second = lastToken();

        await expect(svc.isResetTokenValid(first)).resolves.toBe(false);
        await expect(svc.isResetTokenValid(second)).resolves.toBe(true);
    });

    it('keeps exactly one live link when two delivered issues share a createdAt', async () => {
        const m = await prisma.teamMember.findUniqueOrThrow({ where: { id: memberId } });
        // createdAt has millisecond precision, so two overlapping issues can get the same
        // value. Force that tie at insert time, for this member only, so the value each
        // issue gets back from its create is the tied one.
        // Only our own values are interpolated: a cuid and an ISO timestamp.
        const fn = `test_tie_${memberId}`;
        const tie = new Date(Date.now() + 1000).toISOString();
        await prisma.$executeRawUnsafe(
            `CREATE FUNCTION "${fn}"() RETURNS trigger AS $$ BEGIN
                NEW."createdAt" := TIMESTAMPTZ '${tie}' AT TIME ZONE 'UTC'; RETURN NEW;
             END $$ LANGUAGE plpgsql`,
        );
        await prisma.$executeRawUnsafe(
            `CREATE TRIGGER "${fn}" BEFORE INSERT ON "PasswordResetToken" FOR EACH ROW
             WHEN (NEW."memberId" = '${memberId}') EXECUTE FUNCTION "${fn}"()`,
        );
        // Hold both sends so both rows exist before either cleanup runs.
        let release!: () => void;
        sendGate = new Promise<void>((r) => (release = r));
        const before = mockSent.length;
        try {
            const issues = [
                svc.issuePasswordReset(m, { requestedById: null }),
                svc.issuePasswordReset(m, { requestedById: null }),
            ];
            for (let i = 0; i < 400 && mockSent.length < before + 2; i++) {
                await new Promise((r) => setTimeout(r, 10));
            }
            expect(mockSent).toHaveLength(before + 2);
            const rows = await prisma.passwordResetToken.findMany({
                where: { memberId, createdAt: new Date(tie) },
            });
            expect(rows).toHaveLength(2);
            const tokens = mockSent.slice(-2).map((s) => s.context.reset!.url.split('#token=')[1]);
            release();
            await expect(Promise.all(issues)).resolves.toEqual([
                { emailSent: true },
                { emailSent: true },
            ]);

            const live = await prisma.passwordResetToken.findMany({
                where: { memberId, usedAt: null },
            });
            expect(live).toHaveLength(1);
            const valid = await Promise.all(tokens.map((t) => svc.isResetTokenValid(t)));
            expect(valid.filter(Boolean)).toHaveLength(1);
        } finally {
            sendGate = null;
            release();
            await prisma.$executeRawUnsafe(
                `DROP TRIGGER IF EXISTS "${fn}" ON "PasswordResetToken"`,
            );
            await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${fn}"()`);
        }
    });

    for (const outcome of ['fail', 'throw'] as const) {
        it(`keeps the previous link live when the next send ${outcome}s`, async () => {
            const m = await prisma.teamMember.findUniqueOrThrow({ where: { id: memberId } });
            await svc.issuePasswordReset(m, { requestedById: null });
            const delivered = lastToken();

            sendOutcome = outcome;
            try {
                await expect(svc.issuePasswordReset(m, { requestedById: null })).resolves.toEqual({
                    emailSent: false,
                });
            } finally {
                sendOutcome = 'ok';
            }
            const undelivered = lastToken();

            await expect(svc.isResetTokenValid(delivered)).resolves.toBe(true);
            await expect(svc.isResetTokenValid(undelivered)).resolves.toBe(false);
            await expect(
                prisma.passwordResetToken.count({
                    where: { tokenHash: svc.hashResetToken(undelivered) },
                }),
            ).resolves.toBe(0);
        });
    }

    it('lets exactly one of two concurrent confirms succeed', async () => {
        const m = await prisma.teamMember.findUniqueOrThrow({ where: { id: memberId } });
        await svc.issuePasswordReset(m, { requestedById: null });
        const token = lastToken();

        const results = await Promise.all([
            svc.consumePasswordReset(token, 'hash-a'),
            svc.consumePasswordReset(token, 'hash-b'),
        ]);

        expect(results.filter((r) => r.ok)).toHaveLength(1);
        const after = await prisma.teamMember.findUniqueOrThrow({ where: { id: memberId } });
        expect(after.sessionVersion).toBe(m.sessionVersion + 1);
        expect(['hash-a', 'hash-b']).toContain(after.passwordHash);
        await expect(svc.isResetTokenValid(token)).resolves.toBe(false);
    });

    it('kills an outstanding link when the password changes another way', async () => {
        const m = await prisma.teamMember.findUniqueOrThrow({ where: { id: memberId } });
        await svc.issuePasswordReset(m, { requestedById: null });
        const token = lastToken();
        await prisma.teamMember.update({
            where: { id: memberId },
            data: { sessionVersion: { increment: 1 } },
        });

        await expect(svc.isResetTokenValid(token)).resolves.toBe(false);
        await expect(svc.consumePasswordReset(token, 'hash-c')).resolves.toEqual({ ok: false });
    });
});
