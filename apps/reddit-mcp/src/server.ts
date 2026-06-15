/**
 * Reddit MCP server — testable core.
 *
 * Read-only Reddit access for the "Reddit Pulse" section of the Weekly
 * Community Signal report. Everything here imports without side effects:
 * the auth/credential guard, the OAuth token fetch, the `redditGet` helper
 * (injectable `fetch` for tests), the tool definitions, the handlers (each
 * takes a `RedditClient` so it can be mocked), and `createRedditServer()`.
 *
 * The side-effectful bootstrap (env load, real token fetch, stdio transport)
 * lives in `index.ts`, so importing this module never touches the network.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    type Tool,
} from "@modelcontextprotocol/sdk/types.js";

// ─── credentials ──────────────────────────────────────────────────────────
export interface RedditCredentials {
    clientId: string;
    clientSecret: string;
    username: string;
    password: string;
    userAgent: string;
}

/**
 * Resolve Reddit script-app credentials, throwing a clear error if any are
 * missing. Reddit REQUIRES a descriptive User-Agent or it serves an anti-bot
 * page instead of JSON — default to a sensible one if unset.
 */
export function requireCredentials(env: NodeJS.ProcessEnv = process.env): RedditCredentials {
    const clientId = env.REDDIT_CLIENT_ID;
    const clientSecret = env.REDDIT_CLIENT_SECRET;
    const username = env.REDDIT_USERNAME;
    const password = env.REDDIT_PASSWORD;
    const missing = [
        ["REDDIT_CLIENT_ID", clientId],
        ["REDDIT_CLIENT_SECRET", clientSecret],
        ["REDDIT_USERNAME", username],
        ["REDDIT_PASSWORD", password],
    ]
        .filter(([, v]) => !v)
        .map(([k]) => k);
    if (missing.length) {
        throw new Error(`Reddit credentials missing in environment: ${missing.join(", ")}`);
    }
    return {
        clientId: clientId!,
        clientSecret: clientSecret!,
        username: username!,
        password: password!,
        userAgent: env.REDDIT_USER_AGENT || "outpost-community-signal/0.1 (by /u/copilotkit)",
    };
}

// ─── reddit client ──────────────────────────────────────────────────────────
type FetchLike = typeof fetch;

/**
 * Minimal Reddit API client: holds a bearer token, refreshes it on demand,
 * and exposes a single authenticated GET against oauth.reddit.com. `fetchImpl`
 * is injectable so tests can run without a network.
 */
export class RedditClient {
    private token: string | null = null;
    private tokenExpiresAt = 0;

    constructor(
        private readonly creds: RedditCredentials,
        private readonly fetchImpl: FetchLike = fetch,
        private readonly now: () => number = () => Date.now(),
    ) {}

    /** OAuth2 password grant for a "script" app → cached bearer token. */
    async getToken(): Promise<string> {
        if (this.token && this.now() < this.tokenExpiresAt - 60_000) {
            return this.token;
        }
        const basic = Buffer.from(`${this.creds.clientId}:${this.creds.clientSecret}`).toString(
            "base64",
        );
        const body = new URLSearchParams({
            grant_type: "password",
            username: this.creds.username,
            password: this.creds.password,
        });
        const res = await this.fetchImpl("https://www.reddit.com/api/v1/access_token", {
            method: "POST",
            headers: {
                Authorization: `Basic ${basic}`,
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": this.creds.userAgent,
            },
            body,
        });
        if (!res.ok) {
            throw new Error(`Reddit token request failed: ${res.status} ${await res.text()}`);
        }
        const json = (await res.json()) as { access_token?: string; expires_in?: number };
        if (!json.access_token) {
            throw new Error("Reddit token response missing access_token");
        }
        this.token = json.access_token;
        this.tokenExpiresAt = this.now() + (json.expires_in ?? 3600) * 1000;
        return this.token;
    }

    /** Authenticated GET against oauth.reddit.com; retries once on a 401. */
    async get(path: string, params: Record<string, string | number | undefined> = {}): Promise<unknown> {
        const url = new URL(`https://oauth.reddit.com${path}`);
        for (const [k, v] of Object.entries(params)) {
            if (v !== undefined) url.searchParams.set(k, String(v));
        }
        url.searchParams.set("raw_json", "1");

        const call = async () => {
            const token = await this.getToken();
            return this.fetchImpl(url.toString(), {
                headers: { Authorization: `Bearer ${token}`, "User-Agent": this.creds.userAgent },
            });
        };

        let res = await call();
        if (res.status === 401) {
            this.token = null; // force refresh and retry once
            res = await call();
        }
        if (!res.ok) {
            throw new Error(`Reddit GET ${path} failed: ${res.status} ${await res.text()}`);
        }
        return res.json();
    }
}

// ─── shaping helpers ──────────────────────────────────────────────────────────
interface PostSummary {
    id: string;
    subreddit: string;
    title: string;
    author: string;
    score: number;
    num_comments: number;
    created_utc: number;
    permalink: string;
    selftext_excerpt: string;
}

/** Reddit wraps everything as `{ kind, data }`; pull the post fields we report on. */
export function summarizePost(child: { data?: Record<string, unknown> }): PostSummary {
    const d = (child?.data ?? {}) as Record<string, unknown>;
    const self = typeof d.selftext === "string" ? d.selftext : "";
    return {
        id: String(d.id ?? ""),
        subreddit: String(d.subreddit ?? ""),
        title: String(d.title ?? ""),
        author: String(d.author ?? ""),
        score: Number(d.score ?? 0),
        num_comments: Number(d.num_comments ?? 0),
        created_utc: Number(d.created_utc ?? 0),
        permalink: d.permalink ? `https://www.reddit.com${d.permalink}` : "",
        selftext_excerpt: self.length > 500 ? `${self.slice(0, 500)}…` : self,
    };
}

function formatPostLine(p: PostSummary): string {
    return `- r/${p.subreddit} | ${p.title} | score ${p.score} · ${p.num_comments} comments · u/${p.author}\n  ${p.permalink}`;
}

function extractListing(json: unknown): Array<{ data?: Record<string, unknown> }> {
    const children = (json as { data?: { children?: unknown } })?.data?.children;
    return Array.isArray(children) ? (children as Array<{ data?: Record<string, unknown> }>) : [];
}

// ─── tool definitions ────────────────────────────────────────────────────────
const SORT_DESC = "Sort order: relevance | new | top | hot | comments";
const TIME_DESC = "Time window for top/relevance: hour | day | week | month | year | all";

export const TOOLS: Tool[] = [
    {
        name: "search_all",
        description:
            "Search across all of Reddit for a query (e.g. brand mentions like 'CopilotKit' or 'AG-UI'). Returns matching posts with score and comment counts.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Search query" },
                sort: { type: "string", description: SORT_DESC },
                time: { type: "string", description: TIME_DESC },
                limit: { type: "number", description: "Max posts (default 25, max 100)", minimum: 1, maximum: 100 },
            },
            required: ["query"],
        },
    },
    {
        name: "search_subreddit",
        description:
            "Search within a single subreddit. Use to sweep a watchlist sub (e.g. LocalLLaMA, LangChain, AI_Agents, nextjs, SaaS) for relevant chatter.",
        inputSchema: {
            type: "object",
            properties: {
                subreddit: { type: "string", description: "Subreddit name without the r/ prefix" },
                query: { type: "string", description: "Search query" },
                sort: { type: "string", description: SORT_DESC },
                time: { type: "string", description: TIME_DESC },
                limit: { type: "number", description: "Max posts (default 25, max 100)", minimum: 1, maximum: 100 },
            },
            required: ["subreddit", "query"],
        },
    },
    {
        name: "get_post",
        description:
            "Fetch a single post plus its top comments — the sentiment signal (praise, complaints, comparisons). Pass the base-36 post id (e.g. '1abc2de').",
        inputSchema: {
            type: "object",
            properties: {
                id: { type: "string", description: "Reddit post id (base-36, no t3_ prefix)" },
                comment_limit: {
                    type: "number",
                    description: "Max top-level comments to return (default 20, max 100)",
                    minimum: 1,
                    maximum: 100,
                },
            },
            required: ["id"],
        },
    },
    {
        name: "subreddit_feed",
        description: "List hot or new posts from a subreddit (no query) — quick read of what a community is talking about.",
        inputSchema: {
            type: "object",
            properties: {
                subreddit: { type: "string", description: "Subreddit name without the r/ prefix" },
                listing: { type: "string", description: "hot | new | top (default hot)" },
                time: { type: "string", description: TIME_DESC + " (only used for listing=top)" },
                limit: { type: "number", description: "Max posts (default 25, max 100)", minimum: 1, maximum: 100 },
            },
            required: ["subreddit"],
        },
    },
];

// ─── tool handlers ───────────────────────────────────────────────────────────
export async function handleSearchAll(
    client: RedditClient,
    args: { query: string; sort?: string; time?: string; limit?: number },
): Promise<string> {
    const limit = Math.min(args.limit ?? 25, 100);
    const json = await client.get("/search", {
        q: args.query,
        sort: args.sort ?? "relevance",
        t: args.time ?? "week",
        limit,
        type: "link",
    });
    const posts = extractListing(json).map(summarizePost);
    return `Reddit search for "${args.query}" (${posts.length}):\n` + posts.map(formatPostLine).join("\n");
}

export async function handleSearchSubreddit(
    client: RedditClient,
    args: { subreddit: string; query: string; sort?: string; time?: string; limit?: number },
): Promise<string> {
    const limit = Math.min(args.limit ?? 25, 100);
    const json = await client.get(`/r/${args.subreddit}/search`, {
        q: args.query,
        restrict_sr: 1,
        sort: args.sort ?? "relevance",
        t: args.time ?? "week",
        limit,
    });
    const posts = extractListing(json).map(summarizePost);
    return `r/${args.subreddit} search for "${args.query}" (${posts.length}):\n` + posts.map(formatPostLine).join("\n");
}

export async function handleGetPost(
    client: RedditClient,
    args: { id: string; comment_limit?: number },
): Promise<string> {
    const limit = Math.min(args.comment_limit ?? 20, 100);
    const json = await client.get(`/comments/${args.id}`, { limit, sort: "top", depth: 1 });
    const arr = Array.isArray(json) ? json : [];
    const post = summarizePost(extractListing(arr[0])[0] ?? {});
    const comments = extractListing(arr[1])
        .map((c) => (c?.data ?? {}) as Record<string, unknown>)
        .filter((d) => typeof d.body === "string")
        .map((d) => {
            const body = String(d.body);
            return `  • u/${d.author} (${Number(d.score ?? 0)}): ${body.length > 300 ? body.slice(0, 300) + "…" : body}`;
        });
    return (
        `Post: ${post.title}\nr/${post.subreddit} · score ${post.score} · ${post.num_comments} comments · u/${post.author}\n${post.permalink}\n\n` +
        (post.selftext_excerpt ? `Body: ${post.selftext_excerpt}\n\n` : "") +
        `Top comments (${comments.length}):\n${comments.join("\n")}`
    );
}

export async function handleSubredditFeed(
    client: RedditClient,
    args: { subreddit: string; listing?: string; time?: string; limit?: number },
): Promise<string> {
    const limit = Math.min(args.limit ?? 25, 100);
    const listing = args.listing ?? "hot";
    const json = await client.get(`/r/${args.subreddit}/${listing}`, {
        limit,
        t: listing === "top" ? (args.time ?? "week") : undefined,
    });
    const posts = extractListing(json).map(summarizePost);
    return `r/${args.subreddit} ${listing} (${posts.length}):\n` + posts.map(formatPostLine).join("\n");
}

// ─── MCP server factory ───────────────────────────────────────────────────────
export function createRedditServer(client: RedditClient): Server {
    const server = new Server(
        { name: "reddit", version: "0.1.0" },
        { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const { name, arguments: args } = req.params;
        let text: string;
        try {
            switch (name) {
                case "search_all":
                    text = await handleSearchAll(client, args as { query: string });
                    break;
                case "search_subreddit":
                    text = await handleSearchSubreddit(
                        client,
                        args as { subreddit: string; query: string },
                    );
                    break;
                case "get_post":
                    text = await handleGetPost(client, args as { id: string });
                    break;
                case "subreddit_feed":
                    text = await handleSubredditFeed(client, args as { subreddit: string });
                    break;
                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        } catch (err) {
            text = `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
        return { content: [{ type: "text", text }] };
    });

    return server;
}
