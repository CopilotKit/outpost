/**
 * Reading and posting, over REST.
 *
 * A gateway connection is only needed to *receive* events (slash commands,
 * reactions). Posting needs nothing but the token, so this stays a scheduled job
 * until the bot has a reason to listen.
 */

import { MAX_ATTEMPTS, MAX_RETRY_WAIT_MS, TIMEOUT_MS, backoff, parseJson, pause } from './http.js';

const API = 'https://discord.com/api/v10';

/** Discord's hard cap on a message. */
export const MESSAGE_LIMIT = 2000;

/**
 * A ceiling on pages of 100 messages read looking for this bot's own
 * announcements. Not the working limit: `since` is, and the loop normally stops
 * as soon as it has read back past it.
 *
 * This was a flat 3 pages, which silently broke the one guarantee the whole
 * dedup design rests on. The read window has to cover the announce window: a
 * release inside LOOKBACK_DAYS is a release we might post, so if we cannot see
 * whether we already posted it, we post it again. At 300 messages those two
 * windows were unrelated numbers, and more than 300 messages arriving in a
 * channel between one announcement and the next re-announced it - every run,
 * for as long as it stayed in the 30-day window. A quiet tag line in a shared
 * channel needs only about a dozen messages a day to get there, and `foundOwn`
 * is scoped per line, so each line has to be seen for itself.
 */
const HISTORY_PAGES = 30;

function auth() {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) throw new Error('DISCORD_BOT_TOKEN is not set');
    return {
        Authorization: `Bot ${token}`,
        'User-Agent': 'DiscordBot (https://github.com/CopilotKit/outpost, 1.0)',
    };
}

let botIdPromise: Promise<string> | undefined;

function selfId(): Promise<string> {
    botIdPromise ??= (async () => {
        // Through request() so this read gets the same retries as the others; a
        // single 429 here used to fail whichever source reached it first.
        const res = await request('/users/@me', { method: 'GET' });
        if (!res.ok) throw new Error(`Discord ${res.status} reading own identity`);
        return (await parseJson<{ id: string }>(res, 'Discord')).id;
    })().catch((error) => {
        botIdPromise = undefined;
        throw error;
    });
    return botIdPromise;
}

type DiscordMessage = {
    id: string;
    timestamp?: string;
    author?: { id: string };
    content?: string;
};

export type Announced = {
    /**
     * Source URLs this bot has already announced here, **lowercased**.
     *
     * Normalised on the way in because the prefix test that decides `foundOwn`
     * is case-insensitive, and a repo rename that only changes casing would
     * otherwise make every past announcement stop matching. Every consumer must
     * lowercase before looking up - a `Set<string>` cannot express that.
     */
    urls: Set<string>;
    /**
     * False when this source has never posted here.
     *
     * Scoped to the source, not to the bot. Two sources share one channel by
     * default, so "has this bot posted here" answered yes for a brand-new
     * source the moment any other source had posted - which skipped the
     * announce-only-the-newest guard and drained a 30-day backlog into a live
     * channel.
     */
    foundOwn: boolean;
    /**
     * Timestamp of the oldest message read, which bounds how far back we looked.
     *
     * Undefined means the bound is unknown, not that nothing was read: Discord's
     * `timestamp` is optional, and a bound we cannot stand behind is worse than
     * none, because `pending()` treats everything older than it as announced.
     */
    searchedFrom?: string;
};

/**
 * What this bot has already announced in a channel.
 *
 * The channel is the record, rather than a state file: nothing to commit,
 * nothing to migrate when the repo moves, and no way for the file and reality to
 * drift apart. Each announcement ends with its source URL, so that URL is the
 * identity we match on.
 *
 * Only that trailing URL counts. Discord's auto-generated preview embeds are
 * deliberately ignored: it unfurls every link in a message, including ones the
 * model wrote into the summary, and reading those back re-introduced the bug
 * `sourceUrlOf` exists to prevent.
 *
 * Paginating matters: with a single page, a channel where people actually talk
 * pushed the bot's last announcement out of the window, which read as "never
 * posted here" and re-announced the latest release.
 */
export async function announced(
    channelId: string,
    /** Recognises a source URL as this source's own. Omitted means any URL counts. */
    belongsHere: (url: string) => boolean = () => true,
    /**
     * How far back the caller might announce. Reading stops once history reaches
     * past this, because everything older is out of the announce window anyway.
     * Omitted falls back to the page ceiling alone, which is the old behaviour.
     */
    since?: string,
): Promise<Announced> {
    const me = await selfId();
    const urls = new Set<string>();
    let foundOwn = false;
    let searchedFrom: string | undefined;
    let before: string | undefined;
    let examined = 0;
    let coveredWindow = false;

    for (let page = 0; page < HISTORY_PAGES; page++) {
        const query = new URLSearchParams({ limit: '100' });
        if (before) query.set('before', before);

        const res = await request(`/channels/${channelId}/messages?${query}`, { method: 'GET' });

        // Drained on both throw paths: an unread body holds its connection out
        // of undici's pool until garbage collection.
        if (res.status === 403) {
            await res.text();
            throw new Error(
                `Discord 403 reading ${channelId}. The bot needs View Channel here. ` +
                    'A missing Read Message History does not 403, it returns an empty ' +
                    'list, so check that separately.',
            );
        }
        if (!res.ok) {
            throw new Error(
                `Discord ${res.status} reading ${channelId}: ${(await res.text()).slice(0, 200)}`,
            );
        }

        const batch = await parseJson<DiscordMessage[]>(res, 'Discord');
        if (!batch.length) {
            // End of history, same as a short page below.
            coveredWindow = true;
            break;
        }
        examined += batch.length;

        for (const message of batch) {
            if (message.author?.id !== me) continue;
            const trailing = sourceUrlOf(message.content ?? '');
            if (!trailing) continue;
            urls.add(trailing.toLowerCase());
            if (belongsHere(trailing)) foundOwn = true;
        }

        const oldest = batch[batch.length - 1];
        searchedFrom = narrowBound(searchedFrom, oldest?.timestamp);
        before = oldest?.id;
        if (batch.length < 100) {
            // The end of the channel's history, so the window is covered by
            // definition and nothing older exists to have announced.
            coveredWindow = true;
            break;
        }

        // Read back past the announce window and stop. This is the normal exit,
        // and on a quiet release channel it costs the same one or two pages the
        // flat limit did. Only a busy channel pays for more, which is exactly
        // the case where three pages was not enough.
        const floor = since ? Date.parse(since) : NaN;
        if (Number.isFinite(floor) && searchedFrom && Date.parse(searchedFrom) <= floor) {
            coveredWindow = true;
            break;
        }
    }

    if (!coveredWindow) {
        // Hit the ceiling with the window still not covered. Everything below is
        // now a guess: an announcement of ours could be sitting just past the
        // last page read, and treating the channel as new would re-post it.
        console.warn(
            `${channelId}: read ${examined} messages without reaching back to ${since}. ` +
                'Announcements older than that are invisible to this run, so something ' +
                'already posted may be posted again. Raise HISTORY_PAGES if this persists.',
        );
    }

    if (!foundOwn) {
        // The count is what was actually read, not HISTORY_PAGES * 100: the loop
        // stops early on a short page, so the claim was routinely off by
        // hundreds. This warning is the one signal that the channel is about to
        // be treated as brand new - which flips pending() to its
        // announce-only-the-newest branch - so an inflated depth hides the real
        // cause, a window too shallow to reach the bot's last post.
        //
        // Zero read is called out separately because it has a likely cause that
        // is invisible otherwise. Discord answers the history read with an empty
        // list, not a 403, when the bot lacks Read Message History - so the bot
        // cannot see its own posts, decides the channel is new on every run, and
        // re-announces the newest release every run for ever. Nothing fails, so
        // this log line is the only place that shows up.
        console.warn(
            examined === 0
                ? `${channelId}: read 0 messages, so treating the channel as new for this ` +
                      'source. If this repeats, the bot is probably missing Read Message ' +
                      'History here: Discord returns an empty list rather than an error, and ' +
                      'the newest release will be re-announced on every run.'
                : `${channelId}: nothing from this source in the last ${examined} messages read; ` +
                      'treating the channel as new for it.',
        );
    }

    return { urls, foundOwn, searchedFrom };
}

/**
 * How far back we can honestly claim to have read, after one more page.
 *
 * Discord returns messages newest-first and each page reaches further back, so
 * the bound may only ever move backwards in time. Taking the new page's oldest
 * message unconditionally was the bug: `timestamp` is optional, so a page whose
 * last message arrived without one left the bound sitting on a NEWER page's
 * value while we had in fact already read past it. `pending()` uses that value
 * as its floor and assumes everything older was announced, so every release
 * published between the true floor and the stale value was silently dropped and
 * never posted.
 *
 * A missing or unparseable timestamp keeps the previous bound rather than
 * erasing it. Erasing it was justified as the safe direction - "undefined sends
 * `pending()` down its safe `dated.slice(-1)` branch, which under-announces at
 * worst" - and that premise is wrong in a way worth spelling out, because it
 * reads as obviously true. `dated.slice(-1)` announces ONLY the newest item.
 * Announcing it moves the watermark, so on the next run every older pending item
 * sits below the watermark and is dropped. Under-announcing here IS permanent
 * loss, and it is the larger loss of the two: erasing costs the whole backlog
 * but its newest item, while a stale bound costs only what falls between the
 * true depth and that bound. Keeping `previous` strictly dominates.
 */
function narrowBound(previous: string | undefined, oldest: string | undefined): string | undefined {
    const at = oldest ? Date.parse(oldest) : NaN;
    if (Number.isNaN(at)) return previous;

    const before = previous ? Date.parse(previous) : NaN;
    return Number.isNaN(before) || at < before ? oldest : previous;
}

/**
 * The source URL of an announcement, which is its last line.
 *
 * Only the trailing URL counts. Harvesting every link in the message swept up
 * URLs the model wrote into the summary, and a summary that mentioned another
 * release marked that release as already announced.
 */
export function sourceUrlOf(content: string): string | undefined {
    const lastLine = content.trimEnd().split('\n').pop() ?? '';
    const match = lastLine.trim().match(/^<?(https?:\/\/[^\s>]+)>?$/);
    return match?.[1];
}

export type Announcement = {
    channelId: string;
    /** Bold first line. */
    title: string;
    /** The summary. Trimmed if the message would not otherwise fit. */
    body: string;
    /** Ends the message, and is the dedup identity, so it always survives. */
    url: string;
    /** Role id to ping. Omitted means the post is silent. */
    pingRoleId?: string;
};

/**
 * Assembles a message that fits Discord's limit with the source URL intact.
 *
 * The budget lives here rather than in the caller because the role mention is
 * added here: the caller used to budget to exactly 2000 characters, then this
 * function prepended a ~24-character mention and truncated the overflow off the
 * end, taking the trailing URL with it. A release whose URL was cut looked
 * unannounced forever and was re-posted on every run.
 */
export function compose({ title, body, url, pingRoleId }: Omit<Announcement, 'channelId'>): string {
    const prefix = pingRoleId ? `${withPing('', pingRoleId)}` : '';

    // Angle brackets suppress Discord's link preview. Unsuppressed, the card
    // under every announcement showed the raw release notes - AG-UI's package
    // table, CopilotKit's one-line body - which is the thing this bot exists to
    // replace, sitting directly beneath the replacement.
    //
    // Videos go out through postText with a bare link on purpose: there the
    // preview is a player, and it is better than anything we could assemble.
    //
    // sourceUrlOf reads the bracketed form, so the dedup key is unchanged.
    const urlPart = `\n\n<${url}>`;

    // Sacrifice order, most expendable first: the body, then the title. The URL
    // is never sacrificed, because losing it means the announcement can never be
    // recognised again and gets re-posted forever.
    const titleRoom = MESSAGE_LIMIT - prefix.length - urlPart.length - '****'.length;
    const shownTitle = title.length <= titleRoom ? title : truncate(title, titleRoom);
    const head = shownTitle ? `${prefix}**${shownTitle}**` : prefix.trimEnd();

    const left = MESSAGE_LIMIT - head.length - urlPart.length;

    return head + section(body, left) + urlPart;
}

/** A `\n\n`-separated section, trimmed to what is left, or nothing if it cannot fit. */
function section(text: string, room: number): string {
    const available = room - '\n\n'.length;
    if (!text || available <= 1) return '';
    return `\n\n${text.length <= available ? text : truncate(text, available)}`;
}

/** Trims to `max` characters including the ellipsis, without splitting a surrogate pair. */
function truncate(text: string, max: number): string {
    if (max <= 1) return '';
    let end = max - 1;
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1; // don't leave a lone high surrogate
    return `${text.slice(0, end).trimEnd()}…`;
}

export async function announce(announcement: Announcement) {
    const content = compose(announcement);
    await send(announcement.channelId, content, announcement.pingRoleId);
}

/** A plain message. Used for videos, where Discord's own unfurl is the preview. */
export async function postText(channelId: string, content: string, pingRoleId?: string) {
    await send(channelId, withPing(content, pingRoleId), pingRoleId);
}

/**
 * The role mention, in one place.
 *
 * Two sites used to build this independently, and the mention being applied
 * outside a caller's character budget is what sheared the trailing URL off
 * announcements.
 */
export function withPing(content: string, pingRoleId?: string): string {
    return pingRoleId ? `<@&${pingRoleId}> ${content}` : content;
}

/**
 * A stable per-message id, sent as Discord's `nonce`.
 *
 * Correlation only, not a dedup guarantee - Discord ignores a repeated nonce
 * unless the create payload also carries `enforce_nonce`, which `send`
 * deliberately omits. The reasoning is at the call site.
 */
function nonceFor(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) hash = (hash * 31 + content.charCodeAt(i)) | 0;
    return `rb-${(hash >>> 0).toString(36)}`;
}

async function send(channelId: string, content: string, pingRoleId?: string) {
    // A message over the limit would be truncated from the end, which is where
    // the dedup URL lives. Refusing is safer than posting an announcement that
    // can never be recognised again.
    if (content.length > MESSAGE_LIMIT) {
        throw new Error(
            `Message for ${channelId} is ${content.length} characters, over Discord's ${MESSAGE_LIMIT}.`,
        );
    }

    const res = await request(`/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            // Sent for correlation, and `enforce_nonce` is deliberately NOT set
            // with it, so this is not doing any de-duplication. Discord only
            // de-duplicates by nonce when `enforce_nonce: true` accompanies it,
            // and turning that on here would buy nothing while risking a silent
            // loss. Nothing to buy: `request()` retries a POST on 429 alone, and
            // a 429 is rejected before the message is created, so no retry can
            // land a duplicate in the first place. The risk: `nonceFor` is a
            // 32-bit rolling hash, and under enforcement a collision with
            // anything posted to the channel inside Discord's dedup window would
            // make Discord answer with the older message instead of creating
            // this one - a genuinely different release would never appear, and
            // the call would still look like it succeeded. A release announced
            // twice is a nuisance; a release that never posts is the failure
            // this whole module exists to prevent.
            nonce: nonceFor(content),
            content,
            // `parse: []` on both paths. The body is model-written text derived
            // from release notes, so an @everyone in a summary must be
            // structurally impossible rather than left to an API default.
            allowed_mentions: { parse: [], roles: pingRoleId ? [pingRoleId] : [] },
        }),
    });

    if (!res.ok) {
        throw new Error(`Discord ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
}

/**
 * One request, with bounded retries.
 *
 * Reads are retried as well as writes: a rate limit while reading the channel
 * used to abort the whole run, taking the other sources with it.
 *
 * What is retried differs by method. A 429 is safe everywhere, because a
 * rate-limited request never executed. A 5xx is only retried on reads: Discord
 * can accept a message and then fail the response, so retrying a POST risks
 * announcing the same release twice, which is worse than failing the run.
 * Thrown errors (timeout, reset) follow the same rule.
 */
async function request(path: string, init: RequestInit): Promise<Response> {
    const isRead = (init.method ?? 'GET') === 'GET';

    // Outside the loop, for the same reason `gh()` hoists its headers: a config
    // error is not a bad network. Called inside the try, a missing
    // DISCORD_BOT_TOKEN was caught by the network-error branch and slept over,
    // 1s then 2s on every GET, before surfacing an error no retry could fix.
    const authHeaders = auth();

    for (let attempt = 1; ; attempt++) {
        const last = attempt >= MAX_ATTEMPTS;

        let res: Response;
        try {
            res = await fetch(`${API}${path}`, {
                ...init,
                headers: { ...authHeaders, ...(init.headers ?? {}) },
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
        } catch (error) {
            if (last || !isRead) throw error;
            await pause(backoff(attempt));
            continue;
        }

        const retryable = res.status === 429 || (isRead && res.status >= 500);
        if (!retryable || last) return res;

        await pause(await retryDelay(res, attempt));
    }
}

/**
 * How long to wait before retrying.
 *
 * The header is read first because a Cloudflare-level 429 returns HTML, and
 * parsing that body as JSON threw a SyntaxError that surfaced as
 * "Unexpected token '<'" with nothing to say it was a rate limit.
 */
async function retryDelay(res: Response, attempt: number): Promise<number> {
    const header = Number(res.headers.get('retry-after'));
    if (Number.isFinite(header) && header > 0) {
        // Cancelled explicitly: this path returns without reading the body, and
        // under undici an unread body holds its connection out of the pool
        // until garbage collection.
        void res.body?.cancel().catch(() => {});
        return Math.min(header * 1000 + 100, MAX_RETRY_WAIT_MS);
    }

    const body = await res.text().catch(() => '');
    try {
        const parsed = JSON.parse(body) as { retry_after?: number };
        // Finite and positive, matching the header path six lines up. `typeof
        // x === 'number'` admits NaN and negatives, and setTimeout fires on the
        // next tick for both - turning the backoff into an immediate hammer at
        // a live rate limit.
        if (Number.isFinite(parsed.retry_after) && (parsed.retry_after ?? 0) > 0) {
            return Math.min((parsed.retry_after ?? 0) * 1000 + 100, MAX_RETRY_WAIT_MS);
        }
    } catch {
        // Not JSON, which is itself the signal that this is an edge rate limit.
    }

    return backoff(attempt);
}
