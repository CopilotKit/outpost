import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Source } from '../sources.js';

/**
 * The announce loop, with its collaborators stubbed.
 *
 * These branches decide whether a release is announced, held, or lost. Before
 * this file existed, every one of them could be deleted with the rest of the
 * suite still green: replacing either disposition `throw` with a `continue`
 * passed the whole suite.
 */
// Mixed case on purpose, like the real `CopilotKit/CopilotKit`. GitHub returns
// the canonical spelling in html_url, `announced()` lowercases it on the way into
// seen.urls, and `ours` lowercases the repo to match. An all-lowercase fixture
// makes every one of those normalisations look decorative: each could be deleted
// with the suite green, and losing any of them means the lookups never match and
// every release is announced again on every run.
const REPO = 'Acme/Repo';

const release = (tag: string, publishedAt: string) => ({
    repo: REPO,
    tag,
    name: tag,
    // Canonical casing, as GitHub sends it.
    url: `https://github.com/${REPO}/releases/tag/${tag}`,
    body: '',
    publishedAt,
});

/** Already in the channel, so the backlog after it is visible to the loop. */
const SEED = release('v0.9.0', '2026-09-01T00:00:00Z');

const SOURCE: Source = {
    name: 'acme',
    repo: REPO,
    channelId: 'chan',
    include: () => true,
    title: (r) => r.tag,
};

const FAR_FUTURE = Date.now() + 60 * 60_000;

type Plan = { tag: string; publishedAt: string; summary: unknown };

async function harness(
    plan: Plan[],
    opts: {
        seedInReleases?: boolean;
        older?: ReturnType<typeof release>[];
        lookupFails?: boolean;
    } = {},
) {
    const { seedInReleases = true } = opts;
    const summaries = new Map(plan.map((p) => [p.tag, p.summary]));

    // Honours belongsHere and lowercases, exactly as the real announced() does.
    // planBacklog() recomputes foundOwn per line from these URLs, so the real
    // coverage of the `ours` prefix comes from that, through the lowercased set.
    const announced = vi.fn(
        async (_channelId: string, belongsHere: (u: string) => boolean, _since?: string) => {
            const urls = new Set<string>();
            let foundOwn = false;
            for (const url of [SEED.url]) {
                urls.add(url.toLowerCase());
                if (belongsHere(url)) foundOwn = true;
            }
            return { urls, foundOwn, searchedFrom: '2026-01-01T00:00:00Z' };
        },
    );
    const listReleases = vi.fn(async (_repo: string, _since: string) => [
        ...(seedInReleases ? [SEED] : []),
        ...plan.map((p) => release(p.tag, p.publishedAt)),
    ]);
    // Records the baseline it was given, so the previousOnLine wiring is visible.
    // Ignoring the argument let `previousOnLine(releases, release)` be replaced
    // by `releases[i - 1]` - verbatim the cross-line comparison bug it exists to
    // fix - with the suite still green.
    const baselines: (string | undefined)[] = [];
    const contextFor = vi.fn(
        async (r: { tag: string; publishedAt: string }, previous?: { tag: string }) => {
            baselines.push(previous?.tag);
            return { ...release(r.tag, r.publishedAt), commits: ['feat: x'], commitsRead: 1 };
        },
    );
    const summarize = vi.fn(async (r: { tag: string }) => summaries.get(r.tag));
    // Typed, so mock.calls is not an empty tuple and the assertions below can
    // read the announcement rather than casting through undefined.
    const announce = vi.fn(
        async (_announcement: { title: string; body: string; url: string }) => {},
    );

    // The lookup past the window. Undefined unless a test supplies an older
    // release, and every call's tag is recorded; the predicate it was given
    // is applied to `older`, so a wrong predicate picks a wrong baseline.
    const older = opts.older ?? [];
    const lookups: string[] = [];
    const previousRelease = vi.fn(
        async (r: { tag: string; publishedAt: string }, matches: (tag: string) => boolean) => {
            lookups.push(r.tag);
            if (opts.lookupFails) throw new Error('GitHub 502 on /repos/o/r/releases');
            return older
                .filter(
                    (o) => matches(o.tag) && Date.parse(o.publishedAt) < Date.parse(r.publishedAt),
                )
                .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))[0];
        },
    );
    vi.doMock('../github.js', () => ({ listReleases, contextFor, previousRelease }));
    vi.doMock('../summarize.js', () => ({ summarize }));
    vi.doMock('../youtube.js', () => ({ listVideos: vi.fn(async () => []) }));
    vi.doMock('../discord.js', () => ({
        announced,
        announce,
        compose: () => 'composed',
        postText: vi.fn(async () => {}),
        withPing: (t: string) => t,
    }));

    const { announceReleases } = await import('../index.js');
    const titles = () => announce.mock.calls.map(([a]) => a.title);

    return {
        announceReleases,
        announce,
        summarize,
        titles,
        baselines,
        announced,
        listReleases,
        lookups,
    };
}

const text = (t: string) => ({ kind: 'text', text: t });

describe('the announce loop', () => {
    beforeEach(() => vi.resetModules());
    afterEach(() => {
        vi.doUnmock('../github.js');
        vi.doUnmock('../summarize.js');
        vi.doUnmock('../youtube.js');
        vi.doUnmock('../discord.js');
        vi.resetModules();
    });

    it('holds the source and posts nothing on a retryable failure', async () => {
        const { announceReleases, announce } = await harness([
            {
                tag: 'v1.0.0',
                publishedAt: '2026-09-10T00:00:00Z',
                summary: { kind: 'failed', reason: 'rate limited', disposition: 'retry' },
            },
            { tag: 'v1.1.0', publishedAt: '2026-09-11T00:00:00Z', summary: text('later') },
        ]);

        // Announcing v1.1.0 would move the watermark past v1.0.0, and it would
        // never be retried. Holding position is the entire point of `retry`.
        // A plain Error, not Misconfigured: that type is rethrown past main()'s
        // per-source handler and would stop every remaining source over one
        // rate limit.
        const error = await announceReleases(SOURCE, FAR_FUTURE).catch((e: Error) => e);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/v1\.0\.0: rate limited/);
        expect((error as Error).name).not.toBe('Misconfigured');
        expect(announce).not.toHaveBeenCalled();
    });

    it('stops the run on a misconfiguration rather than posting an empty body', async () => {
        const { announceReleases, announce } = await harness([
            {
                tag: 'v1.0.0',
                publishedAt: '2026-09-10T00:00:00Z',
                summary: {
                    kind: 'failed',
                    reason: 'OPENAI_API_KEY is not set',
                    disposition: 'abort',
                },
            },
        ]);

        // As `give-up` this filled the channel with "Summary unavailable" posts
        // and advanced the watermark past every one of them.
        // Misconfigured specifically: main() rethrows that past its per-source
        // handler to stop the run. A plain Error would let every other source
        // repeat the same failure.
        await expect(announceReleases(SOURCE, FAR_FUTURE)).rejects.toMatchObject({
            name: 'Misconfigured',
            message: expect.stringMatching(/OPENAI_API_KEY/),
        });
        expect(announce).not.toHaveBeenCalled();
    });

    it('announces with the link when a release can never be summarized', async () => {
        const { announceReleases, announce } = await harness([
            {
                tag: 'v1.0.0',
                publishedAt: '2026-09-10T00:00:00Z',
                summary: { kind: 'failed', reason: 'refused', disposition: 'give-up' },
            },
        ]);

        // Silence here would block every release behind it for the whole window.
        await announceReleases(SOURCE, FAR_FUTURE);
        expect(announce).toHaveBeenCalledTimes(1);
        expect(announce.mock.calls[0]?.[0].body).toBe(
            'Summary unavailable. See the release notes.',
        );
    });

    it('does not let a skip consume the per-run budget', async () => {
        const { announceReleases, titles } = await harness([
            { tag: 'v1.0.0', publishedAt: '2026-09-08T00:00:00Z', summary: { kind: 'skip' } },
            { tag: 'v1.1.0', publishedAt: '2026-09-09T00:00:00Z', summary: { kind: 'skip' } },
            { tag: 'v1.2.0', publishedAt: '2026-09-10T00:00:00Z', summary: text('a') },
            { tag: 'v1.3.0', publishedAt: '2026-09-11T00:00:00Z', summary: text('b') },
        ]);

        // Counting skips against the cap stalled a source until the releases
        // behind them aged out of the window.
        await announceReleases(SOURCE, FAR_FUTURE);
        expect(titles()).toEqual(['v1.2.0', 'v1.3.0']);
    });

    it('posts at most the per-run cap, oldest first', async () => {
        const { announceReleases, titles } = await harness([
            { tag: 'v1.0.0', publishedAt: '2026-09-08T00:00:00Z', summary: text('a') },
            { tag: 'v1.1.0', publishedAt: '2026-09-09T00:00:00Z', summary: text('b') },
            { tag: 'v1.2.0', publishedAt: '2026-09-10T00:00:00Z', summary: text('c') },
        ]);

        // Oldest first, so the watermark advances one step at a time and the
        // rest is deferred rather than skipped over.
        await announceReleases(SOURCE, FAR_FUTURE);
        expect(titles()).toEqual(['v1.0.0', 'v1.1.0']);
    });

    it('recognises its own past announcement when the repo name is mixed case', async () => {
        // The seeded announcement is ours but its release has aged out of the
        // window, so no URL in seen.urls matches a current release and the
        // watermark branch cannot run. That makes foundOwn the deciding fact,
        // and foundOwn is the one thing `ours` is used for.
        //
        // With the repo spelled as GitHub spells it, dropping the lowercasing
        // makes the prefix never match: the line looks new, pending() keeps only
        // the newest release, and everything behind it is dropped for good
        // rather than deferred.
        const { announceReleases, titles } = await harness(
            [
                { tag: 'v1.0.0', publishedAt: '2026-09-10T00:00:00Z', summary: text('a') },
                { tag: 'v1.1.0', publishedAt: '2026-09-11T00:00:00Z', summary: text('b') },
            ],
            { seedInReleases: false },
        );

        await announceReleases(SOURCE, FAR_FUTURE);
        expect(titles()).toEqual(['v1.0.0', 'v1.1.0']);
    });

    it('compares each release against the previous one on its own tag line', async () => {
        const { announceReleases, baselines } = await harness([
            { tag: 'channels/v0.1.0', publishedAt: '2026-09-09T00:00:00Z', summary: text('a') },
            { tag: 'v1.0.0', publishedAt: '2026-09-10T00:00:00Z', summary: text('b') },
        ]);

        // v1.0.0's baseline must be the seeded v0.9.0, not the channels release
        // published between them. Taking the immediately preceding element is
        // the bug previousOnLine exists to fix: GitHub answers that compare
        // happily, so the announcement describes a different release and nothing
        // errors.
        await announceReleases(SOURCE, FAR_FUTURE);
        expect(baselines).toEqual([undefined, 'v0.9.0']);
    });

    it('finds a baseline older than the window for the first release on a line', async () => {
        // angular/v0.6.0 is the only Angular release in the window, so the
        // in-window search finds nothing. Its real predecessor shipped 40 days
        // earlier. Without the fallback it is summarized from the notes alone,
        // and as a dependency-bump release it could never be skipped, since a
        // SKIP is only trusted when commits back it up.
        const { announceReleases, baselines, lookups } = await harness(
            [{ tag: 'angular/v0.6.0', publishedAt: '2026-09-10T00:00:00Z', summary: text('a') }],
            {
                older: [
                    release('angular/v0.5.2', '2026-08-01T00:00:00Z'),
                    // Newer, but a different line. Must not be chosen.
                    release('channels/v0.9.0', '2026-08-20T00:00:00Z'),
                ],
            },
        );

        await announceReleases(SOURCE, FAR_FUTURE);
        expect(lookups).toEqual(['angular/v0.6.0']);
        expect(baselines).toEqual(['angular/v0.5.2']);
    });

    it('reads the channel back as far as it lists releases', async () => {
        // The two windows have to match. A channel read shallower than the
        // release listing lets an already-announced release fall out of view
        // while still being a candidate, and it is posted again every run.
        const { announceReleases, announced, listReleases } = await harness([
            { tag: 'v1.0.0', publishedAt: '2026-09-10T00:00:00Z', summary: text('a') },
        ]);
        await announceReleases(SOURCE, FAR_FUTURE);
        const readBack = announced.mock.calls[0]?.[2];
        const listedSince = listReleases.mock.calls[0]?.[1];
        expect(readBack).toBeTruthy();
        expect(readBack).toBe(listedSince);
    });

    it('only takes a baseline the source would itself announce', async () => {
        // angular/v0.5.3-hotfix is on the right line and more recent, but the
        // source's tag filter rejects it, so it is not a release this bot
        // compares against. The lookup is handed both conditions, not one.
        const { announceReleases, baselines } = await harness(
            [{ tag: 'angular/v0.6.0', publishedAt: '2026-09-10T00:00:00Z', summary: text('a') }],
            {
                older: [
                    release('angular/v0.5.2', '2026-08-01T00:00:00Z'),
                    release('angular/v0.5.3-hotfix', '2026-08-15T00:00:00Z'),
                ],
            },
        );

        await announceReleases(
            { ...SOURCE, include: (tag) => /^(angular\/)?v\d+\.\d+\.\d+$/.test(tag) },
            FAR_FUTURE,
        );
        expect(baselines).toEqual(['angular/v0.5.2']);
    });

    it('announces without commits when the lookup itself fails', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        // The lookup only ever improves a summary. A failure in it is treated
        // like a failed compare: announce without commit context, rather than
        // failing the whole source for the run.
        const { announceReleases, titles, baselines } = await harness(
            [{ tag: 'angular/v0.6.0', publishedAt: '2026-09-10T00:00:00Z', summary: text('a') }],
            { lookupFails: true },
        );

        await announceReleases(SOURCE, FAR_FUTURE);
        expect(titles()).toEqual(['angular/v0.6.0']);
        expect(baselines).toEqual([undefined]);
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('could not look up the previous release'),
        );
        warn.mockRestore();
    });

    it('does not look past the window when the baseline is already in it', async () => {
        // The extra read costs a GitHub call, so it only happens when needed.
        const { announceReleases, lookups } = await harness([
            { tag: 'v1.0.0', publishedAt: '2026-09-10T00:00:00Z', summary: text('a') },
        ]);

        await announceReleases(SOURCE, FAR_FUTURE);
        expect(lookups).toEqual([]);
    });

    it('announces only the tags the source admits', async () => {
        const { announceReleases, titles } = await harness([
            { tag: 'vundefined', publishedAt: '2026-09-09T00:00:00Z', summary: text('junk') },
            { tag: 'v1.0.0', publishedAt: '2026-09-10T00:00:00Z', summary: text('real') },
        ]);

        // The filter is applied here, not by listReleases. Without it the junk
        // and preview tags that exist in the real repo reach a live channel, and
        // each one moves the watermark past a genuine release.
        await announceReleases(
            { ...SOURCE, include: (tag) => /^v\d+\.\d+\.\d+$/.test(tag) },
            FAR_FUTURE,
        );
        expect(titles()).toEqual(['v1.0.0']);
    });

    it('announces with the release URL unchanged, because it is the dedup key', async () => {
        const { announceReleases, announce } = await harness([
            { tag: 'v1.0.0', publishedAt: '2026-09-10T00:00:00Z', summary: text('a') },
        ]);

        // Nothing else recovers this. A URL that does not round-trip makes the
        // announcement unrecognisable on the next read, so it posts again, and
        // again, for as long as the release stays in the window.
        await announceReleases(SOURCE, FAR_FUTURE);
        expect(announce.mock.calls[0]?.[0].url).toBe(
            'https://github.com/Acme/Repo/releases/tag/v1.0.0',
        );
    });

    it('does nothing at all once the run budget is spent', async () => {
        const { announceReleases, announce, summarize } = await harness([
            { tag: 'v1.0.0', publishedAt: '2026-09-10T00:00:00Z', summary: text('a') },
        ]);

        await announceReleases(SOURCE, Date.now() - 1);
        expect(announce).not.toHaveBeenCalled();
        expect(summarize).not.toHaveBeenCalled();
    });
});

/**
 * The video loop: the deferral warning and the in-loop deadline check the
 * release loop has, which it once lacked.
 */
async function videoHarness(count: number) {
    const videos = Array.from({ length: count }, (_, i) => ({
        id: `vid${i}`,
        url: `https://www.youtube.com/watch?v=vid${i}`,
        publishedAt: `2026-09-${String(10 + i).padStart(2, '0')}T00:00:00Z`,
    }));

    const postText = vi.fn(async () => {});

    vi.doMock('../youtube.js', () => ({ listVideos: vi.fn(async () => videos) }));
    vi.doMock('../github.js', () => ({
        listReleases: vi.fn(async () => []),
        contextFor: vi.fn(),
        previousRelease: vi.fn(),
    }));
    vi.doMock('../summarize.js', () => ({ summarize: vi.fn() }));
    vi.doMock('../discord.js', () => ({
        // A seeded announcement, so pending() takes its watermark branch and
        // returns the backlog rather than only the newest video.
        announced: vi.fn(async () => ({
            urls: new Set(['https://www.youtube.com/watch?v=vid0']),
            foundOwn: true,
            searchedFrom: '2026-01-01T00:00:00Z',
        })),
        announce: vi.fn(async () => {}),
        compose: () => 'composed',
        postText,
        withPing: (t: string) => t,
    }));

    const { announceVideos } = await import('../index.js');
    return { announceVideos, postText };
}

describe('the video loop', () => {
    // stubEnv rather than reassigning process.env: vitest restores these after
    // each test (unstubEnvs), and a replaced process.env is a plain object.
    beforeEach(() => {
        vi.resetModules();
        vi.stubEnv('YOUTUBE_CHANNEL_DISCORD_ID', 'chan');
        vi.stubEnv('YOUTUBE_CHANNEL_ID', 'yt');
    });
    afterEach(() => {
        vi.doUnmock('../github.js');
        vi.doUnmock('../summarize.js');
        vi.doUnmock('../youtube.js');
        vi.doUnmock('../discord.js');
        vi.resetModules();
    });

    it('still posts videos when OPENAI_API_KEY is missing', async () => {
        // Set before the harness imports index.js: SOURCES reads the channel
        // ids at module load, so setting them afterwards is too late.
        vi.stubEnv('OPENAI_API_KEY', '');
        vi.stubEnv('CPK_CHANNEL_ID', 'releases');
        // Two, because the harness seeds the first as already announced.
        const { postText } = await videoHarness(2);
        const { main } = await import('../index.js');

        // Videos need no model, and running them first is deliberate. A preflight
        // that threw on the missing key before this point reintroduced exactly
        // the failure that ordering exists to prevent, and more completely:
        // announceVideos was never entered at all.
        await expect(main()).rejects.toThrow(/OPENAI_API_KEY/);
        expect(postText).toHaveBeenCalledTimes(1);
    });

    it('warns about the backlog it defers instead of truncating silently', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { announceVideos, postText } = await videoHarness(5);

        // The release loop warns here; this one just called .slice(0, 2). That
        // made videos the one source where a backlog draining slower than it
        // grows aged out of the window with nothing in the log to predict it.
        await announceVideos(FAR_FUTURE);
        expect(postText).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('2 still pending and deferred'));
        warn.mockRestore();
    });

    it('stops posting once the run budget is spent mid-loop', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { announceVideos, postText } = await videoHarness(5);

        // Checked only on the way in, a source that started inside the budget
        // could still run past it: each postText carries up to MAX_ATTEMPTS
        // retries plus honoured retry-after waits.
        // The clock is pinned before the deadline is taken, so the first check
        // cannot fail on a slow machine; each post then moves it 10 seconds on.
        let now = Date.parse('2026-10-01T00:00:00Z');
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
        const deadline = now + 1;
        postText.mockImplementation(async () => {
            now += 10_000;
        });

        await announceVideos(deadline);
        expect(postText).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('run budget spent'));
        clock.mockRestore();
    });
});
