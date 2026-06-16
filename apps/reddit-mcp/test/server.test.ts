/**
 * Tests for the Reddit MCP server.
 *
 * Strategy:
 *   - Unit-test the pure pieces (credential guard, post summarizer).
 *   - Test the RedditClient token flow + GET against a mocked fetch (no network):
 *     token caching, 401 refresh-and-retry.
 *   - Unit-test each tool handler with a fake client.
 *   - End-to-end test the real MCP protocol via the SDK's in-memory transport.
 *   - A gated live smoke test (RUN_REDDIT_LIVE=1) that hits real Reddit.
 */

import { describe, it, expect, vi } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
    requireCredentials,
    summarizePost,
    RedditClient,
    handleSearchAll,
    handleGetPost,
    TOOLS,
    createRedditServer,
    type RedditCredentials,
} from "../src/server";

// ─── fakes ─────────────────────────────────────────────────────────────────
const CREDS: RedditCredentials = {
    clientId: "id",
    clientSecret: "secret",
    userAgent: "test-agent/0.1",
};

function jsonResponse(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as Response;
}

const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";

/** Build a fetch stub that hands out a token then routes oauth.reddit.com GETs by path. */
function fakeFetch(routes: Record<string, unknown>, opts: { token?: unknown } = {}) {
    return vi.fn(async (input: string | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.startsWith(TOKEN_URL)) {
            return jsonResponse(opts.token ?? { access_token: "tok-123", expires_in: 3600 });
        }
        const path = new URL(url).pathname;
        if (path in routes) return jsonResponse(routes[path]);
        return jsonResponse({ message: "not found" }, 404);
    });
}

function listing(children: Array<Record<string, unknown>>) {
    return { data: { children: children.map((data) => ({ kind: "t3", data })) } };
}

// ─── credential guard ────────────────────────────────────────────────────────
describe("requireCredentials", () => {
    it("returns credentials when client id + secret present", () => {
        const c = requireCredentials({
            REDDIT_CLIENT_ID: "a",
            REDDIT_CLIENT_SECRET: "b",
        } as NodeJS.ProcessEnv);
        expect(c.clientId).toBe("a");
        expect(c.userAgent).toContain("outpost-community-signal");
    });

    it("lists every missing var", () => {
        expect(() => requireCredentials({} as NodeJS.ProcessEnv)).toThrow(
            /REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET/,
        );
    });

    it("honors a custom User-Agent", () => {
        const c = requireCredentials({
            REDDIT_CLIENT_ID: "a",
            REDDIT_CLIENT_SECRET: "b",
            REDDIT_USER_AGENT: "custom/9",
        } as NodeJS.ProcessEnv);
        expect(c.userAgent).toBe("custom/9");
    });
});

// ─── summarizer ──────────────────────────────────────────────────────────────
describe("summarizePost", () => {
    it("pulls reported fields and builds an absolute permalink", () => {
        const p = summarizePost({
            data: {
                id: "abc",
                subreddit: "LocalLLaMA",
                title: "CopilotKit is great",
                author: "someuser",
                score: 42,
                num_comments: 7,
                created_utc: 1750000000,
                permalink: "/r/LocalLLaMA/comments/abc/copilotkit_is_great/",
                selftext: "short body",
            },
        });
        expect(p.subreddit).toBe("LocalLLaMA");
        expect(p.score).toBe(42);
        expect(p.permalink).toBe(
            "https://www.reddit.com/r/LocalLLaMA/comments/abc/copilotkit_is_great/",
        );
    });

    it("truncates long selftext", () => {
        const p = summarizePost({ data: { selftext: "x".repeat(900) } });
        expect(p.selftext_excerpt.endsWith("…")).toBe(true);
        expect(p.selftext_excerpt.length).toBeLessThan(520);
    });
});

// ─── token flow ────────────────────────────────────────────────────────────
describe("RedditClient token flow", () => {
    it("fetches a token once and caches it across GETs", async () => {
        const fetchImpl = fakeFetch({ "/search": listing([{ id: "1", title: "t" }]) });
        const client = new RedditClient(CREDS, fetchImpl);
        await client.get("/search", { q: "x" });
        await client.get("/search", { q: "y" });
        const tokenCalls = fetchImpl.mock.calls.filter(([u]) => String(u).startsWith(TOKEN_URL));
        expect(tokenCalls).toHaveLength(1);
    });

    it("refreshes and retries once on a 401", async () => {
        let first = true;
        const fetchImpl = vi.fn(async (input: string | URL) => {
            const url = String(input);
            if (url.startsWith(TOKEN_URL)) return jsonResponse({ access_token: "t", expires_in: 3600 });
            if (first) {
                first = false;
                return jsonResponse({ message: "unauthorized" }, 401);
            }
            return jsonResponse(listing([{ id: "ok" }]));
        });
        const client = new RedditClient(CREDS, fetchImpl);
        const out = (await client.get("/search")) as { data: { children: unknown[] } };
        expect(out.data.children).toHaveLength(1);
        // token endpoint hit twice (initial + forced refresh after 401)
        expect(fetchImpl.mock.calls.filter(([u]) => String(u).startsWith(TOKEN_URL))).toHaveLength(2);
    });

    it("throws a clear error on a failed token request", async () => {
        const fetchImpl = vi.fn(async () => jsonResponse({ error: "bad" }, 401));
        const client = new RedditClient(CREDS, fetchImpl);
        await expect(client.get("/search")).rejects.toThrow(/token request failed/);
    });
});

// ─── handlers ────────────────────────────────────────────────────────────────
describe("handlers", () => {
    it("search_all formats posts", async () => {
        const fetchImpl = fakeFetch({
            "/search": listing([
                { id: "1", subreddit: "AI_Agents", title: "Tried CopilotKit", score: 12, num_comments: 3, author: "u1", permalink: "/r/AI_Agents/comments/1/x/" },
            ]),
        });
        const out = await handleSearchAll(new RedditClient(CREDS, fetchImpl), { query: "CopilotKit" });
        expect(out).toContain('Reddit search for "CopilotKit" (1):');
        expect(out).toContain("r/AI_Agents | Tried CopilotKit | score 12 · 3 comments · u/u1");
    });

    it("get_post returns the post + top comments", async () => {
        const fetchImpl = fakeFetch({
            "/comments/abc": [
                listing([{ id: "abc", subreddit: "nextjs", title: "CopilotKit review", score: 30, num_comments: 2, author: "op", permalink: "/r/nextjs/comments/abc/x/", selftext: "my take" }]),
                listing([
                    { body: "love it", author: "c1", score: 9 },
                    { body: "hit a bug", author: "c2", score: 4 },
                ]),
            ],
        });
        const out = await handleGetPost(new RedditClient(CREDS, fetchImpl), { id: "abc" });
        expect(out).toContain("Post: CopilotKit review");
        expect(out).toContain("Body: my take");
        expect(out).toContain("u/c1 (9): love it");
        expect(out).toContain("u/c2 (4): hit a bug");
    });
});

// ─── tool contract ───────────────────────────────────────────────────────────
describe("TOOLS contract", () => {
    it("exposes exactly the four read-only tools", () => {
        expect(TOOLS.map((t) => t.name).sort()).toEqual(
            ["get_post", "search_all", "search_subreddit", "subreddit_feed"].sort(),
        );
    });
    it("every tool has a description and object schema", () => {
        for (const t of TOOLS) {
            expect(t.description, t.name).toBeTruthy();
            expect(t.inputSchema.type, t.name).toBe("object");
        }
    });
});

// ─── MCP protocol e2e (in-memory, no network) ────────────────────────────────
describe("MCP protocol (in-memory)", () => {
    async function connect(fetchImpl: typeof fetch) {
        const server = createRedditServer(new RedditClient(CREDS, fetchImpl));
        const [clientT, serverT] = InMemoryTransport.createLinkedPair();
        await server.connect(serverT);
        const client = new McpClient({ name: "test", version: "0.0.0" }, { capabilities: {} });
        await client.connect(clientT);
        return client;
    }

    it("lists the four tools over the wire", async () => {
        const client = await connect(fakeFetch({}));
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual(
            ["get_post", "search_all", "search_subreddit", "subreddit_feed"].sort(),
        );
    });

    it("calls search_all and returns formatted text content", async () => {
        const client = await connect(
            fakeFetch({ "/search": listing([{ id: "1", subreddit: "SaaS", title: "CopilotKit thoughts", score: 5, num_comments: 1, author: "u", permalink: "/r/SaaS/comments/1/x/" }]) }),
        );
        const res = (await client.callTool({ name: "search_all", arguments: { query: "CopilotKit" } })) as {
            content: { type: string; text: string }[];
        };
        expect(res.content[0].text).toContain("r/SaaS | CopilotKit thoughts");
    });

    it("surfaces handler errors as text instead of throwing", async () => {
        const client = await connect(fakeFetch({}));
        const res = (await client.callTool({ name: "made_up", arguments: {} })) as {
            content: { type: string; text: string }[];
        };
        expect(res.content[0].text).toContain("Error: Unknown tool: made_up");
    });
});

// ─── live Reddit smoke test (opt-in) ──────────────────────────────────────────
// RUN_REDDIT_LIVE=1 REDDIT_CLIENT_ID=... (+secret/username/password) pnpm --filter @copilotkit/outpost-reddit-mcp test
describe.skipIf(!process.env.RUN_REDDIT_LIVE)("live Reddit smoke", () => {
    it("authenticates and returns search results", async () => {
        const client = new RedditClient(requireCredentials());
        const out = await handleSearchAll(client, { query: "CopilotKit", time: "month" });
        expect(out).toMatch(/Reddit search for "CopilotKit" \(\d+\):/);
    }, 30_000);
});
