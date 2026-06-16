# CLAUDE.md

Outpost — AI-powered customer support operations platform. See [README](./README.md) for the product overview.

## Community Signals workflow

This repo carries a runnable Claude Code skill suite under `.claude/skills/` for the weekly cross-source (Discord + GitHub) community report. The report is produced by Outpost's community manager today via the manual routine; engineering is porting it into Outpost as native TS per [#66](https://github.com/CopilotKit/outpost/issues/66). Until that lands, the skill suite IS the workflow.

| Trigger | Skill |
|---|---|
| "go" / "weekly report" / "community signals" / "run routine" | `weekly-report` (orchestrator — spawns subagents for Discord, GitHub, deep-read, enrichment) |
| "find all reports about X in last N days" / "search across both communities" | `topic-search` |
| "enterprise report" / "who at enterprise this week" / "enterprise status" | `enterprise` |
| (invoked by `weekly-report`) | `front-door-triage` · `deep-read-issue` · `enrich-reporter` |
| "draft Slack TL;DR" / "build the Slack message" | `slack-tldr` |

### Architecture — orchestrator + subagents

`weekly-report` is the orchestrator. It **delegates** to subagents so the main thread's context stays small:

```
weekly-report (main)
├─→ Discord pull subagent      (per-channel substantive summaries)
├─→ GitHub pull subagent       (issue lists, both repos, tagged by community)
├─→ deep-read-issue subagent   (file paths, reviewer concerns, hidden bugs)
├─→ enrich-reporter subagent   (gh api users/<login>, enterprise classify)
└─→ Synthesize → Notion page + Slack JSON via slack-tldr
```

Each subagent has its own context window. The orchestrator sees only compact returns.

### Communities

- **CopilotKit** — Discord server `1122926057641742418` · GitHub `CopilotKit/CopilotKit`
- **AG-UI** — Discord server `1379082175625953370` · GitHub `ag-ui-protocol/ag-ui`

Channels mapped per community in the `weekly-report` skill.

### Cross-skill conventions

- Read-only on Discord. Never post.
- Reports are **company-readable** (product, marketing, leadership, sales/CS, engineering) — strip orchestrator process notes.
- Convert relative dates to absolute ISO so pages stay interpretable later.
- Reconfirm the date window before pulling data so a wrong week is caught early.
- Forum thread URL format: `https://discord.com/channels/<guild_id>/<thread_id>` — parent forum channel ID NOT in URL.
- Every Discord mention is a hyperlink. Every named entity in 🔄 Patterns is hyperlinked.
- Dated report lists go oldest → newest. Bullets = one sentence; depth lives in 🔄 Patterns.

Detailed rules live in each skill file. The orchestrator (`weekly-report`) carries the full page structure spec.

### Prerequisites

The skills assume these MCP servers + CLI tools are available:

- [`mcp-discord`](https://github.com/NathanTarbert/mcp-discord) — Discord MCP server with the forum-reader tools (`list_forum_threads`, `read_thread_messages`). Install per the repo README and configure `DISCORD_TOKEN` in your environment.
- `gh` CLI authenticated with read access to `CopilotKit/CopilotKit` + `ag-ui-protocol/ag-ui`.
- [`apps/reddit-mcp`](./apps/reddit-mcp) — read-only Reddit MCP server (powers the 🟠 Reddit Pulse section). Build it, then set `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` (application-only OAuth, no user login) in `.env`. Scope via `REDDIT_BRAND_TERMS` + `REDDIT_WATCHLIST`. Optional — if absent, Reddit Pulse renders "source not configured".
- Notion MCP server (`plugin_Notion_notion`) authenticated against the CopilotKit workspace.
- Slack webhook URL (`SLACK_WEBHOOK_URL_1` or similar) set in `.claude/settings.local.json` `env` block for posting the TL;DR.

### Workflow status

- **Today:** manual routine runs from this skill suite. Source of truth is here.
- **Soon:** engineering ports the orchestrator + threshold + trend + clusterer to native TS inside `packages/outpost/ai` and `packages/outpost/queue`. Tracked by [#66](https://github.com/CopilotKit/outpost/issues/66).
- **Cutover:** when the Outpost dashboard ships the Weekly Community Signal report, the skills become a reference / fallback path. Spec changes still land in the skill files first.

See [`docs/community-signal/README.md`](./docs/community-signal/README.md) for the migration map (manual → native) and open decisions.
