// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type * as RateLimit from '@/lib/rate-limit';
import type * as OutpostDb from '@copilotkit/outpost/db';

const url = process.env.OUTPOST_TEST_DATABASE_URL;
// CI sets OUTPOST_REQUIRE_DB_TESTS=1: then a missing URL fails this file instead of
// skipping it. If turbo's env passthrough drops both variables, the file still skips;
// CI's "Verify the real-Postgres tests ran" step catches that by failing unless every
// test in each *-db file passed in its JSON report.
const requireDb = process.env.OUTPOST_REQUIRE_DB_TESTS === '1';

describe.skipIf(!url && !requireDb)('hit() against real Postgres', () => {
    let hit: typeof RateLimit.hit;
    let prisma: typeof OutpostDb.prisma;

    beforeAll(async () => {
        if (!url) {
            throw new Error('OUTPOST_REQUIRE_DB_TESTS=1 but OUTPOST_TEST_DATABASE_URL is not set');
        }
        process.env.DATABASE_URL = url;
        vi.resetModules();
        ({ hit } = await import('@/lib/rate-limit'));
        ({ prisma } = await import('@copilotkit/outpost/db'));
    });

    afterAll(async () => {
        await prisma?.$disconnect();
    });

    it('counts 25 concurrent hits exactly and allows exactly the limit', async () => {
        const key = `test:${randomUUID()}`;
        const results = await Promise.all(Array.from({ length: 25 }, () => hit(key, 10, 900)));

        expect(results.filter((r) => r.allowed)).toHaveLength(10);
        const rows = await prisma.$queryRaw<Array<{ count: number }>>`
            SELECT "count" FROM "AuthRateLimit" WHERE "key" = ${key}`;
        expect(rows).toHaveLength(1);
        expect(rows[0].count).toBe(25);

        await prisma.$executeRaw`DELETE FROM "AuthRateLimit" WHERE "key" = ${key}`;
    });
});
