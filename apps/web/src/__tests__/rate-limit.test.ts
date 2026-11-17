import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockQueryRaw = vi.fn();
const mockExecuteRaw = vi.fn();
vi.mock('@copilotkit/outpost/db', () => ({
    prisma: {
        $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
        $executeRaw: (...args: unknown[]) => mockExecuteRaw(...args),
    },
}));

import { hit } from '@/lib/rate-limit';
import { clientIp } from '@/lib/client-ip';

/** Values interpolated into a tagged-template $queryRaw call (after the strings array). */
function values(call: unknown[]): unknown[] {
    return call.slice(1);
}

describe('hit()', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-28T21:07:30.000Z'));
        mockQueryRaw.mockReset();
        mockExecuteRaw.mockReset();
        mockExecuteRaw.mockResolvedValue(0);
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('buckets by epoch window and passes key and windowStart as parameters', async () => {
        mockQueryRaw.mockResolvedValue([{ count: 1 }]);

        await hit('pwreset:req:ip:1.2.3.4', 10, 900);

        const [key, windowStart] = values(mockQueryRaw.mock.calls[0]);
        expect(key).toBe('pwreset:req:ip:1.2.3.4');
        expect((windowStart as Date).toISOString()).toBe('2026-10-28T21:00:00.000Z');
        const sql = (mockQueryRaw.mock.calls[0][0] as string[]).join('?');
        expect(sql).toContain('ON CONFLICT ("key", "windowStart") DO UPDATE');
        expect(sql).toContain('RETURNING "count"');
    });

    it('allows up to the limit and refuses after it', async () => {
        mockQueryRaw.mockResolvedValueOnce([{ count: 10 }]).mockResolvedValueOnce([{ count: 11 }]);
        await expect(hit('k', 10, 900)).resolves.toEqual({ allowed: true });
        await expect(hit('k', 10, 900)).resolves.toEqual({ allowed: false });
    });

    it('rethrows a database error (does not fail open)', async () => {
        mockQueryRaw.mockRejectedValue(new Error('db down'));
        await expect(hit('k', 10, 900)).rejects.toThrow('db down');
    });

    it('cleans up rows older than a day on about 1 in 50 calls', async () => {
        mockQueryRaw.mockResolvedValue([{ count: 1 }]);
        await hit('k', 10, 900);
        expect(mockExecuteRaw).not.toHaveBeenCalled();

        vi.spyOn(Math, 'random').mockReturnValue(0.01);
        await hit('k', 10, 900);
        expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
        const [cutoff] = values(mockExecuteRaw.mock.calls[0]);
        expect((cutoff as Date).toISOString()).toBe('2026-10-27T21:07:30.000Z');
    });
});

describe('clientIp()', () => {
    it('reads X-Real-IP', () => {
        expect(
            clientIp(new Request('http://x', { headers: { 'X-Real-IP': ' 203.0.113.9 ' } })),
        ).toBe('203.0.113.9');
    });

    it('ignores X-Forwarded-For and falls back to "unknown"', () => {
        expect(
            clientIp(
                new Request('http://x', { headers: { 'X-Forwarded-For': '1.1.1.1, 2.2.2.2' } }),
            ),
        ).toBe('unknown');
    });
});
