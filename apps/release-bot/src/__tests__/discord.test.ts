import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MESSAGE_LIMIT, compose, sourceUrlOf } from '../discord.js';

const url = 'https://github.com/CopilotKit/CopilotKit/releases/tag/v1.73.0';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_TOKEN = process.env.DISCORD_BOT_TOKEN;

afterEach(() => {
    vi.stubGlobal('fetch', ORIGINAL_FETCH);
    vi.resetModules();
    if (ORIGINAL_TOKEN === undefined) delete process.env.DISCORD_BOT_TOKEN;
    else process.env.DISCORD_BOT_TOKEN = ORIGINAL_TOKEN;
});

describe('compose', () => {
    it('keeps the message within Discord’s limit and ends with the source URL', () => {
        const content = compose({
            title: 'v1.73.0',
            body: 'a'.repeat(4000),
            url,
        });

        expect(content.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
        expect(sourceUrlOf(content)).toBe(url);
    });

    it('still ends with the source URL when a role is pinged', () => {
        // The mention is ~24 characters. Budgeting without it used to push the
        // message over the limit and truncate the URL, which is the dedup key.
        const content = compose({
            title: 'v1.73.0',
            body: 'a'.repeat(4000),
            url,
            pingRoleId: '1550206847087288480',
        });

        expect(content.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
        expect(sourceUrlOf(content)).toBe(url);
        expect(content.startsWith('<@&1550206847087288480> ')).toBe(true);
    });

    it('keeps the URL when the title alone fills the budget', () => {
        // Sacrifice order: body, then title. The URL is never sacrificed. Never the URL.
        const content = compose({
            title: 'x'.repeat(1200),
            body: 'a'.repeat(500),
            url,
        });

        expect(content.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
        expect(sourceUrlOf(content)).toBe(url);
    });

    it('keeps the URL even when the title alone exceeds the limit', () => {
        const content = compose({ title: 'x'.repeat(5000), body: 'body', url });
        expect(content.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
        expect(sourceUrlOf(content)).toBe(url);
    });

    it('leaves a short message untouched, with the link preview suppressed', () => {
        const content = compose({ title: 'v1.73.0', body: '- one thing shipped', url });
        // Bracketed: the unfurled card showed the raw release notes the summary
        // above it exists to replace. sourceUrlOf still recovers the key.
        expect(content).toBe(`**v1.73.0**\n\n- one thing shipped\n\n<${url}>`);
        expect(sourceUrlOf(content)).toBe(url);
    });

    it('does not split a surrogate pair when trimming', () => {
        const content = compose({ title: 'v1.73.0', body: '🚀'.repeat(2000), url });
        expect(content.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
        // A lone high surrogate would be an unpaired code unit in the output.
        expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(content)).toBe(false);
    });
});

describe('sourceUrlOf', () => {
    it('reads the trailing URL', () => {
        expect(sourceUrlOf(`**v1.73.0**\n\n- shipped\n\n${url}`)).toBe(url);
    });

    it('ignores links inside the summary body', () => {
        // The summary is model-written and may mention other releases. Treating
        // those as announced would silently suppress them later.
        const content = `**v1.73.0**\n\nsee https://github.com/CopilotKit/CopilotKit/releases/tag/v1.72.0\n\n${url}`;
        expect(sourceUrlOf(content)).toBe(url);
    });

    it('returns nothing when the message does not end in a URL', () => {
        expect(sourceUrlOf('just a chat message')).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// announced() - the channel-read path, which is the whole dedup mechanism.
// Every case stubs fetch. Nothing here waits in real time: the cases that reach
// the retry loop drive it with fake timers rather than sleeping through it.
// ---------------------------------------------------------------------------

const BOT = '900000000000000001';
const HUMAN = '900000000000000002';

type StubMessage = {
    id: string;
    timestamp?: string;
    author?: { id: string };
    content?: string;
};

/** A message `n` steps back in history, so a higher `n` is always older. */
const at = (n: number) =>
    new Date(Date.parse('2026-09-22T12:00:00.000Z') - n * 60_000).toISOString();

/** A page of other people's messages, newest first, starting `from` steps back. */
function chatter(count: number, from: number): StubMessage[] {
    return Array.from({ length: count }, (_, i) => ({
        id: String(1000 + from + i),
        timestamp: at(from + i),
        author: { id: HUMAN },
        content: 'chatter',
    }));
}

/** One of this bot's own announcements, in the slot `from` steps back. */
function mine(from: number, sourceUrl: string): StubMessage {
    return {
        id: String(1000 + from),
        timestamp: at(from),
        author: { id: BOT },
        content: `**v1.73.0**\n\n- shipped\n\n${sourceUrl}`,
    };
}

/** Serves `/users/@me`, then the given pages in order, recording every URL. */
function stubDiscord(pages: StubMessage[][]) {
    const calls: string[] = [];
    let next = 0;
    vi.stubGlobal('fetch', (input: string | URL) => {
        const requested = String(input);
        calls.push(requested);
        const body = requested.includes('/users/@me') ? { id: BOT } : (pages[next++] ?? []);
        return Promise.resolve(
            new Response(JSON.stringify(body), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        );
    });
    return calls;
}

/** `selfId()` memoizes for the process, so each case needs a fresh module. */
async function freshDiscord() {
    vi.resetModules();
    return import('../discord.js');
}

const reads = (calls: string[]) => calls.filter((c) => c.includes('/channels/'));

/** Replaces the oldest message of a page, keeping the rest of the page intact. */
function withOldest(page: StubMessage[], change: Partial<StubMessage>): StubMessage[] {
    const copy = [...page];
    copy[copy.length - 1] = { ...copy[copy.length - 1]!, ...change };
    return copy;
}

describe('announced', () => {
    beforeEach(() => {
        process.env.DISCORD_BOT_TOKEN = 'test';
    });

    it('pages backwards with the before cursor and collects URLs from every page', async () => {
        // A single page let a busy channel push the bot's last announcement out
        // of the window, which read as "never posted here" and re-announced.
        const first = withOldest(chatter(100, 0), mine(99, 'https://example.com/a'));
        const third = withOldest(chatter(100, 200), mine(299, 'https://example.com/b'));

        const calls = stubDiscord([first, chatter(100, 100), third]);
        const { announced } = await freshDiscord();

        const seen = await announced('chan');

        // Four: three full pages, then the empty one that proves history ended.
        // Reading stops at the end of history or once it reaches past the
        // announce window, not at a fixed page count.
        expect(reads(calls).length).toBe(4);
        expect(reads(calls)[0]).not.toContain('before=');
        // Each page resumes from the oldest id of the page before it.
        expect(reads(calls)[1]).toContain('before=1099');
        expect(reads(calls)[2]).toContain('before=1199');
        expect([...seen.urls].sort()).toEqual(['https://example.com/a', 'https://example.com/b']);
        expect(seen.foundOwn).toBe(true);
    });

    it('does not treat someone else’s message as one of ours', async () => {
        // People paste release links too. Counting one as an announcement would
        // suppress the real announcement for that release permanently.
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        stubDiscord([
            [
                {
                    id: '1000',
                    timestamp: at(0),
                    author: { id: HUMAN },
                    content: `nice one\n\n${url}`,
                },
            ],
        ]);
        const { announced } = await freshDiscord();

        const seen = await announced('chan');

        expect(seen.foundOwn).toBe(false);
        expect(seen.urls.size).toBe(0);
    });

    it('stops at a short page instead of asking for history that is not there', async () => {
        const first = withOldest(chatter(100, 0), mine(99, url));

        const calls = stubDiscord([first, chatter(40, 100)]);
        const { announced } = await freshDiscord();

        const seen = await announced('chan');

        expect(reads(calls).length).toBe(2);
        expect(seen.searchedFrom).toBe(at(139));
    });

    it('reports the oldest message it genuinely read as searchedFrom', async () => {
        const first = withOldest(chatter(100, 0), mine(99, url));

        stubDiscord([first, chatter(100, 100), chatter(100, 200)]);
        const { announced } = await freshDiscord();

        expect((await announced('chan')).searchedFrom).toBe(at(299));
    });

    it('keeps the previous searchedFrom when a page’s oldest timestamp is missing', async () => {
        // `timestamp` is optional, so this page tells us nothing about depth.
        // Erasing the bound was once justified as the safe direction, because
        // undefined sends pending() to `dated.slice(-1)`. That branch announces
        // only the NEWEST item, which moves the watermark, so every older pending
        // item then sits below it and is dropped - the whole backlog but one.
        // Keeping at(99) is stale, and loses only what falls between the true
        // depth and it. Strictly the smaller loss.
        const first = withOldest(chatter(100, 0), mine(99, url));
        const second = withOldest(chatter(40, 100), { timestamp: undefined });

        stubDiscord([first, second]);
        const { announced } = await freshDiscord();

        expect((await announced('chan')).searchedFrom).toBe(at(99));
    });

    it('never lets searchedFrom move forward in time', async () => {
        // Out-of-order data must not shrink the window we claim to have read,
        // for the same reason: pending() drops everything below that floor.
        const first = withOldest(chatter(100, 0), mine(99, url));
        const second = withOldest(chatter(40, 100), { timestamp: at(1) });

        stubDiscord([first, second]);
        const { announced } = await freshDiscord();

        expect((await announced('chan')).searchedFrom).toBe(at(99));
    });

    it('warns with the number of messages actually examined, not the ceiling', async () => {
        // This warning is the signal that the channel is about to be treated as
        // brand new, which changes which branch pending() takes. Reporting the
        // HISTORY_PAGES ceiling hid that the window was three messages deep.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        stubDiscord([chatter(3, 0)]);
        const { announced } = await freshDiscord();

        await announced('chan');

        const message = String(warn.mock.calls[0]?.[0]);
        expect(message).toContain('last 3 messages read');
        expect(message).not.toContain('300');
    });

    it('fails immediately without a token instead of retrying a config error', async () => {
        // Fake timers make this deterministic without waiting: were the missing
        // token caught by the network-retry branch again, `pause()` would never
        // resolve and this case would time out rather than quietly pass.
        delete process.env.DISCORD_BOT_TOKEN;
        const calls = stubDiscord([]);
        const { announced } = await freshDiscord();

        vi.useFakeTimers();
        try {
            await expect(announced('chan')).rejects.toThrow(/DISCORD_BOT_TOKEN/);
        } finally {
            vi.useRealTimers();
        }

        expect(calls.length).toBe(0);
    });
});

describe('announce', () => {
    beforeEach(() => {
        process.env.DISCORD_BOT_TOKEN = 'test';
    });

    it('sends a nonce without enforcing it', async () => {
        // Deliberate, and asserted so nobody turns enforcement on for the dedup
        // it does not provide: POSTs are retried on 429 alone, and a 429 is
        // rejected before the message is created, so there is no duplicate to
        // enforce against. `nonceFor` is a 32-bit hash, so enforcement could
        // instead have Discord answer a colliding announcement with the older
        // message and drop a real release while the call still looks successful.
        let sent: Record<string, unknown> = {};
        vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
            const requested = String(input);
            const isSelf = requested.includes('/users/@me');
            if (!isSelf) sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
            return Promise.resolve(
                new Response(JSON.stringify(isSelf ? { id: BOT } : {}), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
            );
        });
        const { announce } = await freshDiscord();

        await announce({ channelId: 'chan', title: 'v1.73.0', body: '- shipped', url });

        expect(typeof sent.nonce).toBe('string');
        expect('enforce_nonce' in sent).toBe(false);
    });
});

describe('safety guards', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('refuses to post a message over the limit instead of letting Discord shear it', async () => {
        process.env.DISCORD_BOT_TOKEN = 'token';
        const { postText } = await freshDiscord();
        const calls: string[] = [];
        vi.stubGlobal('fetch', (input: string | URL) => {
            calls.push(String(input));
            return Promise.resolve(Response.json({ id: 'me' }));
        });

        // Through postText, because compose() trims the body to fit and so can
        // never reach this guard. Discord truncates rather than rejecting, and a
        // truncated announcement loses its trailing URL, the dedup identity,
        // so it looks unannounced for ever and is re-posted on every run.
        await expect(postText('chan', 'x'.repeat(2500))).rejects.toThrow();
        expect(calls.some((u) => u.includes('/messages'))).toBe(false);
    });

    it('suppresses @everyone structurally, not by trusting the body', async () => {
        process.env.DISCORD_BOT_TOKEN = 'token';
        const { announce } = await freshDiscord();
        let sent: Record<string, unknown> = {};
        vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
            if (String(input).includes('/messages')) {
                sent = JSON.parse(String(init?.body));
                return Promise.resolve(Response.json({ id: 'm' }));
            }
            return Promise.resolve(Response.json({ id: 'me' }));
        });

        await announce({
            channelId: 'chan',
            title: 'Release',
            // The body is model-written from release notes and community PR
            // titles, so an @everyone in it must be impossible by construction.
            body: 'Hey @everyone and @here, big news',
            url: 'https://github.com/o/r/releases/tag/v1',
            pingRoleId: '42',
        });

        expect(sent.allowed_mentions).toEqual({ parse: [], roles: ['42'] });
    });

    it('sends no role in allowed_mentions when no ping is configured', async () => {
        process.env.DISCORD_BOT_TOKEN = 'token';
        const { announce } = await freshDiscord();
        let sent: Record<string, unknown> = {};
        vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
            if (String(input).includes('/messages')) {
                sent = JSON.parse(String(init?.body));
                return Promise.resolve(Response.json({ id: 'm' }));
            }
            return Promise.resolve(Response.json({ id: 'me' }));
        });

        await announce({
            channelId: 'chan',
            title: 'Release',
            body: 'quiet',
            url: 'https://github.com/o/r/releases/tag/v1',
        });

        expect(sent.allowed_mentions).toEqual({ parse: [], roles: [] });
    });
});

describe('the invariants nothing else pins', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('charges the role mention against the title budget', () => {
        // The mention is ~24 characters and is prepended inside compose(). With
        // a short title the term never binds, so the obvious test passes with
        // the budget broken; a title that actually saturates is what catches it.
        const url = 'https://github.com/o/r/releases/tag/v1.73.0';
        const content = compose({
            title: 'x'.repeat(5000),
            body: 'body',
            url,
            pingRoleId: '123',
        });
        expect(content.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
        expect(sourceUrlOf(content)).toBe(url);
    });

    it('sacrifices the body before the title, and never the URL', () => {
        const url = 'https://github.com/o/r/releases/tag/v1.73.0';
        const content = compose({ title: 'T'.repeat(1900), body: 'B'.repeat(900), url });
        expect(content.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
        expect(sourceUrlOf(content)).toBe(url);
        // The body is the first thing to go, so it must not survive whole.
        expect(content).not.toContain('B'.repeat(900));
    });

    it('does not treat another source’s announcement as its own', async () => {
        process.env.DISCORD_BOT_TOKEN = 'token';
        const { announced } = await freshDiscord();
        vi.stubGlobal('fetch', (input: string | URL) => {
            if (String(input).includes('/users/@me')) {
                return Promise.resolve(Response.json({ id: 'me' }));
            }
            return Promise.resolve(
                Response.json([
                    {
                        id: '1',
                        timestamp: '2026-09-10T00:00:00Z',
                        author: { id: 'me' },
                        content:
                            '**CopilotKit 1.73.0**\n\nhttps://github.com/CopilotKit/CopilotKit/releases/tag/v1.73.0',
                    },
                ]),
            );
        });

        const seen = await announced('chan', (url) =>
            url.startsWith('https://www.youtube.com/watch'),
        );
        // foundOwn must stay false: this bot posted here, but this source did
        // not. Answering yes skips pending()'s announce-only-the-newest guard
        // and drains a 30-day backlog into a live channel.
        expect(seen.foundOwn).toBe(false);
    });

    it('never retries a POST on a 5xx, however many attempts remain', async () => {
        process.env.DISCORD_BOT_TOKEN = 'token';
        const { postText } = await freshDiscord();
        let posts = 0;
        vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
            if (String(input).includes('/users/@me')) {
                return Promise.resolve(Response.json({ id: 'me' }));
            }
            if (init?.method === 'POST') {
                posts++;
                return Promise.resolve(new Response('boom', { status: 500 }));
            }
            return Promise.resolve(Response.json([]));
        });

        // Discord can accept a message and then fail the response, so a retried
        // POST announces the same release twice. This is the single invariant
        // whose loss produces duplicates in a live community channel.
        await expect(postText('chan', 'hello')).rejects.toThrow();
        expect(posts).toBe(1);
    });
});

describe('postText, the path videos use', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('passes the ping role through to allowed_mentions', async () => {
        process.env.DISCORD_BOT_TOKEN = 'token';
        const { postText } = await freshDiscord();
        let sent: Record<string, unknown> = {};
        vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
            if (String(input).includes('/messages')) {
                sent = JSON.parse(String(init?.body));
                return Promise.resolve(Response.json({ id: 'm' }));
            }
            return Promise.resolve(Response.json({ id: 'me' }));
        });

        await postText('chan', 'New video\nhttps://www.youtube.com/watch?v=x', '99');

        // Dropping the role here renders <@&99> in the content while
        // allowed_mentions.roles stays empty: the mention appears and nobody is
        // notified, which looks like a working ping until someone checks.
        expect(sent.allowed_mentions).toEqual({ parse: [], roles: ['99'] });
        expect(String(sent.content)).toContain('<@&99>');
    });
});

describe('the invariants the producer side has to hold', () => {
    const saved = process.env.DISCORD_BOT_TOKEN;
    afterEach(() => {
        vi.useRealTimers();
        if (saved === undefined) delete process.env.DISCORD_BOT_TOKEN;
        else process.env.DISCORD_BOT_TOKEN = saved;
    });

    it('lowercases the URLs it collects, not just the ones it looks up', async () => {
        process.env.DISCORD_BOT_TOKEN = 'token';
        // Announced.urls documents lowercasing as an invariant, and watermark.ts
        // relies on it at three lookup sites - but only the consumer side was
        // ever tested, because every fixture that reached seen.urls was already
        // lowercase. CopilotKit's real release URLs are mixed case, so losing
        // this normalisation means the lookups never match and every CopilotKit
        // release is re-announced on every run, for ever.
        const mixed = 'https://github.com/CopilotKit/CopilotKit/releases/tag/v1.73.0';
        stubDiscord([[mine(1, mixed)]]);
        const { announced } = await freshDiscord();

        const seen = await announced('chan');
        expect(seen.urls.has(mixed.toLowerCase())).toBe(true);
        expect(seen.urls.has(mixed)).toBe(false);
    });

    it('never retries a POST after a thrown network error', async () => {
        process.env.DISCORD_BOT_TOKEN = 'token';
        const { postText } = await freshDiscord();
        let posts = 0;
        vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
            if (String(input).includes('/users/@me')) {
                return Promise.resolve(Response.json({ id: 'me' }));
            }
            if (init?.method === 'POST') {
                posts++;
                return Promise.reject(new Error('socket hang up'));
            }
            return Promise.resolve(Response.json([]));
        });

        // The sibling test pins the 5xx half of `if (last || !isRead) throw`.
        // This is the thrown-error half, and it exists for the same reason:
        // Discord can accept a message and then fail the response, so retrying
        // duplicates an announcement in a live community channel. Two separate
        // conditions were carrying one test between them.
        vi.useFakeTimers();
        const pending = expect(postText('chan', 'hello')).rejects.toThrow(/socket hang up/);
        await vi.runAllTimersAsync();
        await pending;
        expect(posts).toBe(1);
    });
});
