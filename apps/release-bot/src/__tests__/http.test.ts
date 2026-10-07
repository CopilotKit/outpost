import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_RETRY_WAIT_MS, backoff, parseJson, retryAfterMs } from '../http.js';

/** A response carrying only headers, which is all retryAfterMs reads. */
const headed = (headers: Record<string, string>) => new Response('body', { headers });

describe('retryAfterMs', () => {
    // Two tests here freeze time. Restored centrally, because an inline
    // useRealTimers() is skipped when the assertion above it throws, and every
    // later test in the file then runs against a frozen clock.
    afterEach(() => vi.useRealTimers());

    it('honours retry-after in seconds, with a grace period', () => {
        // Honoured to the exact millisecond, a `retry-after: 1` retried at
        // t+1000ms trips the same limit again.
        expect(retryAfterMs(headed({ 'retry-after': '2' }))).toBe(2100);
    });

    it('ignores a negative retry-after rather than retrying immediately', () => {
        // A negative delay makes pause() fire on the next tick, turning the
        // backoff into an immediate hammer at the provider.
        expect(retryAfterMs(headed({ 'retry-after': '-5' }))).toBeUndefined();
        expect(retryAfterMs(headed({ 'retry-after': '0' }))).toBeUndefined();
    });

    it('ignores the HTTP-date form, which Number() reads as NaN', () => {
        expect(retryAfterMs(headed({ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }))).toBe(
            undefined,
        );
    });

    it('reads x-ratelimit-reset when there is no retry-after', () => {
        // GitHub sends no retry-after on a primary rate limit. Without this the
        // run burns every attempt in three seconds against a limit that resets
        // minutes later.
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
        const reset = Math.floor(Date.parse('2026-09-20T00:00:30Z') / 1000);
        expect(
            retryAfterMs(headed({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': `${reset}` })),
        ).toBe(30_100);
        vi.useRealTimers();
    });

    it('ignores x-ratelimit-reset when the budget is not actually exhausted', () => {
        const reset = Math.floor(Date.now() / 1000) + 30;
        expect(
            retryAfterMs(headed({ 'x-ratelimit-remaining': '7', 'x-ratelimit-reset': `${reset}` })),
        ).toBeUndefined();
    });

    it('ignores a reset that has already passed', () => {
        const reset = Math.floor(Date.now() / 1000) - 30;
        expect(
            retryAfterMs(headed({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': `${reset}` })),
        ).toBeUndefined();
    });

    it('caps a very long retry-after so one limit cannot park the whole run', () => {
        expect(retryAfterMs(headed({ 'retry-after': '86400' }))).toBe(MAX_RETRY_WAIT_MS);
    });

    it('caps a long x-ratelimit-reset too, which is the branch that can park an hour', () => {
        // The cap was only ever exercised on the retry-after branch, and that is
        // the secondary abuse limit, which is short. GitHub's primary limit sends
        // no retry-after at all and resets at the top of the hour, so this branch
        // routinely reads up to 3600s - three times RUN_BUDGET_MS in one pause().
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
        const reset = Math.floor(Date.parse('2026-09-20T01:00:00Z') / 1000);
        expect(
            retryAfterMs(headed({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': `${reset}` })),
        ).toBe(MAX_RETRY_WAIT_MS);
    });

    it('returns undefined when the response says nothing about waiting', () => {
        expect(retryAfterMs(headed({}))).toBeUndefined();
    });

    it('releases the connection on every path', async () => {
        // Under undici an unread body holds its connection out of the pool until
        // garbage collection.
        const res = headed({ 'retry-after': '1' });
        retryAfterMs(res);
        await Promise.resolve();
        expect(res.bodyUsed || res.body === null || res.body?.locked).toBeTruthy();
    });
});

describe('backoff', () => {
    it('doubles per attempt', () => {
        expect(backoff(1)).toBe(1000);
        expect(backoff(2)).toBe(2000);
        expect(backoff(3)).toBe(4000);
    });

    it('is capped, so raising MAX_ATTEMPTS cannot park the run for an hour', () => {
        expect(backoff(20)).toBe(MAX_RETRY_WAIT_MS);
    });
});

describe('parseJson', () => {
    it('parses a JSON body', async () => {
        await expect(parseJson(Response.json({ id: 'x' }), 'Discord')).resolves.toEqual({
            id: 'x',
        });
    });

    it('names the service and quotes the body when it is not JSON', async () => {
        // An HTML error page parsed as JSON threw "Unexpected token '<'" with
        // nothing to say which service produced it.
        await expect(
            parseJson(new Response('<html>502 Bad Gateway</html>'), 'GitHub'),
        ).rejects.toThrow(/GitHub returned a non-JSON body: <html>502/);
    });
});
