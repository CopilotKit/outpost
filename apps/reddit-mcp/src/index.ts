/**
 * Reddit MCP server (TypeScript) — bootstrap.
 *
 * Exposes 4 read-only tools used by the Reddit Pulse section of the Weekly
 * Community Signal report:
 *   - search_all
 *   - search_subreddit
 *   - get_post
 *   - subreddit_feed
 *
 * Tool logic + MCP wiring live in `server.ts` (importable without side
 * effects); this file only loads env, builds the client, and connects stdio.
 *
 * Configure once:
 *   pnpm --filter @copilotkit/outpost-reddit-mcp build
 *   # create a "script" app at https://www.reddit.com/prefs/apps, then set
 *   # REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET / REDDIT_USERNAME / REDDIT_PASSWORD
 *   # in apps/reddit-mcp/.env (or the repo-root .env).
 *   claude mcp add reddit --scope user -- node /abs/path/to/outpost/apps/reddit-mcp/dist/index.js
 */

import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRedditServer, RedditClient, requireCredentials } from "./server.js";

// ─── env ─────────────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Local app .env wins; fall back to the monorepo-root .env (dist/ → app → apps → repo root).
loadEnv({ path: resolve(__dirname, "../.env") });
loadEnv({ path: resolve(__dirname, "../../../.env") });

const creds = (() => {
    try {
        return requireCredentials();
    } catch (err) {
        console.error(`[reddit-mcp] ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
})();

// ─── client + MCP server over stdio ────────────────────────────────────────────
const client = new RedditClient(creds);
const server = createRedditServer(client);
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[reddit-mcp] MCP server running on stdio");
