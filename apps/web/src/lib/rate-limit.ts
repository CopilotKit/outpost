import { prisma } from '@copilotkit/outpost/db';

const CLEANUP_PROBABILITY = 1 / 50;
const RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Fixed-window counter in Postgres, the only store shared across replicas and
 * deploys. One atomic upsert per call. A database error is rethrown so the caller
 * returns 500: the limiter never fails open.
 */
export async function hit(
    key: string,
    limit: number,
    windowSec: number,
): Promise<{ allowed: boolean }> {
    const nowMs = Date.now();
    const windowMs = windowSec * 1000;
    // Epoch-aligned, so every replica computes the same bucket.
    const windowStart = new Date(Math.floor(nowMs / windowMs) * windowMs);

    const rows = await prisma.$queryRaw<Array<{ count: number }>>`
        INSERT INTO "AuthRateLimit" ("key", "windowStart", "count")
        VALUES (${key}, ${windowStart}, 1)
        ON CONFLICT ("key", "windowStart") DO UPDATE SET "count" = "AuthRateLimit"."count" + 1
        RETURNING "count"`;

    if (Math.random() < CLEANUP_PROBABILITY) {
        const cutoff = new Date(nowMs - RETENTION_MS);
        prisma.$executeRaw`DELETE FROM "AuthRateLimit" WHERE "windowStart" < ${cutoff}`.catch(
            (err: unknown) => {
                console.error(
                    `[RATE_LIMIT] cleanup failed error=${err instanceof Error ? err.message : String(err)}`,
                );
            },
        );
    }

    return { allowed: Number(rows[0].count) <= limit };
}
