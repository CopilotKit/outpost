import { describe, expect, it } from 'vitest';
import { planBacklog, previousOnLine } from '../index.js';

/**
 * The real CopilotKit publish order around v1.72.0. The interleave is the
 * common case, not an edge case: `channels/` and `angular/` ship from the same
 * repo as the main line and land between its releases.
 */
const RELEASES = [
    { tag: 'angular/v0.5.1' },
    { tag: 'v1.71.1' },
    { tag: 'v1.71.2' },
    { tag: 'channels/v0.10.0' },
    { tag: 'v1.72.0' },
    { tag: 'angular/v0.5.2' },
    { tag: 'channels/v0.10.1' },
];

const at = (tag: string) => RELEASES[RELEASES.findIndex((r) => r.tag === tag)];

describe('previousOnLine', () => {
    it('skips the other lines to reach the previous main-line release', () => {
        // Taking releases[i - 1] gave channels/v0.10.0, which GitHub happily
        // compares against: 3 commits where the real answer is 46. No error,
        // just an announcement describing a different release.
        expect(previousOnLine(RELEASES, at('v1.72.0'))).toEqual({ tag: 'v1.71.2' });
    });

    it('keeps a prefixed line on its own line', () => {
        expect(previousOnLine(RELEASES, at('channels/v0.10.1'))).toEqual({
            tag: 'channels/v0.10.0',
        });
        expect(previousOnLine(RELEASES, at('angular/v0.5.2'))).toEqual({ tag: 'angular/v0.5.1' });
    });

    it('returns undefined for the first release of a line in the window', () => {
        expect(previousOnLine(RELEASES, at('angular/v0.5.1'))).toBeUndefined();
        expect(previousOnLine(RELEASES, at('v1.71.1'))).toBeUndefined();
    });

    it('never returns a release at or after the one being announced', () => {
        for (const release of RELEASES) {
            const previous = previousOnLine(RELEASES, release);
            if (!previous) continue;
            // A baseline newer than the release makes GitHub answer ahead_by: 0,
            // so the announcement ships with no commit context and no warning.
            expect(RELEASES.indexOf(previous)).toBeLessThan(RELEASES.indexOf(release));
        }
    });

    it('returns undefined for a release that is not in the list', () => {
        // indexOf gives -1, and slice(0, -1) means "all but the last" rather
        // than "nothing" - so the miss used to hand back a plausible baseline.
        expect(previousOnLine(RELEASES, { tag: 'v9.9.9' })).toBeUndefined();
    });

    it('is unaffected by a single-line repo, where every neighbour is on the line', () => {
        const openbot = [{ tag: 'v0.0.13' }, { tag: 'v0.0.14' }, { tag: 'v0.0.15' }];
        expect(previousOnLine(openbot, openbot[2])).toEqual({ tag: 'v0.0.14' });
    });
});

describe('planBacklog', () => {
    const releases = [
        {
            tag: 'v1.72.0',
            url: 'https://github.com/o/r/releases/tag/v1.72.0',
            publishedAt: '2026-09-10T00:00:00Z',
        },
        // Two on this line, not one. With a single release the
        // announce-only-the-newest branch and the floor branch return the same
        // element, so the suite stayed green with the per-line narrowing
        // deleted - false-green on the very fix this file exists to pin.
        {
            tag: 'channels/v0.10.0',
            url: 'https://github.com/o/r/releases/tag/channels/v0.10.0',
            publishedAt: '2026-09-09T00:00:00Z',
        },
        {
            tag: 'channels/v0.10.1',
            url: 'https://github.com/o/r/releases/tag/channels/v0.10.1',
            publishedAt: '2026-09-11T00:00:00Z',
        },
        {
            tag: 'v1.73.0',
            url: 'https://github.com/o/r/releases/tag/v1.73.0',
            publishedAt: '2026-09-12T00:00:00Z',
        },
    ].map((r) => ({ ...r, repo: 'o/r', name: r.tag, body: '' }));

    const OURS = 'https://github.com/o/r/releases/';
    const seenWith = (urls: string[], searchedFrom = '2026-01-01T00:00:00Z') => ({
        urls: new Set(urls.map((u) => u.toLowerCase())),
        foundOwn: true,
        searchedFrom,
    });

    it('keeps an older release on another line pending after a newer one is announced', () => {
        // A single source-wide watermark put channels/v0.10.1 below v1.73.0 and
        // dropped it for good - lost, not deferred.
        const backlog = planBacklog(
            releases,
            seenWith([
                'https://github.com/o/r/releases/tag/v1.72.0',
                'https://github.com/o/r/releases/tag/v1.73.0',
            ]),
            OURS,
        );
        expect(backlog.map((r) => r.tag)).toEqual(['channels/v0.10.1']);
    });

    it('announces only the newest of a line that has never been announced', () => {
        // foundOwn arrives scoped to the source, so the channels line would
        // inherit `true` from the main line, skip the announce-only-the-newest
        // guard, and drain its whole window from the searchedFrom floor.
        const backlog = planBacklog(
            releases,
            seenWith(['https://github.com/o/r/releases/tag/v1.72.0']),
            OURS,
        );
        expect(backlog.map((r) => r.tag)).toEqual(['channels/v0.10.1', 'v1.73.0']);
    });

    it('reads a line from an encoded tag URL, and survives a malformed one', () => {
        // lineOfUrl only ever runs over seen.urls, so odd shapes have to go
        // there to be exercised at all. Dropping decodeURIComponent, or the
        // try/catch around it, was invisible to the whole suite - and the catch
        // exists because one odd URL out of 300 messages of channel history
        // threw inside .some() and failed the entire source.
        const backlog = planBacklog(
            releases,
            seenWith([
                'https://github.com/o/r/releases/tag/channels%2Fv0.10.0',
                'https://github.com/o/r/releases/tag/%E0%A4%A',
                'https://github.com/o/r/releases/tag/v1.72.0',
            ]),
            OURS,
        );
        // Decoded, the channels line counts as announced-before, so it takes
        // pending()'s floor branch and both of its releases are pending. Without
        // decodeURIComponent the encoded URL reads as a different line, the
        // channels line looks new, and the announce-only-the-newest guard drops
        // v0.10.0 for good - lost, not deferred.
        expect(backlog.map((r) => r.tag)).toEqual([
            'channels/v0.10.0',
            'channels/v0.10.1',
            'v1.73.0',
        ]);
    });
});
