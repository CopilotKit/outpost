/**
 * YouTube source.
 *
 * The channel's public RSS feed says what exists: the latest 15 videos, which is
 * plenty for a job that runs on a schedule. It cannot say whether a video can be
 * watched yet. A scheduled live stream is in the feed from the moment it is
 * scheduled, with `<published>` set to that moment, so the feed alone announces
 * a stream days before it airs. One YouTube Data API call per run answers that.
 *
 * YOUTUBE_API_KEY is optional for that reason. A channel that never schedules
 * streams loses nothing without it. A channel that does gets its streams posted
 * when they are scheduled rather than when they go live, and every run says so.
 */

import { MAX_ATTEMPTS, TIMEOUT_MS, backoff, parseJson, pause, retryAfterMs } from './http.js';

const FEED = 'https://www.youtube.com/feeds/videos.xml?channel_id=';
const API = 'https://www.googleapis.com/youtube/v3/videos';

export type Video = {
    id: string;
    url: string;
    publishedAt: string;
};

export async function listVideos(channelId: string, since: string): Promise<Video[]> {
    const xml = await get(`${FEED}${channelId}`, `YouTube feed for channel ${channelId}`);
    const parsed = parseFeed(xml);

    // Both checks run on what the feed itself says, before the API narrows it.
    // Run on the narrowed list, a feed whose entries were all scheduled streams
    // came back empty and was reported as a broken parser.
    if (!parsed.length) {
        // The feed is XML scraped with regexes, so an empty result is as likely
        // to be a feed-shape change as a genuinely empty channel. The two are
        // distinguishable: a body that carries `<entry` and still parses to
        // nothing is a broken parser, not an empty channel. Warning about that
        // let the run exit 0 and the cron report success while video
        // announcements were dead, so it throws and joins main()'s failure list.
        if (xml.includes('<entry')) {
            throw new Error(
                `${channelId}: the YouTube feed carries entries but parseFeed read none of them. ` +
                    'Video announcements are stopped until parseFeed is updated to the feed format.',
            );
        }
        console.warn(`${channelId}: no entries parsed from the YouTube feed`);
    }
    for (const v of parsed) {
        // A date-format change parses entries fine, then NaN-compares every one
        // of them to false below and drops the lot with no output - the
        // silent-death case the guard above exists to prevent, one step later.
        if (Number.isNaN(Date.parse(v.publishedAt))) {
            throw new Error(
                `${channelId}: unparseable <published> "${v.publishedAt}" on ${v.id}. ` +
                    'The feed format changed; parseFeed needs updating.',
            );
        }
    }

    // Without a key the feed is taken as it is. Uploads are unaffected; a
    // scheduled stream is posted when it is scheduled rather than when it goes
    // live. Warned on every run, because that is a choice someone should be
    // reminded they made, not a failure.
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) {
        console.warn(
            'youtube: YOUTUBE_API_KEY is not set, so scheduled live streams are posted when ' +
                'they are scheduled rather than when they go live.',
        );
    }
    const videos = apiKey ? await whenWatchable(parsed, apiKey) : parsed;

    const start = Date.parse(since);
    const now = Date.now();

    return videos
        .filter((v) => {
            const at = Date.parse(v.publishedAt);
            // With a key, upcoming streams are already gone by this point. A
            // future date can still arrive without one, or from an edited
            // upload, and it is not watchable yet either way.
            return at > start && at <= now;
        })
        .sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
}

/**
 * How long a video the API does not return is treated as not indexed yet,
 * rather than gone. New uploads appear in the API within minutes; six hours is
 * a wide margin that still unblocks newer videos the same day.
 */
const INDEX_GRACE_MS = 6 * 60 * 60_000;

type ApiVideo = {
    id: string;
    snippet?: { liveBroadcastContent?: string };
    liveStreamingDetails?: { actualStartTime?: string };
};

/**
 * Drops streams that have not started, and dates every stream by when it
 * actually went live rather than by when it was scheduled.
 *
 * The second half matters as much as the first. A stream scheduled on the 1st
 * for the 8th carries `<published>` of the 1st. If a regular video goes out on
 * the 5th, it is announced, and by the time the stream airs its date is older
 * than something already announced - so it reads as handled and is never
 * posted. Dated by `actualStartTime` it lands after the video, where it belongs.
 * Every video in the feed goes through this, not only the pending ones, so a
 * stream's date is the same on every run and the comparison stays consistent.
 *
 * One request for the whole feed: the API takes up to 50 ids and costs one
 * quota unit, against a free allowance of 10,000 a day.
 */
async function whenWatchable(videos: Video[], apiKey: string): Promise<Video[]> {
    if (!videos.length) return videos;

    const query = new URLSearchParams({
        part: 'snippet,liveStreamingDetails',
        id: videos.map((v) => v.id).join(','),
        key: apiKey,
    });
    const body = await get(`${API}?${query}`, 'YouTube API videos.list');
    const { items } = await parseJson<{ items?: ApiVideo[] }>(new Response(body), 'YouTube API');
    // A successful reply always carries `items`, empty or not. Without it the
    // reply is not the shape this reads, and treating that as "none of these
    // exist" would drop every video, so it fails the run instead.
    if (!Array.isArray(items)) {
        throw new Error(
            'YouTube API videos.list returned no items list. The response shape changed.',
        );
    }
    const details = new Map(items.map((item) => [item.id, item]));

    // A video the API does not return is usually too new to be indexed yet. It
    // is held for the next run rather than posted on the feed's date, because
    // that date is exactly what is wrong for a scheduled stream.
    //
    // Everything dated at or after it is held too. Posting a newer video now
    // would put it above the held one, and on the next run the held one would
    // read as already handled and never go out. Holding the tail keeps the
    // order.
    //
    // Only for a few hours, though. Indexing takes minutes, so a video still
    // missing after INDEX_GRACE_MS is not lagging: it was deleted or made
    // private while the feed still lists it. Holding the tail behind that
    // would block every newer video until it left the feed, long enough for
    // them to age out of the window and be lost. Those are dropped on their
    // own instead.
    const now = Date.now();
    const missing = videos.filter((video) => !details.has(video.id));
    const lagging = missing.filter((video) => now - Date.parse(video.publishedAt) < INDEX_GRACE_MS);
    for (const video of missing) {
        console.warn(
            lagging.includes(video)
                ? `youtube ${video.id}: not returned by the API yet, will retry next run`
                : `youtube ${video.id}: still not returned by the API, probably deleted or private, skipped`,
        );
    }
    const holdFrom = lagging.length
        ? Math.min(...lagging.map((video) => Date.parse(video.publishedAt)))
        : Infinity;

    return videos.flatMap((video) => {
        const detail = details.get(video.id);
        if (!detail) return [];
        if (detail.snippet?.liveBroadcastContent === 'upcoming') {
            console.log(`youtube ${video.id}: scheduled stream, not live yet, skipped`);
            return [];
        }
        const started = detail.liveStreamingDetails?.actualStartTime;
        if (started && Number.isNaN(Date.parse(started))) {
            throw new Error(
                `youtube ${video.id}: the API returned an unparseable actualStartTime "${started}".`,
            );
        }
        const dated = started ? { ...video, publishedAt: started } : video;
        if (Date.parse(dated.publishedAt) >= holdFrom) {
            console.log(`youtube ${video.id}: held behind a video the API has not indexed yet`);
            return [];
        }
        return [dated];
    });
}

/**
 * A GET with bounded retries, returning the body as text.
 *
 * Retried for the same reason the GitHub and Discord reads are, and with the
 * same shape: a plain idempotent GET, so a transient 502 or a socket reset costs
 * nothing to repeat, while failing it took the YouTube source down and pushed
 * the whole run's exit code to 1. A 4xx other than a rate limit is not retried:
 * a mistyped channel id or a bad API key answers the same way every time.
 *
 * `what` names the call in errors. The URL is never put in a message, because
 * the API's carries the key.
 */
async function get(url: string, what: string): Promise<string> {
    for (let attempt = 1; ; attempt++) {
        const last = attempt >= MAX_ATTEMPTS;

        let res: Response;
        try {
            res = await fetch(url, {
                headers: { 'User-Agent': 'copilotkit-release-bot' },
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
        } catch (error) {
            if (last) throw error;
            await pause(backoff(attempt));
            continue;
        }

        if (res.ok) return res.text();

        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && !last) {
            await pause(retryAfterMs(res) ?? backoff(attempt));
            continue;
        }

        // Read the body even though only the status is interesting: under undici
        // an unread body holds its connection out of the pool until garbage
        // collection, and this is the one path that neither returns res.text()
        // nor passes through retryAfterMs().
        throw new Error(`${what}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
}

/** Exported for tests: the feed format is the part most likely to drift. */
export function parseFeed(xml: string): Video[] {
    // `<entry` rather than `<entry>`, so an added namespace attribute does not
    // silently yield zero videos.
    return xml
        .split(/<entry[\s>]/)
        .slice(1)
        .map((entry) => {
            const id = tag(entry, 'yt:videoId');
            return {
                id,
                url: `https://www.youtube.com/watch?v=${id}`,
                publishedAt: tag(entry, 'published'),
            };
        })
        .filter((v) => v.id && v.publishedAt);
}

function tag(xml: string, name: string): string {
    const match = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
    return match ? match[1].trim() : '';
}
