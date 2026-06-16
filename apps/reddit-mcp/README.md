# @copilotkit/outpost-reddit-mcp

Read-only Reddit MCP server for the **Reddit Pulse** section of the Weekly Community Signal report. Mirrors `apps/discord-mcp`: a small stdio MCP that talks to Reddit's API over the local network (so it isn't blocked the way the Anthropic web crawler is).

## Tools

| Tool | Purpose |
|---|---|
| `search_all` | Search all of Reddit (brand mentions: CopilotKit, AG-UI) |
| `search_subreddit` | Search within one subreddit (watchlist sweeps) |
| `get_post` | A post + its top comments — the sentiment signal |
| `subreddit_feed` | hot / new / top posts from a subreddit |

`sort` = relevance·new·top·hot·comments · `time` = hour·day·week·month·year·all (the weekly run uses `time=week`).

## Setup

1. Go to <https://www.reddit.com/prefs/apps> (logged in as any Reddit account) → **create another app…** → name it (e.g. `outpost-community-signal`), pick **type: script**, set redirect URI to `http://localhost:8080` (unused but required), **create app**.
2. Copy the two values: the **client id** (the string under the app name, just below "personal use script") and the **secret**. Put them in `apps/reddit-mcp/.env` (or the repo-root `.env`):
   ```
   REDDIT_CLIENT_ID=...
   REDDIT_CLIENT_SECRET=...
   ```
   No Reddit username/password needed — reads use application-only (userless) OAuth.
3. Build + register:
   ```
   pnpm --filter @copilotkit/outpost-reddit-mcp build
   claude mcp add reddit --scope user -- node /abs/path/to/outpost/apps/reddit-mcp/dist/index.js
   ```

Reddit **requires** a descriptive `User-Agent`; the server sets one (override via `REDDIT_USER_AGENT`). Auth is OAuth2 application-only (`client_credentials`) for a read-only confidential client; token cached and refreshed on 401.

## Test

```
pnpm --filter @copilotkit/outpost-reddit-mcp test
# live smoke (hits real Reddit): RUN_REDDIT_LIVE=1 + creds in env
```
