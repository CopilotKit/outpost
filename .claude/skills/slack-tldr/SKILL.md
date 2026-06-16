---
name: slack-tldr
description: Build the locked Slack TL;DR JSON payload from a completed weekly report. Saves to /tmp/slack-msg.json with the exact curl command for Nathan to post manually. Triggers on "draft Slack TL;DR", "Slack post", "build the Slack message".
---

# Slack TL;DR

Build a Slack-ready JSON payload from a completed weekly report.

## Locked format

The Slack app posting this is named `CopilotKit Community Signal` — its name renders as the header. The message body does NOT include a title.

```
*TL;DR — <one-line summary in plain English>*

📊 *Week of <Mon DD>-<DD>*

• 🚨 Front-door flags: *<N>* (<category 1> · <category 2> · <category 3>)
• Community issues raised: *<N>* (<gh-count> GitHub · <discord-count> Discord)
• Resolved: *<N>* ✅ (<short list of what got fixed>)
• Top pain: *<short name>* — <N> reporters
• Top demand: *<short name>* — <N> askers
• Open fix PRs: *<N>* awaiting review
• 🏢 Enterprise reporters: *<N>* this week (prior week: <M> — trend ↑/↓/→)
• 🟠 Reddit Pulse: *<N threads>* — <one-phrase vibe> (<top-thread link>)

Full report → <<notion-url>|<Mon DD>-<DD>>
```

## Rules

- **Plain-English TL;DR line** leads — written for a non-engineer reader (marketing, leadership). Names the volume, the resolutions, and the headline themes. Don't pack metrics — bullets handle that.
- **Front-door flags** appear first if any are active. Skip if zero.
- **Issues raised** = total combining GitHub + Discord. Don't separate Discord by channel.
- **Resolved** = items in `### ✅ Resolved this week`, with a parenthetical short list.
- **Top pain** = largest pain cluster's short name + distinct-reporter count.
- **Top demand** = largest demand cluster's short name + distinct-asker count.
- **Open fix PRs** = aggregate count from Fix PR detection.
- **Enterprise reporters** = count this week + prior week + trend.
- **Reddit Pulse** = thread count + a one-phrase vibe (e.g. "mostly positive", "1 critical re: bundle size") + the top thread's permalink. Pull from the report's 🟠 Reddit Pulse section. **Skip the line entirely** if the reddit MCP wasn't configured (section says "source not configured") or it was a quiet week with nothing notable — don't emit an empty bullet.
- **Full report link** uses Slack's `<url|label>` syntax with the label `<Mon DD>-<DD>` matching the Notion title.
- **Emoji limited:** 📊 leads the week line, ✅ marks Resolved, 🚨 marks front-door, 🏢 marks enterprise, 🟠 marks Reddit Pulse. No other emoji.

## Payload file

Save to `/tmp/slack-msg.json`:

```json
{
  "text": "<the formatted message>"
}
```

Use `\n` for line breaks inside the JSON string. Escape `*` as needed if it appears in content.

## Curl command

After saving, output the exact curl Nathan runs:

```bash
curl -X POST -H "Content-Type: application/json" --data @/tmp/slack-msg.json "$SLACK_WEBHOOK_URL"
```

Webhook URL lives in Nathan's env. Don't include the URL inline; tell him to `export SLACK_WEBHOOK_URL=...` from the Slack app config first.

## Dual-community variant

When the weekly report covers both CopilotKit + AG-UI, the metrics view in Slack can either:

**Option A (combined):** Single bullets with combined counts. Front-door flags show all communities' categories. Top pain / top demand pick the loudest across both.

**Option B (split):** Two parallel bullet groups under separate `*CopilotKit:*` / `*AG-UI:*` sub-headers.

Default to Option A unless one community's signal dwarfs the other (e.g. CK has 14 reports, AG-UI has 2 — combined makes AG-UI invisible, split surfaces both).

## Post-publish workflow

Slack post is primarily for product + engineering. Marketing gets a separate cut on request — see CLAUDE.md commit history for the "marketing cut" template.

Don't post automatically. Always show the JSON to Nathan first, let him review and curl manually. Outpost will own auto-post when it lands.

## Cross-references

- `weekly-report` — the orchestrator invokes this skill at step 11
- The Notion page URL comes from the create-pages return value
