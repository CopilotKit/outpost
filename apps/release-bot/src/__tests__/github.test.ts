import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contextFor, listReleases, previousRelease } from '../github.js';

const ORIGINAL_FETCH = globalThis.fetch;

function respondWith(handler: (url: string) => { status?: number; body: unknown }) {
    const calls: string[] = [];
    vi.stubGlobal('fetch', (input: string | URL) => {
        const url = String(input);
        calls.push(url);
        const { status = 200, body } = handler(url);
        return Promise.resolve(
            new Response(JSON.stringify(body), {
                status,
                headers: { 'content-type': 'application/json' },
            }),
        );
    });
    return calls;
}

afterEach(() => {
    vi.stubGlobal('fetch', ORIGINAL_FETCH);
    vi.resetModules();
});

describe('listReleases', () => {
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
        saved.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
        process.env.GITHUB_TOKEN = 'test';
    });

    afterEach(() => {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    /** A release in the shape the endpoint returns it. */
    function release(tag: string, publishedAt: string | null, extra: object = {}) {
        return {
            draft: false,
            prerelease: false,
            published_at: publishedAt,
            tag_name: tag,
            name: tag,
            html_url: `https://github.com/acme/repo/releases/tag/${tag}`,
            body: '',
            ...extra,
        };
    }

    /** Serves one array per page number, and `[]` for any page past the end. */
    function serve(pages: Record<number, unknown[]>) {
        return respondWith((url) => {
            const page = Number(new URL(url).searchParams.get('page'));
            return { body: pages[page] ?? [] };
        });
    }

    const fill = (count: number, make: (i: number) => unknown) =>
        Array.from({ length: count }, (_, i) => make(i));

    it('keeps paginating past a full page of drafts', async () => {
        // Drafts have no published_at, and GitHub orders by creation, which
        // clusters them at the top. Counting them as older than the window
        // ended pagination on page 1, and every in-window release behind them
        // was lost rather than deferred: the watermark moves past what is
        // never seen.
        serve({
            1: fill(100, (i) => release(`draft-${i}`, null, { draft: true })),
            2: [release('v1.0.0', '2026-03-10T00:00:00Z')],
        });

        const releases = await listReleases('acme/repo', '2026-03-01T00:00:00.000Z');

        expect(releases.map((r) => r.tag)).toEqual(['v1.0.0']);
    });

    it('does not warn when the repo has no releases at all', async () => {
        // That warning is the only signal that releases are being silently
        // lost, so an empty repo firing it makes the real alarm unreadable.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        serve({});

        await listReleases('acme/repo', '2026-03-01T00:00:00.000Z');

        expect(warn).not.toHaveBeenCalled();
    });

    it('does not warn when the releases end on a page boundary', async () => {
        // Exactly 100 (or 200, or 300) releases means the following page is
        // empty rather than short: the same false alarm by another route.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        serve({ 1: fill(100, (i) => release(`v1.0.${i}`, '2026-03-10T00:00:00Z')) });

        const releases = await listReleases('acme/repo', '2026-03-01T00:00:00.000Z');

        expect(releases.length).toBe(100);
        expect(warn).not.toHaveBeenCalled();
    });

    it('still warns when the page limit is genuinely hit', async () => {
        // The alarm has to survive the fix: releases inside the window but past
        // the last page read really are invisible, and invisible means lost.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const page = fill(100, (i) => release(`v1.0.${i}`, '2026-03-10T00:00:00Z'));
        serve({ 1: page, 2: page, 3: page, 4: page, 5: page, 6: page });

        await listReleases('acme/repo', '2026-03-01T00:00:00.000Z');

        expect(warn).toHaveBeenCalledWith(expect.stringContaining('pages of releases'));
    });

    it('does not return the same release twice when pages overlap', async () => {
        // /releases is creation-ordered, so a release published between the two
        // page fetches shifts the window and the last entry of page 1 comes
        // back as the first of page 2. Undeduped, both reach pending() with the
        // same url and both get posted.
        const overlap = {
            tag_name: 'v1.0.0',
            name: 'v1.0.0',
            html_url: 'https://github.com/o/r/releases/tag/v1.0.0',
            body: '',
            draft: false,
            prerelease: false,
            published_at: '2026-09-10T00:00:00Z',
        };
        const filler = Array.from({ length: 99 }, (_, i) => ({
            ...overlap,
            tag_name: `v0.${i}.0`,
            html_url: `https://github.com/o/r/releases/tag/v0.${i}.0`,
        }));

        // Parsed, not substring-matched: `per_page=100` contains "page=1", so
        // url.includes('page=1') was true for every page and the page-2 branch
        // never ran - the overlap this test exists for was never constructed.
        respondWith((url) => {
            const page = Number(new URL(url).searchParams.get('page'));
            return { body: page === 1 ? [...filler, overlap] : page === 2 ? [overlap] : [] };
        });

        const releases = await listReleases('o/r', '2026-09-01T00:00:00Z');
        const urls = releases.map((r) => r.url);
        expect(new Set(urls).size).toBe(urls.length);
    });

    it('orders releases sharing a timestamp oldest-created first', async () => {
        // GitHub returns newest-created first, so a stable sort left ties in
        // the reverse of the order everything else is in. The caller takes the
        // previous element as the compare baseline, so for a tie that baseline
        // was NEWER than the release: GitHub answers ahead_by 0 and the release
        // ships with no commit context, and nothing errors.
        serve({
            1: [
                release('v2.0.2', '2026-03-10T12:00:00Z'),
                release('v2.0.1', '2026-03-10T12:00:00Z'),
                release('v2.0.0', '2026-03-09T12:00:00Z'),
            ],
        });

        const releases = await listReleases('acme/repo', '2026-03-01T00:00:00.000Z');

        expect(releases.map((r) => r.tag)).toEqual(['v2.0.0', 'v2.0.1', 'v2.0.2']);
    });
});

describe('contextFor', () => {
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
        saved.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
        process.env.GITHUB_TOKEN = 'test';
    });

    afterEach(() => {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    const rel = (tag: string) => ({
        repo: 'acme/repo',
        tag,
        name: tag,
        url: `https://github.com/acme/repo/releases/tag/${tag}`,
        body: '',
        publishedAt: '2026-09-12T00:00:00Z',
    });

    /** A compare response carrying the given commit subjects. */
    const compare = (subjects: string[], extra: object = {}) => ({
        status: 'ahead',
        total_commits: subjects.length,
        commits: subjects.map((message) => ({ commit: { message } })),
        ...extra,
    });

    it('counts every commit read, not only the ones kept', async () => {
        // commitsRead is the raw count and commits.length the filtered one.
        // Collapsing the two hides the difference between "nothing to look at"
        // and "everything was noise", which is what a dependency-bump release
        // looks like.
        respondWith(() => ({
            body: compare(['chore(deps): bump x', 'ci: retry the runner', 'chore: bump y']),
        }));

        const context = await contextFor(rel('v2.0.0'), rel('v1.0.0'));
        expect(context.commits).toEqual([]);
        expect(context.commitsRead).toBe(3);
    });

    it('keeps fix(deps), which is where CVE work lands', async () => {
        // chore(deps) and build(deps) are noise; fix(deps) is the one dependency
        // scope that carries security work. Filtering it emptied `commits` on a
        // patch release, which corroborates a SKIP and posts nothing at all.
        respondWith(() => ({
            body: compare(['fix(deps): patch CVE-2026-1 in ws', 'chore(deps): bump types']),
        }));

        const context = await contextFor(rel('v2.0.0'), rel('v1.0.0'));
        expect(context.commits).toEqual(['fix(deps): patch CVE-2026-1 in ws']);
    });

    it('drops real merge commits without dropping prose that starts with merge', async () => {
        respondWith(() => ({
            body: compare([
                'Merge pull request #1 from acme/branch',
                'Merge branch main into dev',
                'merge sort: faster path',
            ]),
        }));

        const context = await contextFor(rel('v2.0.0'), rel('v1.0.0'));
        // Case-insensitive `Merge ` dropped the third one, losing real work from
        // the summary and its author from the record.
        expect(context.commits).toEqual(['merge sort: faster path']);
    });

    it('refuses a baseline the compare says is not behind this release', async () => {
        // A backport compares backwards: v1.72.5 shipping after v1.73.0 answers
        // 200 with `behind`. Whatever commits come with it describe nothing that
        // shipped in this release, so none are used - and the read is not
        // complete, so it can never back up a skip.
        respondWith(() => ({ body: compare(['feat: something'], { status: 'behind' }) }));

        const context = await contextFor(rel('v2.0.0'), rel('v3.0.0'));
        expect(context.commits).toEqual([]);
        expect(context.commitsRead).toBe(0);
        expect(context.comparedCleanly).toBeFalsy();
    });

    it('treats an identical compare as asked-and-answered', async () => {
        respondWith(() => ({ body: compare([], { status: 'identical', total_commits: 0 }) }));

        const context = await contextFor(rel('v2.0.0'), rel('v1.0.0'));
        // Distinct from "could not ask": GitHub compared the tags and there is
        // genuinely nothing between them, which corroborates a skip instead of
        // forcing a second completion and announcing an empty release.
        expect(context.comparedCleanly).toBe(true);
    });

    it('pages until it has the newest work, not just the first page', async () => {
        // The endpoint returns oldest first, so without paging the newest work
        // in a large release is simply absent from the summary.
        respondWith((url) => {
            const page = Number(new URL(url).searchParams.get('page') ?? '1');
            const subjects =
                page === 1
                    ? Array.from({ length: 100 }, (_, i) => `feat: old ${i}`)
                    : ['feat: the newest thing'];
            return { body: compare(subjects, { total_commits: 101 }) };
        });

        const context = await contextFor(rel('v2.0.0'), rel('v1.0.0'));
        expect(context.commitsRead).toBe(101);
        expect(context.commits).toContain('feat: the newest thing');
    });

    it('announces without commit context when there is no previous release', async () => {
        const context = await contextFor(rel('v1.0.0'), undefined);
        expect(context).toMatchObject({ commits: [], commitsRead: 0 });
        // Nothing was compared, so nothing can back up a skip.
        expect(context.comparedCleanly).toBeFalsy();
    });
});

describe('contextFor degrading rather than failing', () => {
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
        saved.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
        process.env.GITHUB_TOKEN = 'test';
    });

    afterEach(() => {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    const rel = (tag: string) => ({
        repo: 'acme/repo',
        tag,
        name: tag,
        url: `https://github.com/acme/repo/releases/tag/${tag}`,
        body: '',
        publishedAt: '2026-09-12T00:00:00Z',
    });

    it('announces without commit context when the baseline tag is gone', async () => {
        respondWith(() => ({ status: 404, body: { message: 'Not Found' } }));

        // Release tags do get deleted and re-pushed. Throwing here failed the
        // whole source on every run until the release aged out of the window,
        // while every other missing-commits path degrades.
        const context = await contextFor(rel('v2.0.0'), rel('v1.0.0'));
        expect(context).toMatchObject({ commits: [], commitsRead: 0 });
        expect(context.comparedCleanly).toBeFalsy();
    });
});

describe('responses the API is not supposed to send', () => {
    const saved = process.env.GITHUB_TOKEN;
    beforeEach(() => {
        process.env.GITHUB_TOKEN = 'test';
    });
    afterEach(() => {
        vi.useRealTimers();
        if (saved === undefined) delete process.env.GITHUB_TOKEN;
        else process.env.GITHUB_TOKEN = saved;
    });

    const rel = (tag: string) => ({
        repo: 'acme/repo',
        tag,
        name: tag,
        url: `https://github.com/acme/repo/releases/tag/${tag}`,
        body: '',
        publishedAt: '2026-09-12T00:00:00Z',
    });

    it('throws on a 200 whose body is not an array', async () => {
        // A proxy or gateway envelope gives `batch.length === undefined`, which
        // read as an empty page: the walk stopped on page 1 with nothing
        // collected, no warning, and the run exited 0. A cron reporting success
        // while announcing nothing is the failure this bot exists to avoid.
        respondWith(() => ({ body: { message: 'upstream unavailable' } }));
        await expect(listReleases('acme/repo', '2026-09-01T00:00:00Z')).rejects.toThrow(
            /not an array/,
        );
    });

    it('excludes a release whose published_at cannot be read', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        // `NaN <= cutoff` is false, so a malformed timestamp used to fall
        // through the window filter into the result. pending() drops it later,
        // but by then previousOnLine() can have picked it as a compare baseline,
        // and the publish-order comparator returns NaN for every pair touching
        // it - which is not a total order, so valid releases move too.
        respondWith((url) => ({
            body:
                Number(new URL(url).searchParams.get('page')) === 1
                    ? [
                          {
                              draft: false,
                              prerelease: false,
                              tag_name: 'v1.0.0',
                              name: 'v1.0.0',
                              html_url: 'https://github.com/acme/repo/releases/tag/v1.0.0',
                              body: '',
                              published_at: 'not a date',
                          },
                          {
                              draft: false,
                              prerelease: false,
                              tag_name: 'v1.1.0',
                              name: 'v1.1.0',
                              html_url: 'https://github.com/acme/repo/releases/tag/v1.1.0',
                              body: '',
                              published_at: '2026-09-12T00:00:00Z',
                          },
                      ]
                    : [],
        }));

        const releases = await listReleases('acme/repo', '2026-09-01T00:00:00Z');
        expect(releases.map((r) => r.tag)).toEqual(['v1.1.0']);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('unreadable published_at'));
        warn.mockRestore();
    });

    it('keeps reading the pages after one that failed, and marks the read incomplete', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        // GitHub says there are 300 commits. Page 1 and page 3 answer with 100
        // each, page 2 fails outright. Page 3 is the last page for 300.
        respondWith((url) => {
            const page = Number(new URL(url).searchParams.get('page')) || 1;
            if (page === 2) return { status: 404, body: { message: 'Not Found' } };
            const commits =
                page === 1 || page === 3
                    ? Array.from({ length: 100 }, (_, i) => ({
                          commit: { message: `feat: page ${page} change ${i}` },
                      }))
                    : [];
            return { body: { status: 'ahead', total_commits: 300, commits } };
        });

        const context = await contextFor(rel('v1.1.0'), rel('v1.0.0'));

        // 200, not 100: page 3 was still read. Stopping at the first failure
        // abandoned every page behind it, so on a 625-commit release one 502
        // dropped 525 commits and the summary was written from the oldest
        // hundred while claiming to describe the newest work.
        expect(context.commitsRead).toBe(200);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('compare page 2 failed'));

        // And the read is marked incomplete. Without this a truncated list is
        // indistinguishable from a whole one, and `summarize` treats "commits
        // were read and none survived the noise filter" as grounds to skip the
        // release - which leaves nothing in the channel, so the next run's
        // watermark moves past it and it is gone.
        expect(context.comparedCleanly).toBe(false);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('read 200 of 300 commits'));
        warn.mockRestore();
    });

    it('does not read a deleted tag out of an unrelated error body', async () => {
        // The 404 branch used to match `error.message.includes('GitHub 404')`
        // against a message that embeds the first 200 characters of the response
        // body. A 500 whose body merely mentions that string was reclassified as
        // a deleted tag, and the release was announced with no commit context
        // while the log asserted a cause that was not true.
        respondWith(() => ({
            status: 500,
            body: { message: 'upstream proxy said: GitHub 404 on /repos/other/repo' },
        }));

        // A 5xx is retryable, so the backoff has to be driven rather than slept
        // through - three real attempts cost the suite three seconds.
        vi.useFakeTimers();
        const pending = contextFor(rel('v1.1.0'), rel('v1.0.0'));
        const settled = expect(pending).rejects.toThrow(/GitHub 500/);
        await vi.runAllTimersAsync();
        await settled;
        vi.useRealTimers();
    });
});

describe('the input filters nothing else enforces', () => {
    const saved = process.env.GITHUB_TOKEN;
    beforeEach(() => {
        process.env.GITHUB_TOKEN = 'test';
    });
    afterEach(() => {
        vi.useRealTimers();
        if (saved === undefined) delete process.env.GITHUB_TOKEN;
        else process.env.GITHUB_TOKEN = saved;
    });

    const entry = (tag: string, extra: object = {}) => ({
        draft: false,
        prerelease: false,
        tag_name: tag,
        name: tag,
        html_url: `https://github.com/acme/repo/releases/tag/${tag}`,
        body: '',
        published_at: '2026-09-12T00:00:00Z',
        ...extra,
    });

    const onePage = (releases: object[]) =>
        respondWith((url) => ({
            body: Number(new URL(url).searchParams.get('page')) === 1 ? releases : [],
        }));

    it('excludes prereleases and drafts that carry a publish date', async () => {
        // The listing's own prerelease filter, the one every source relies on
        // before its tag pattern. Both repos publish -next and -alpha tags, so a
        // regression posts one to a live channel AND moves the watermark past
        // the real release behind it. The existing draft test
        // gives its drafts `published_at: null`, so `!r.published_at` already
        // excludes them and neither term is exercised on its own.
        onePage([
            entry('v1.74.0-next.1', { prerelease: true }),
            entry('v1.74.0-draft', { draft: true }),
            entry('v1.74.0'),
        ]);

        const releases = await listReleases('acme/repo', '2026-09-01T00:00:00Z');
        expect(releases.map((r) => r.tag)).toEqual(['v1.74.0']);
    });

    it('compares the cutoff by instant, not as a string', async () => {
        // `since` is the lookback floor, 30 days back. It carries milliseconds
        // and GitHub's timestamps do not, so a lexicographic compare disagrees
        // with the real order inside the boundary second.
        onePage([entry('v1.72.0', { published_at: '2026-09-10T12:00:00Z' })]);

        // Sub-second: by instant this is older than the cutoff and excluded. A
        // string compare puts 'Z' (90) above '.' (46) at index 19 and includes
        // it, putting a release outside the window back into play.
        expect(await listReleases('acme/repo', '2026-09-10T12:00:00.500Z')).toEqual([]);
    });

    it('excludes a release published exactly at the cutoff', async () => {
        // `since` is the lookback floor, 30 days back. A release exactly on it is
        // outside the window, and the comparison is by instant like the one
        // above. Low stakes either way, since pending() dedupes by URL, but the
        // two comparisons should agree on which side the boundary sits.
        onePage([entry('v1.72.0', { published_at: '2026-09-10T12:00:00Z' })]);

        expect(await listReleases('acme/repo', '2026-09-10T12:00:00Z')).toEqual([]);
    });

    it('retries a secondary rate limit, which leaves the budget above zero', async () => {
        // The subtle half of the 403 rule: a primary limit zeroes
        // x-ratelimit-remaining, while abuse detection leaves it above zero and
        // sends retry-after instead. Classified as fatal, that fails the source
        // on a limit that clears in seconds.
        let calls = 0;
        vi.stubGlobal('fetch', () => {
            calls++;
            if (calls === 1) {
                return Promise.resolve(
                    new Response('slow down', {
                        status: 403,
                        headers: { 'retry-after': '1', 'x-ratelimit-remaining': '42' },
                    }),
                );
            }
            return Promise.resolve(
                new Response(JSON.stringify([]), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
            );
        });

        vi.useFakeTimers();
        const pending = listReleases('acme/repo', '2026-09-01T00:00:00Z');
        await vi.runAllTimersAsync();
        await pending;
        expect(calls).toBe(2);
    });

    it('builds the compare range from both tags, in order, oldest first', async () => {
        // Real tags carry a slash: `channels/v0.11.0`, `release/2026-09-23`.
        // Encoding the slash is belt and braces rather than a fix: verified
        // against the live API, `channels/v0.10.0...channels/v0.11.0` and the
        // %2F form both return the same 625 commits. The %2F below pins the
        // shape as written; what matters is the ORDER: reversed, GitHub answers
        // `behind` with no commits and the release ships with no context.
        const seen: string[] = [];
        vi.stubGlobal('fetch', (input: string | URL) => {
            seen.push(String(input));
            return Promise.resolve(
                new Response(JSON.stringify({ status: 'ahead', total_commits: 1, commits: [] }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
            );
        });

        const rel = (tag: string) => ({
            repo: 'acme/repo',
            tag,
            name: tag,
            url: `https://github.com/acme/repo/releases/tag/${tag}`,
            body: '',
            publishedAt: '2026-09-12T00:00:00Z',
        });

        await contextFor(rel('channels/v0.11.0'), rel('channels/v0.10.0'));
        const compareCall = seen.find((u) => u.includes('/compare/'));
        expect(compareCall).toContain('channels%2Fv0.10.0...channels%2Fv0.11.0');
    });
});

describe('previousRelease, the baseline lookup past the window', () => {
    const saved = process.env.GITHUB_TOKEN;
    beforeEach(() => {
        process.env.GITHUB_TOKEN = 'test';
    });
    afterEach(() => {
        if (saved === undefined) delete process.env.GITHUB_TOKEN;
        else process.env.GITHUB_TOKEN = saved;
    });

    const gh = (tag: string, published_at: string | null, extra: object = {}) => ({
        draft: false,
        prerelease: false,
        tag_name: tag,
        name: tag,
        html_url: `https://github.com/o/r/releases/tag/${tag}`,
        body: '',
        published_at,
        ...extra,
    });
    const target = {
        repo: 'o/r',
        tag: 'angular/v0.6.0',
        name: 'angular/v0.6.0',
        url: 'https://github.com/o/r/releases/tag/angular/v0.6.0',
        body: '',
        publishedAt: '2026-09-10T00:00:00Z',
    };
    const angular = (tag: string) => tag.startsWith('angular/');

    it('returns the most recent earlier release on the same line', async () => {
        respondWith((url) => ({
            body:
                Number(new URL(url).searchParams.get('page')) === 1
                    ? [
                          gh('angular/v0.6.0', '2026-09-10T00:00:00Z'),
                          gh('channels/v0.9.0', '2026-08-20T00:00:00Z'),
                          gh('angular/v0.5.2', '2026-08-01T00:00:00Z'),
                          gh('angular/v0.5.1', '2026-07-01T00:00:00Z'),
                      ]
                    : [],
        }));
        const found = await previousRelease(target, angular);
        expect(found?.tag).toBe('angular/v0.5.2');
    });

    it('skips drafts, prereleases and anything published after the release', async () => {
        respondWith((url) => ({
            body:
                Number(new URL(url).searchParams.get('page')) === 1
                    ? [
                          gh('angular/v0.7.0', '2026-09-20T00:00:00Z'),
                          gh('angular/v0.6.0-next.1', '2026-09-05T00:00:00Z', { prerelease: true }),
                          gh('angular/v0.5.9', '2026-09-04T00:00:00Z', { draft: true }),
                          gh('angular/v0.5.2', '2026-08-01T00:00:00Z'),
                      ]
                    : [],
        }));
        const found = await previousRelease(target, angular);
        expect(found?.tag).toBe('angular/v0.5.2');
    });

    it('keeps reading past the first match, since the list is ordered by creation', async () => {
        // Page 1 holds an older match; page 2 holds a match published more
        // recently that was created earlier. Taking the first match would pick
        // the wrong baseline, and GitHub answers that compare without complaint.
        const full = (n: number, from: string) =>
            Array.from({ length: n }, (_, i) => gh(`v9.${from}.${i}`, '2026-09-30T00:00:00Z'));
        respondWith((url) => {
            const page = Number(new URL(url).searchParams.get('page'));
            if (page === 1)
                return { body: [...full(99, 'a'), gh('angular/v0.5.0', '2026-07-01T00:00:00Z')] };
            if (page === 2) return { body: [gh('angular/v0.5.2', '2026-08-01T00:00:00Z')] };
            return { body: [] };
        });
        const found = await previousRelease(target, angular);
        expect(found?.tag).toBe('angular/v0.5.2');
    });

    it('stops reading once a page holds nothing newer than its match', async () => {
        // A full page with the match on it, then a full page entirely older:
        // that is enough to know nothing more recent is further down.
        const full = (n: number, prefix: string, at: string) =>
            Array.from({ length: n }, (_, i) => gh(`${prefix}${i}`, at));
        const calls = respondWith((url) => {
            const page = Number(new URL(url).searchParams.get('page'));
            if (page === 1)
                return {
                    body: [
                        ...full(99, 'v9.0.', '2026-09-20T00:00:00Z'),
                        gh('angular/v0.5.2', '2026-08-01T00:00:00Z'),
                    ],
                };
            return { body: full(100, `v0.${page}.`, '2026-01-01T00:00:00Z') };
        });
        const found = await previousRelease(target, angular);
        expect(found?.tag).toBe('angular/v0.5.2');
        expect(calls).toHaveLength(2);
    });

    it('says so when it runs out of pages without a match', async () => {
        // Every page full, so the list goes on past what was read: "none" here
        // means "none in the last 500", which is worth a line in the log.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        respondWith((url) => {
            const page = Number(new URL(url).searchParams.get('page'));
            return {
                body: Array.from({ length: 100 }, (_, i) =>
                    gh(`v1.${page}.${i}`, '2026-09-01T00:00:00Z'),
                ),
            };
        });
        expect(await previousRelease(target, angular)).toBeUndefined();
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('no earlier release on its line'),
        );
        warn.mockRestore();
    });

    it('does not warn when the list simply ends', async () => {
        // A repo with exactly 100 releases reaches an empty page 2. That is the
        // end of the list, and "none in the last 500" would be false.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        respondWith((url) => ({
            body:
                Number(new URL(url).searchParams.get('page')) === 1
                    ? Array.from({ length: 100 }, (_, i) => gh(`v1.0.${i}`, '2026-09-01T00:00:00Z'))
                    : [],
        }));
        expect(await previousRelease(target, angular)).toBeUndefined();
        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    it('fails on a reply that is not a list, rather than reading it as empty', async () => {
        respondWith(() => ({ body: { message: 'upstream unavailable' } }));
        await expect(previousRelease(target, angular)).rejects.toThrow(/not an array/);
    });

    it('returns undefined when the line has no earlier release', async () => {
        respondWith(() => ({ body: [gh('angular/v0.6.0', '2026-09-10T00:00:00Z')] }));
        expect(await previousRelease(target, angular)).toBeUndefined();
    });
});

describe('a compare that does not say how many commits it has', () => {
    const saved = process.env.GITHUB_TOKEN;
    beforeEach(() => {
        process.env.GITHUB_TOKEN = 'test';
    });
    afterEach(() => {
        if (saved === undefined) delete process.env.GITHUB_TOKEN;
        else process.env.GITHUB_TOKEN = saved;
    });

    const rel = (tag: string) => ({
        repo: 'o/r',
        tag,
        name: tag,
        url: `https://github.com/o/r/releases/tag/${tag}`,
        body: '',
        publishedAt: '2026-09-12T00:00:00Z',
    });

    it('is never reported as complete', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        // No total_commits, and one page of pure noise. Treated as complete,
        // that read corroborates a SKIP and a real release is never announced.
        respondWith(() => ({
            body: {
                status: 'ahead',
                commits: Array.from({ length: 100 }, (_, i) => ({
                    commit: { message: `chore(deps): bump thing ${i}` },
                })),
            },
        }));
        const context = await contextFor(rel('v1.1.0'), rel('v1.0.0'));
        expect(context.comparedCleanly).toBe(false);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('no total_commits'));
        warn.mockRestore();
    });
});

describe('a compare longer than the pages it may read', () => {
    const saved = process.env.GITHUB_TOKEN;
    beforeEach(() => {
        process.env.GITHUB_TOKEN = 'test';
    });
    afterEach(() => {
        if (saved === undefined) delete process.env.GITHUB_TOKEN;
        else process.env.GITHUB_TOKEN = saved;
    });

    const rel = (tag: string) => ({
        repo: 'o/r',
        tag,
        name: tag,
        url: `https://github.com/o/r/releases/tag/${tag}`,
        body: '',
        publishedAt: '2026-09-12T00:00:00Z',
    });

    it('reads the newest pages, not the next ones', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        // 2500 commits, oldest first. This is a monorepo, so a few weeks between
        // two releases on one line is thousands of commits. Paging forward read
        // only the oldest thousand, and the "newest 60" shown to the model were
        // weeks older than the release.
        const calls = respondWith((url) => {
            const page = Number(new URL(url).searchParams.get('page')) || 1;
            return {
                body: {
                    status: 'ahead',
                    total_commits: 2500,
                    commits: Array.from({ length: 100 }, (_, i) => ({
                        commit: { message: `feat: change ${(page - 1) * 100 + i}` },
                    })),
                },
            };
        });

        const context = await contextFor(rel('v2.0.0'), rel('v1.0.0'));
        const pages = calls
            .filter((u) => u.includes('/compare/'))
            .map((u) => Number(new URL(u).searchParams.get('page')) || 1);
        expect(pages).toEqual([1, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
        expect(context.commits.at(-1)).toBe('feat: change 2499');
        expect(context.comparedCleanly).toBe(false);
        warn.mockRestore();
    });

    it('is reported complete when every commit was read', async () => {
        // The other side of the flag: a whole, short compare must count, or no
        // dependency-bump release could ever be skipped.
        respondWith(() => ({
            body: {
                status: 'ahead',
                total_commits: 2,
                commits: [{ commit: { message: 'feat: a' } }, { commit: { message: 'fix: b' } }],
            },
        }));
        const context = await contextFor(rel('v2.0.0'), rel('v1.0.0'));
        expect(context.comparedCleanly).toBe(true);
    });
});
