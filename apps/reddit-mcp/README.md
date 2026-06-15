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

1. Create a Reddit app at <https://www.reddit.com/prefs/apps> → **type: script** → note the client id + secret.
2. Copy creds into `apps/reddit-mcp/.env` (or the repo-root `.env`):
   ```
   REDDIT_CLIENT_ID=...
   REDDIT_CLIENT_SECRET=...
   REDDIT_USERNAME=...
   REDDIT_PASSWORD=...
   ```
3. Build + register:
   ```
   pnpm --filter @copilotkit/outpost-reddit-mcp build
   claude mcp add reddit --scope user -- node /abs/path/to/outpost/apps/reddit-mcp/dist/index.js
   ```

Reddit **requires** a descriptive `User-Agent`; the server sets one (override via `REDDIT_USER_AGENT`). Auth is OAuth2 password grant for a script app (read-only), token cached and refreshed on 401.

## Test

```
pnpm --filter @copilotkit/outpost-reddit-mcp test
# live smoke (hits real Reddit): RUN_REDDIT_LIVE=1 + creds in env
```
