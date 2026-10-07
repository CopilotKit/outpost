import { describe, expect, it } from 'vitest';
import { pending, type Item } from '../watermark.js';
import type { Announced } from '../discord.js';

const item = (n: number, publishedAt: string): Item => ({ url: `https://x/${n}`, publishedAt });

const seen = (urls: string[], foundOwn = true, searchedFrom?: string): Announced => ({
    urls: new Set(urls),
    foundOwn,
    searchedFrom,
});

describe('pending', () => {
    it('drains a backlog oldest-first so nothing is skipped past', () => {
        const items = [
            item(1, '2026-09-01T00:00:00Z'),
            item(2, '2026-09-02T00:00:00Z'),
            item(3, '2026-09-03T00:00:00Z'),
            item(4, '2026-09-04T00:00:00Z'),
            item(5, '2026-09-05T00:00:00Z'),
        ];

        // Announced item 1; items 2..5 are pending, oldest first, so a caller
        // taking the first N walks forward one step at a time.
        const first = pending(items, seen(['https://x/1']));
        expect(first.map((i) => i.url)).toEqual([
            'https://x/2',
            'https://x/3',
            'https://x/4',
            'https://x/5',
        ]);

        // Next run continues from there rather than jumping to the newest and
        // abandoning the middle.
        const second = pending(items, seen(['https://x/1', 'https://x/2', 'https://x/3']));
        expect(second.map((i) => i.url)).toEqual(['https://x/4', 'https://x/5']);
    });

    it('announces nothing when the newest item is already announced', () => {
        const items = [item(1, '2026-09-01T00:00:00Z'), item(2, '2026-09-02T00:00:00Z')];
        expect(pending(items, seen(['https://x/1', 'https://x/2']))).toEqual([]);
    });

    it('announces only the newest item when the bot has never posted here', () => {
        const items = [
            item(1, '2026-09-01T00:00:00Z'),
            item(2, '2026-09-02T00:00:00Z'),
            item(3, '2026-09-03T00:00:00Z'),
        ];
        expect(pending(items, seen([], false)).map((i) => i.url)).toEqual(['https://x/3']);
    });

    it('announces only what postdates the history it could read', () => {
        // The bot has posted here, but nothing it announced is in range any
        // more. Anything published after the oldest message read would have been
        // visible if announced, so only those are pending; older ones are done.
        const items = [item(1, '2026-09-01T00:00:00Z'), item(2, '2026-09-20T00:00:00Z')];
        const result = pending(items, seen(['https://x/older'], true, '2026-09-10T00:00:00Z'));
        expect(result.map((i) => i.url)).toEqual(['https://x/2']);
    });

    it('falls back to the newest item when the history gives no floor', () => {
        const items = [item(1, '2026-09-01T00:00:00Z'), item(2, '2026-09-02T00:00:00Z')];
        expect(pending(items, seen(['https://x/older'], true)).map((i) => i.url)).toEqual([
            'https://x/2',
        ]);
    });

    it('ignores an item whose timestamp cannot be parsed', () => {
        // The bad item has to be one of the *announced* ones. Math.max over the
        // announced timestamps is what a NaN poisons, and a poisoned watermark
        // compares false against everything, so the source goes silent with no
        // explanation. With the bad timestamp on an unannounced item instead,
        // the later comparison drops it on NaN anyway and the guard is never
        // load-bearing - the test passed with the guard deleted outright.
        const items = [
            { url: 'https://x/bad', publishedAt: 'not a date' },
            item(2, '2026-09-02T00:00:00Z'),
            item(3, '2026-09-03T00:00:00Z'),
        ];
        const pendingUrls = pending(items, seen(['https://x/bad', 'https://x/2']));
        expect(pendingUrls.map((i) => i.url)).toEqual(['https://x/3']);
    });

    it('announces an item published in the same second as the search floor', () => {
        // Same tie problem as the watermark branch, on the floor branch. The
        // floor is a real Discord message timestamp, so a release published in
        // that same second was assumed announced by it and dropped for good.
        const stamp = '2026-09-10T00:00:00Z';
        const items = [item(1, stamp), item(2, '2026-09-11T00:00:00Z')];
        const result = pending(items, {
            urls: new Set(['https://other/thing']),
            foundOwn: true,
            searchedFrom: stamp,
        });
        expect(result.map((i) => i.url)).toEqual(['https://x/1', 'https://x/2']);
    });

    it('announces an item published in the same second as the watermark', () => {
        const stamp = '2026-09-14T13:03:25Z';
        const items = [item(1, stamp), item(2, stamp)];
        expect(pending(items, seen(['https://x/1'])).map((i) => i.url)).toEqual(['https://x/2']);
    });
});
