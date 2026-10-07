import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listVideos, parseFeed } from '../youtube.js';
import { pending } from '../watermark.js';

const entry = (id: string, published: string, attrs = '') => `
  <entry${attrs}>
    <yt:videoId>${id}</yt:videoId>
    <title>A video</title>
    <published>${published}</published>
  </entry>`;

describe('parseFeed', () => {
    it('reads video ids and timestamps', () => {
        const videos = parseFeed(
            `<feed>${entry('abc123', '2026-09-11T19:33:39+00:00')}${entry('def456', '2026-09-10T16:23:21+00:00')}</feed>`,
        );

        expect(videos).toEqual([
            {
                id: 'abc123',
                url: 'https://www.youtube.com/watch?v=abc123',
                publishedAt: '2026-09-11T19:33:39+00:00',
            },
            {
                id: 'def456',
                url: 'https://www.youtube.com/watch?v=def456',
                publishedAt: '2026-09-10T16:23:21+00:00',
            },
        ]);
    });

    it('still parses entries that carry attributes', () => {
        // Splitting on the literal `<entry>` returned nothing the moment the
        // feed added an attribute to <entry>, which read as an empty channel.
        const videos = parseFeed(
            `<feed>${entry('abc123', '2026-09-11T19:33:39+00:00', ' xml:lang="en"')}</feed>`,
        );
        expect(videos.map((v) => v.id)).toEqual(['abc123']);
    });

    it('drops entries with no id or timestamp', () => {
        expect(parseFeed('<feed><entry><title>broken</title></entry></feed>')).toEqual([]);
    });

    it('returns nothing for an empty feed', () => {
        expect(parseFeed('<feed></feed>')).toEqual([]);
    });
});

const ORIGINAL_FETCH = globalThis.fetch;

const API_KEY = 'test-api-key';
beforeEach(() => {
    vi.stubEnv('YOUTUBE_API_KEY', API_KEY);
});

/** Every YouTube API URL requested since the last stubFetch. */
const apiCalls: string[] = [];

/**
 * Stubs fetch for the feed and answers the YouTube API call separately, so a
 * feed mock's call count stays about the feed. Every id comes back as an
 * ordinary upload unless `api` says otherwise; `'missing'` leaves it out.
 */
function stubFetch(
    feedFetch: (...args: never[]) => unknown,
    api: Record<string, object | 'missing'> = {},
) {
    apiCalls.length = 0;
    const forward = feedFetch as unknown as (input: string | URL, init?: RequestInit) => unknown;
    vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (!url.startsWith('https://www.googleapis.com/')) return forward(input, init);
        apiCalls.push(url);
        const ids = new URL(url).searchParams.get('id')?.split(',') ?? [];
        return Promise.resolve(
            Response.json({
                items: ids
                    .filter((id) => api[id] !== 'missing')
                    .map((id) => ({
                        id,
                        snippet: { liveBroadcastContent: 'none' },
                        ...(api[id] as object | undefined),
                    })),
            }),
        );
    });
}

afterEach(() => {
    vi.stubGlobal('fetch', ORIGINAL_FETCH);
    vi.useRealTimers();
});

const feed = (body: string) => new Response(body, { status: 200 });

describe('listVideos', () => {
    const SINCE = '2026-09-01T00:00:00.000Z';

    it('fails when the feed carries entries but none of them parse', async () => {
        // A feed-shape change parses as zero videos, and warning about it let
        // the run exit 0 while video announcements were dead.
        stubFetch(vi.fn(async () => feed('<feed><entry><title>broken</title></entry></feed>')));

        await expect(listVideos('chan', SINCE)).rejects.toThrow(/parseFeed/);
        await expect(listVideos('chan', SINCE)).rejects.toThrow(/announcements are stopped/);
    });

    it('only warns when the channel is genuinely empty', async () => {
        // A body with no `<entry` at all is a channel that has published
        // nothing, which is not a failure and must not fail the run.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        stubFetch(vi.fn(async () => feed('<feed></feed>')));

        await expect(listVideos('chan', SINCE)).resolves.toEqual([]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('no entries parsed'));
    });

    it('retries a transient 5xx rather than failing the source', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));

        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(new Response('upstream error', { status: 503 }))
            .mockResolvedValueOnce(
                feed(`<feed>${entry('abc123', '2026-09-11T19:33:39+00:00')}</feed>`),
            );
        stubFetch(fetchMock);

        const videos = listVideos('chan', SINCE);
        await vi.advanceTimersByTimeAsync(5_000);

        await expect(videos).resolves.toEqual([
            {
                id: 'abc123',
                url: 'https://www.youtube.com/watch?v=abc123',
                publishedAt: '2026-09-11T19:33:39+00:00',
            },
        ]);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries a dropped connection', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));

        const fetchMock = vi
            .fn()
            .mockRejectedValueOnce(new Error('socket hang up'))
            .mockResolvedValueOnce(
                feed(`<feed>${entry('abc123', '2026-09-11T19:33:39+00:00')}</feed>`),
            );
        stubFetch(fetchMock);

        const videos = listVideos('chan', SINCE);
        await vi.advanceTimersByTimeAsync(5_000);

        expect((await videos).map((v) => v.id)).toEqual(['abc123']);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not retry a response that will never succeed', async () => {
        // A deleted or mistyped channel id is a 404 every time, and retrying it
        // only delays the failure the run needs to report.
        const fetchMock = vi.fn(async () => new Response('not found', { status: 404 }));
        stubFetch(fetchMock);

        await expect(listVideos('chan', SINCE)).rejects.toThrow(/404/);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

describe('listVideos filtering and order', () => {
    const feed = (entries: { id: string; published: string }[]) =>
        `<feed>${entries
            .map(
                (e) =>
                    `<entry><yt:videoId>${e.id}</yt:videoId><published>${e.published}</published></entry>`,
            )
            .join('')}</feed>`;

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    function serving(xml: string) {
        stubFetch(() => Promise.resolve(new Response(xml)));
    }

    it('does not announce a video dated in the future', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
        serving(
            feed([
                { id: 'aired', published: '2026-09-19T00:00:00Z' },
                { id: 'upcoming', published: '2026-09-25T00:00:00Z' },
            ]),
        );
        // Not how scheduled streams look (that is the API check below), but an
        // edited upload can carry one, and it is not watchable yet either.
        const videos = await listVideos('chan', '2026-09-01T00:00:00Z');
        expect(videos.map((v) => v.id)).toEqual(['aired']);
    });

    it('drops anything older than the lookback window', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
        serving(
            feed([
                { id: 'stale', published: '2026-08-01T00:00:00Z' },
                { id: 'fresh', published: '2026-09-15T00:00:00Z' },
            ]),
        );
        const videos = await listVideos('chan', '2026-09-01T00:00:00Z');
        expect(videos.map((v) => v.id)).toEqual(['fresh']);
    });

    it('returns oldest first, which is how the watermark advances one step', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
        serving(
            feed([
                { id: 'newer', published: '2026-09-15T00:00:00Z' },
                { id: 'older', published: '2026-09-05T00:00:00Z' },
            ]),
        );
        // announceVideos slices MAX_PER_RUN off the front, so newest-first would
        // move the watermark to the top and strand everything between.
        const videos = await listVideos('chan', '2026-09-01T00:00:00Z');
        expect(videos.map((v) => v.id)).toEqual(['older', 'newer']);
    });
});

describe('a feed whose date format changed', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('fails loudly instead of dropping every video', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
        stubFetch(() =>
            Promise.resolve(
                new Response(
                    '<feed><entry><yt:videoId>abc</yt:videoId><published>20/09/2026</published></entry></feed>',
                ),
            ),
        );

        // The entries parse, so the <entry>-present guard does not fire. Without
        // the date check every Date.parse would be NaN, both comparisons false,
        // and the whole feed dropped with no output - a green cron run and dead
        // announcements.
        await expect(listVideos('chan', '2026-09-01T00:00:00Z')).rejects.toThrow(/feed format/i);
    });
});

describe('scheduled live streams', () => {
    const xml = (entries: { id: string; published: string }[]) =>
        `<feed>${entries
            .map(
                (e) =>
                    `<entry><yt:videoId>${e.id}</yt:videoId><published>${e.published}</published></entry>`,
            )
            .join('')}</feed>`;

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('does not announce a stream that has not started', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-03T00:00:00Z'));
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        // The feed dates a scheduled stream by when it was scheduled, which is
        // already in the past, so the date check alone lets it straight through
        // and it is announced days before anyone can watch it.
        stubFetch(
            () =>
                Promise.resolve(
                    new Response(
                        xml([
                            { id: 'upload', published: '2026-10-01T00:00:00Z' },
                            { id: 'stream', published: '2026-10-02T00:00:00Z' },
                        ]),
                    ),
                ),
            { stream: { snippet: { liveBroadcastContent: 'upcoming' } } },
        );

        const videos = await listVideos('chan', '2026-09-01T00:00:00Z');
        expect(videos.map((v) => v.id)).toEqual(['upload']);
        log.mockRestore();
    });

    it('announces a stream once it is live, dated by when it started', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-09T00:00:00Z'));
        stubFetch(
            () =>
                Promise.resolve(
                    new Response(xml([{ id: 'stream', published: '2026-10-01T00:00:00Z' }])),
                ),
            {
                stream: {
                    snippet: { liveBroadcastContent: 'none' },
                    liveStreamingDetails: { actualStartTime: '2026-10-08T17:00:00Z' },
                },
            },
        );

        const videos = await listVideos('chan', '2026-09-01T00:00:00Z');
        expect(videos).toEqual([
            {
                id: 'stream',
                url: 'https://www.youtube.com/watch?v=stream',
                publishedAt: '2026-10-08T17:00:00Z',
            },
        ]);
    });

    it('still posts a stream that aired after a video already announced', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-09T00:00:00Z'));
        // Scheduled on the 1st for the 8th, with a regular upload on the 5th
        // that was announced on the 6th. On the feed's date the stream is older
        // than something already announced, reads as handled, and is never
        // posted. Skipping upcoming streams is not enough on its own.
        stubFetch(
            () =>
                Promise.resolve(
                    new Response(
                        xml([
                            { id: 'upload', published: '2026-10-05T00:00:00Z' },
                            { id: 'stream', published: '2026-10-01T00:00:00Z' },
                        ]),
                    ),
                ),
            {
                stream: {
                    snippet: { liveBroadcastContent: 'none' },
                    liveStreamingDetails: { actualStartTime: '2026-10-08T17:00:00Z' },
                },
            },
        );

        const videos = await listVideos('chan', '2026-09-01T00:00:00Z');
        const still = pending(videos, {
            urls: new Set(['https://www.youtube.com/watch?v=upload']),
            foundOwn: true,
            searchedFrom: '2026-09-01T00:00:00Z',
        });
        expect(still.map((v) => v.id)).toEqual(['stream']);
    });

    it('asks the API once for the whole feed', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-09T00:00:00Z'));
        // Every video, not only the pending ones, so a stream carries the same
        // date on every run and comparisons against it stay consistent.
        stubFetch(() =>
            Promise.resolve(
                new Response(
                    xml([
                        { id: 'a', published: '2026-10-01T00:00:00Z' },
                        { id: 'b', published: '2026-10-02T00:00:00Z' },
                        { id: 'c', published: '2026-10-03T00:00:00Z' },
                    ]),
                ),
            ),
        );

        await listVideos('chan', '2026-09-01T00:00:00Z');
        expect(apiCalls).toHaveLength(1);
        expect(new URL(apiCalls[0]!).searchParams.get('id')).toBe('a,b,c');
    });

    it('holds back a video the API has not indexed yet, for the next run', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-09T00:00:00Z'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        // Posting it on the feed's date is exactly wrong for a scheduled stream.
        // Holding it costs a run or two, until the API indexes it.
        stubFetch(
            () =>
                Promise.resolve(
                    new Response(xml([{ id: 'fresh', published: '2026-10-08T23:00:00Z' }])),
                ),
            { fresh: 'missing' },
        );

        const videos = await listVideos('chan', '2026-09-01T00:00:00Z');
        expect(videos).toEqual([]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('not returned by the API yet'));
        warn.mockRestore();
    });

    it('holds back newer videos behind one the API has not indexed', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-09T00:00:00Z'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        // Posting 'newer' now would put it above 'pending', which would then
        // read as already handled next run and never go out. 'older' is safe.
        stubFetch(
            () =>
                Promise.resolve(
                    new Response(
                        xml([
                            { id: 'older', published: '2026-10-08T20:00:00Z' },
                            { id: 'pending', published: '2026-10-08T22:00:00Z' },
                            { id: 'newer', published: '2026-10-08T23:00:00Z' },
                        ]),
                    ),
                ),
            { pending: 'missing' },
        );

        const videos = await listVideos('chan', '2026-09-01T00:00:00Z');
        expect(videos.map((v) => v.id)).toEqual(['older']);
        warn.mockRestore();
        log.mockRestore();
    });

    it('stops holding back behind a video that has been missing for hours', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-09T00:00:00Z'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        // Missing for two days is not indexing lag: it was deleted or made
        // private while the feed still lists it. Holding the tail behind it
        // blocked every newer video until it left the feed.
        stubFetch(
            () =>
                Promise.resolve(
                    new Response(
                        xml([
                            { id: 'gone', published: '2026-10-07T00:00:00Z' },
                            { id: 'newer', published: '2026-10-08T00:00:00Z' },
                        ]),
                    ),
                ),
            { gone: 'missing' },
        );

        const videos = await listVideos('chan', '2026-09-01T00:00:00Z');
        expect(videos.map((v) => v.id)).toEqual(['newer']);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('probably deleted or private'));
        warn.mockRestore();
    });

    it('fails on a start time from the API it cannot read', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-09T00:00:00Z'));
        // Taken silently, an unreadable date compares false both ways and the
        // stream drops out with nothing said.
        stubFetch(
            () =>
                Promise.resolve(
                    new Response(xml([{ id: 'stream', published: '2026-10-01T00:00:00Z' }])),
                ),
            {
                stream: {
                    snippet: { liveBroadcastContent: 'none' },
                    liveStreamingDetails: { actualStartTime: 'yesterday' },
                },
            },
        );
        await expect(listVideos('chan', '2026-09-01T00:00:00Z')).rejects.toThrow(
            /unparseable actualStartTime/,
        );
    });

    it('treats a feed of only scheduled streams as a quiet channel, not a broken parser', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-03T00:00:00Z'));
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        // The empty-feed check ran on the list after streams were removed, so
        // this threw "parseFeed read none of them" and failed the source.
        stubFetch(
            () =>
                Promise.resolve(
                    new Response(xml([{ id: 'stream', published: '2026-10-02T00:00:00Z' }])),
                ),
            { stream: { snippet: { liveBroadcastContent: 'upcoming' } } },
        );

        await expect(listVideos('chan', '2026-09-01T00:00:00Z')).resolves.toEqual([]);
        log.mockRestore();
    });

    it('announces a stream that is live right now', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-08T18:00:00Z'));
        stubFetch(
            () =>
                Promise.resolve(
                    new Response(xml([{ id: 'stream', published: '2026-10-01T00:00:00Z' }])),
                ),
            {
                stream: {
                    snippet: { liveBroadcastContent: 'live' },
                    liveStreamingDetails: { actualStartTime: '2026-10-08T17:00:00Z' },
                },
            },
        );

        const videos = await listVideos('chan', '2026-09-01T00:00:00Z');
        expect(videos.map((v) => [v.id, v.publishedAt])).toEqual([
            ['stream', '2026-10-08T17:00:00Z'],
        ]);
    });

    it('fails rather than dropping everything when the API reply has no items list', async () => {
        // Read as "none of these exist", every video would be held back for
        // ever with nothing failing.
        vi.stubGlobal('fetch', (input: string | URL) =>
            Promise.resolve(
                String(input).startsWith('https://www.googleapis.com/')
                    ? Response.json({ kind: 'youtube#videoListResponse' })
                    : new Response(xml([{ id: 'a', published: '2026-10-01T00:00:00Z' }])),
            ),
        );
        await expect(listVideos('chan', '2026-09-01T00:00:00Z')).rejects.toThrow(/no items list/);
    });

    it('falls back to the feed alone without an API key, and says so', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-03T00:00:00Z'));
        vi.stubEnv('YOUTUBE_API_KEY', '');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        // The key is optional. Without it uploads post as before and no API
        // request is made; the cost is that a scheduled stream posts when it is
        // scheduled, which is what the warning is for.
        stubFetch(
            () =>
                Promise.resolve(
                    new Response(xml([{ id: 'stream', published: '2026-10-02T00:00:00Z' }])),
                ),
            { stream: { snippet: { liveBroadcastContent: 'upcoming' } } },
        );

        const videos = await listVideos('chan', '2026-09-01T00:00:00Z');
        expect(videos.map((v) => v.id)).toEqual(['stream']);
        expect(apiCalls).toHaveLength(0);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('YOUTUBE_API_KEY is not set'));
        warn.mockRestore();
    });

    it('never puts the API key in an error message', async () => {
        // The API's URL carries the key, and errors land in Railway logs.
        vi.stubGlobal('fetch', (input: string | URL) =>
            Promise.resolve(
                String(input).startsWith('https://www.googleapis.com/')
                    ? new Response('{"error":{"message":"API key not valid"}}', { status: 400 })
                    : new Response(xml([{ id: 'a', published: '2026-10-01T00:00:00Z' }])),
            ),
        );

        const error = await listVideos('chan', '2026-09-01T00:00:00Z').catch((e: Error) => e);
        expect(String(error)).toMatch(/YouTube API videos\.list: 400/);
        expect(String(error)).not.toContain(API_KEY);
    });
});
