# CLAUDE.md

Outpost — AI-powered customer support operations platform. See [README](./README.md) for the product overview.

## This repository is public

`CopilotKit/outpost` is public as of 2026-09-15. Everything written into it — PR titles and bodies,
issue text, review comments, commit messages — is world-readable and indexed.

Before writing any of those, check what belongs there:

- Security findings carry **what and verification**, not a reproduction. Name the surface and the
  fix; leave working payloads and bypass sequences out.
- An **unfixed** hole gets a minimal tracking issue, with the detail in Linear rather than in the
  issue body. If it warrants disclosure handling, use a private security advisory.
- No customer names, revenue, headcount, roadmap dates, incident specifics, staging URLs, env var
  values, or internal service topology.
- Write for a stranger: no internal ticket shorthand, no "as discussed", no references to private
  threads.

Note this also changes contributor expectations — outside PRs now arrive from forks, so their CI
runs need maintainer approval before anything goes green.

## Code review before push

Before pushing any non-trivial code change or opening a PR, run `copilotkit-internal:cr-loop` (the CopilotKit-internal 7-agent review-fix loop) on the diff first. This is a standing rule, not case-by-case. If the `pr-review-toolkit` plugin it depends on isn't installed, ask before falling back to a lighter review — don't silently skip it. Exception: mechanical-only diffs (lockfile regen, whitespace) don't need it, per the skill's own scope rules.

## Community Signals workflow

This repo carries a runnable Claude Code skill suite under `.claude/skills/` for the weekly cross-source (Discord + GitHub) community report. The report is produced by Outpost's community manager today via the manual routine; engineering is porting it into Outpost as native TS per [#66](https://github.com/CopilotKit/outpost/issues/66). Until that lands, the skill suite IS the workflow.

**Human-readable reference:** everything that goes into Community Signal is written down on the **Community Signal — Playbook & Reference** Notion page (child of the Outpost page): https://app.notion.com/p/3913aa3818528149930feaf69de83b2b — kept in sync with the skills (add a dated Changelog row there whenever the workflow changes).

| Trigger | Skill |
|---|---|
| "go" / "weekly report" / "community signals" / "run routine" | `weekly-report` (orchestrator — spawns subagents for Discord, GitHub, deep-read, enrichment) |
| "find all reports about X in last N days" / "search across both communities" | `topic-search` |
| "enterprise report" / "who at enterprise this week" / "enterprise status" | `enterprise` |
| (invoked by `weekly-report`) | `product-surface-scan` · `front-door-triage` · `deep-read-issue` · `release-scan` · `enrich-reporter` · `enrich-prospect` · `report-sources` |
| "draft Slack TL;DR" / "build the Slack message" | `slack-tldr` |
| "carry forward owners" / "who owned this last week" / "owner continuity" (also auto-run near the end of every report) | `carry-forward-owners` |
| "loom script" / "record the loom" / "walkthrough script" (also auto-run as the last step of every report) | `loom-walkthrough` |

### Architecture — orchestrator + subagents

`weekly-report` is the orchestrator. It **delegates** to subagents so the main thread's context stays small:

```
weekly-report (main)
├─→ product-surface-scan sub   (commercial-surface list + free-vs-paid classifier + cross-page contradiction check → defines 🏢 Enterprise scope)
├─→ Discord pull subagent      (per-channel substantive summaries)
├─→ GitHub pull subagent       (issue lists, both repos, tagged by community)
├─→ release-scan subagent      (in-cycle release fix-map via tag diff + authoritative version)
├─→ deep-read-issue subagent   (file paths, reviewer concerns, hidden bugs)
├─→ enrich-reporter subagent   (gh api users/<login>, enterprise classify — all reporters)
├─→ enrich-prospect subagent   (deep: LinkedIn + company website + size — prospect shortlist only)
├─→ report-sources subagent    (evidence-backed defense of every placement → "Report Sources" child page)
├─→ carry-forward-owners       (diff vs last week's report → print owners of recurring items; Nathan re-tags)
└─→ Synthesize → Notion page + Slack JSON via slack-tldr
```

Each subagent has its own context window. The orchestrator sees only compact returns.

### Communities

- **CopilotKit** — Discord server `1122926057641742418` · GitHub `CopilotKit/CopilotKit`
- **AG-UI** — Discord server `1379082175625953370` · GitHub `ag-ui-protocol/ag-ui`

Channels mapped per community in the `weekly-report` skill.

### Cross-skill conventions

- **The report lives ONLY in Notion — never document it in the codebase.** Report content and any per-run snapshot/ledger derived from it are published to the Notion pages, not committed as files. Diff-against-last-week reads the prior Notion report, not a stored file. The one allowed repo artifact is `docs/community-signal/reddit-pulse-seen.json` (operational dedup state — seen Reddit post IDs, not report content).
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
- **Composio MCP** ([app.composio.dev](https://app.composio.dev)) — the Reddit data source for the 🟠 Reddit Pulse sections, registered in `.mcp.json` as `composio` (HTTP, `https://connect.composio.dev/mcp`, **OAuth** — no API-key header). Composio's egress reaches Reddit where this machine's IP is 403-blocked for anonymous/scrape reads (we tried `reddit-mcp-buddy` and a no-auth server — both 403'd; that's why Composio). Two auth hops: (1) `mcp__composio__authenticate` connects Claude Code → your Composio account; (2) `COMPOSIO_MANAGE_CONNECTIONS` (toolkit `reddit`) connects your Reddit account. Reddit tools (`REDDIT_SEARCH_ACROSS_SUBREDDITS`, `REDDIT_RETRIEVE_REDDIT_POST`, `REDDIT_RETRIEVE_POST_COMMENTS`) run via `COMPOSIO_MULTI_EXECUTE_TOOL`. Optional — if absent, Reddit Pulse renders "source not configured". Scope: `REDDIT_BRAND_TERMS` (default `CopilotKit,AG-UI,ag-ui`) + `REDDIT_WATCHLIST` (default `LocalLLaMA,LangChain,AI_Agents,nextjs,SaaS,LLMDevs`) in the repo-root `.env`. Dedup ledger: `docs/community-signal/reddit-pulse-seen.json`.
- Notion MCP server (`plugin_Notion_notion`) authenticated against the CopilotKit workspace.
- Slack webhook URL (`SLACK_WEBHOOK_URL_1` or similar) set in `.claude/settings.local.json` `env` block for posting the TL;DR.

### Workflow status

- **Today:** manual routine runs from this skill suite. Source of truth is here.
- **Soon:** engineering ports the orchestrator + threshold + trend + clusterer to native TS inside `packages/outpost/ai` and `packages/outpost/queue`. Tracked by [#66](https://github.com/CopilotKit/outpost/issues/66).
- **Cutover:** when the Outpost dashboard ships the Weekly Community Signal report, the skills become a reference / fallback path. Spec changes still land in the skill files first.

See [`docs/community-signal/README.md`](./docs/community-signal/README.md) for the migration map (manual → native) and open decisions.
