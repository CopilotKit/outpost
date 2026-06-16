---
name: weekly-report
description: Fri→Fri community signals routine across CopilotKit + AG-UI. Orchestrator that supervises subagents — Discord pull, GitHub pull, deep-read, reporter enrichment — and synthesizes a Notion report under the Community Signals parent page. Triggers on "go", "weekly report", "community signals", "run routine".
---

# Weekly community signals — orchestrator

You are the orchestrator. Your job is to **delegate the heavy work to subagents** so your context stays small, then synthesize their compact returns into the Notion report. Do not pull all Discord / GitHub data into your own context.

## Output

A new Notion page under **Community Signals** parent (`3673aa38-1852-80bc-a71f-d328d765668d`) titled:

```
Weekly Community Signal — <Mon DD>-<DD>, <YYYY>
```

The main page **is the CopilotKit report** — its body carries the CopilotKit community sections plus the cross-community 🏢 Enterprise section. **AG-UI always lives on its own sub-page**, created as a child of the main page and linked at the very top of the main page (via a `<page url="…">` block). There is **no top-level cross-community TL;DR** — each page leads with its own per-community TL;DR.

Covering the **most recent complete Friday→Friday week** (Friday end-date inclusive). State the window before pulling data.

## Orchestrator flow

1. **Determine the window.** Today's date → most recent complete Fri→Fri. State it.

2. **Spawn Subagent A — Discord pull.** Tell it to pull both servers:
   - CopilotKit (`1122926057641742418`): `#💬｜general` (text `1182553320540352563`) + `#🤔｜support` (forum `1313616713647919218`)
   - AG-UI (`1379082175625953370`): `#🔧-building` (text `1379082271642095738`) + `#✈️-support` (forum `1384529894972592158`)
   For forums use `mcp__discord__list_forum_threads` → filter to window → `mcp__discord__read_thread_messages` per in-window thread. **Read every thread to the bottom.** Return: compact per-channel substantive-message summary, with reporter handles + 1-line summaries. Skip hiring / self-promo / greetings (those roll up under Community Ops).

3. **Spawn Subagent B — GitHub pull.** Both repos, same window:
   ```
   gh issue list --repo CopilotKit/CopilotKit --state all --limit 60 --search "created:<start>..<end>" --json number,title,body,url,author,createdAt,state
   gh issue list --repo ag-ui-protocol/ag-ui --state all --limit 60 --search "created:<start>..<end>" --json number,title,body,url,author,createdAt,state
   ```
   Return: issue list tagged by community, with author + state + 1-line summary.

   **Catch escalations on old issues — the `created:` window misses them.** Also run an `updated:`-window search over OPEN issues (front-door categories especially: quickstart/CLI/install, upgrade path, docs landing, prod builds, auth/security) and **always read the comments** on anything that surfaces — escalations, maintainer commitments, and "fix in progress" status live in comments, not issue bodies:
   ```
   gh issue list --repo <repo> --state open --limit 60 --search "updated:<start>..<end>" --json number,title,url,author,createdAt
   ```
   An old front-door issue with in-window comment activity belongs in this week's report — in BOTH community reports if the broken artifact spans them (precedent: [ag-ui#1518](https://github.com/ag-ui-protocol/ag-ui/issues/1518), quickstart CLI broken since April, escalated via comment two months later; the failing `npx copilotkit` package made it a CopilotKit front door too).

4. **Spawn Subagent C — Deep-read** (see `deep-read-issue` skill). For each in-window actionable issue + every detected fix PR. Returns: file paths, reviewer concerns, hidden bugs, test coverage, fix-PR scope.

5. **Spawn Subagent D — Enrich reporters** (see `enrich-reporter` skill). For every GitHub author across both repos + the prior-week roster. Returns: company affiliation table + enterprise list.

6. **Spawn Subagent E — Reddit Pulse pull** (cross-community; uses the `reddit` MCP — `apps/reddit-mcp`, see CLAUDE.md Prerequisites). Window = past 7 days (`time=week`). Scope vars `REDDIT_BRAND_TERMS` + `REDDIT_WATCHLIST` live in the repo-root `.env`.
   - For each term in `REDDIT_BRAND_TERMS` (default: `CopilotKit`, `AG-UI`, `ag-ui`): `search_all(query, sort=new, time=week)`. Dedupe overlapping hits across terms.
   - For each subreddit in `REDDIT_WATCHLIST`: `search_subreddit(sub, "CopilotKit OR AG-UI OR agent UI")` plus a quick `subreddit_feed(sub, new)` scan for relevant titles.
   - For high-signal threads (notable score/comments, or clearly opinionated), `get_post(id)` and **read the top comments** — that's the sentiment signal.
   - Classify each thread 😀 positive / 😐 neutral / 😖 critical, and flag competitor comparisons (LangGraph, Vercel AI SDK, assistant-ui, Vapi, etc.).
   - **Relevance filter:** `ag-ui` / `AG-UI` is an ambiguous string — keep only threads about the CopilotKit / AG-UI agent-protocol project; drop unrelated matches (read the post to confirm).
   Returns: compact list — `r/<sub> | [title](permalink) | score · comments | 😀/😐/😖 | one-line` + an overall-vibe sentence + a competitor-comparison note. If the `reddit` MCP is unavailable/unconfigured, return that fact so the section can render "source not configured this week."

7. **Cluster into Demand + Pain.** Per community. Apply threshold rule:
   - 2+ distinct people this week, OR
   - 1+ this week AND verifiable prior reference (issue #, thread ID, prior-report URL).
   Singletons → Early signals.
   **Override:** front-door categories skip threshold (see `front-door-triage` skill).

8. **Compute trend vs prior 7 days.** ↑ grew · ↓ shrank · → flat · ↑ new cluster.

9. **Detect resolutions.** Classify each in-window CLOSED issue: `FIX_PR_MERGED` / `BACKFILLED` / `FALSE_POSITIVE` / `DUPLICATE` / `WONT_FIX` / `CLOSED_NO_ACTION`.

10. **Fix-PR detection** for every issue mentioned (this week + carryover):
   ```
   gh pr list --repo <repo> --state all --search "fixes #<num> OR closes #<num>" --json number,title,state,url,isDraft,mergedAt
   ```
   Markers: `🛠️ Fix PR [#NNNN](url) OPEN` · `🛠️ Fix PR [#NNNN](url) MERGED <date>` · `🛠️ No fix PR yet.`
   Procedurally-closed PRs (branch-name violation etc.) don't count as competing fixes — read closing comment.

11. **Build the Notion pages** via `mcp__plugin_Notion_notion__notion-create-pages`. Create the AG-UI sub-page FIRST (as a child of the main page), then the main CopilotKit page references it at top with a `<page url="…">` block. See "Page structure" below.

   **Notion tooling gotchas (learned the hard way):**
   - `notion-create-pages` interprets `\n` / `\t` escapes correctly — author content with them.
   - `notion-update-page` `replace_content` / `insert_content` do **NOT** interpret `\n` / `\t` — they pass through as literal `n` / `t` and mangle the page. Use **real newline and tab characters** in `new_str`.
   - `notion-update-page` `update_content` (search/replace via `content_updates`) **does** interpret `\n` — handy for surgical inline edits and small block inserts without rewriting the whole page.
   - `replace_content` deletes any child page not referenced in `new_str`. To preserve the AG-UI sub-page, include its `<page url="…">` block in the new content (don't rely on `allow_deleting_content`).

12. **Draft Slack TL;DR** via `slack-tldr` skill. Save to `/tmp/slack-msg.json`. Show Nathan to review before he curls.

13. **Verify every link before publishing.** Wrong links destroy trust in the report. Checks:
   - Every Discord thread URL: confirm the thread ID came from this run's `list_forum_threads`/pull output (never from memory or a prior report) and that the anchor text matches the thread's actual title/topic.
   - Every issue/PR number: the linked number must match the title quoted next to it.
   - External links (YouTube/Loom repro videos, docs): only use URLs that appear verbatim in the source thread/issue — never reconstruct from memory. Link repro videos explicitly; don't write "video on YouTube" without the URL.
   - Anchor text must name what the reader will land on ("Dojo jumpy scroll" → the jumpy-scroll thread, not an adjacent thread).

14. **Remind Nathan to record a Loom walkthrough — every report, no exceptions.** When he shares the link: add a `**Loom:** [Walkthrough](url)` line to the main page header (directly under the `**Week:**` line) and a `🎥 Walkthrough → <url|Loom>` line to the Slack message above the "Full report" link. Don't let the Slack message go out without asking about the Loom first.

## Page structure

**MAIN PAGE — CopilotKit + cross-community Enterprise**

```
[H1 title]
**Week:** Fri YYYY-MM-DD → Fri YYYY-MM-DD     ← only line in the header block

## 📦 CopilotKit                                ← community header at the very top of the page
*↓ Companion report — the AG-UI half of this week is on its own page:*   ← italic label so the link reads as nav, not a heading
<page url="…">AG-UI sub-page title</page>      ← AG-UI sub-page link (give the sub-page a DISTINCT icon, e.g. 🔷, so it doesn't mirror the 📦 header)
---                                             ← divider before the TL;DR

## TL;DR                                        ← CopilotKit metrics, hyperlinked bullets, front-door line first, 📚 Docs watch line second, 🟠 Reddit Pulse line third
   ### 🚨 Front-door flags                      ← toggle headings per flag
   ### 🔥 Demand
   ### 💢 Pain
   ### 📚 Docs                                  ← standing weekly section: drift / gaps / links-&-bot (see "Docs section" below)
   ### ✅ Resolved this week                    ← XML table
   ### 📊 Pulse                                 ← Volume + open fix PRs
   ### Community ops

## 🏢 Enterprise                                ← cross-community, BELOW the CopilotKit sections
   ### Surfaces this week                       ← table: Enterprise Intelligence, CopilotKit Cloud, License onboarding, Security disclosure channel, Self-host runtime. Skip SSO/OAuth + Billing rows when no reports.
   ### Enterprise reporters this week           ← prior-week comparison line + per-company bullets (spell out "Enterprise" — not just "Reporters this week")

## 🟠 Reddit Pulse                              ← cross-community external-signal read (see "Reddit Pulse section" below); lives on the MAIN page only, never the AG-UI sub-page

## 🔄 Patterns — CopilotKit                     ← CK-scoped, <details><summary> wrapped
## Gaps & follow-ups — CopilotKit               ← CK-scoped checklist
## Methodology                                  ← <details><summary> wrapped; threshold, window, sources
```

**AG-UI SUB-PAGE — same shape, AG-UI only**

```
[H1 title]
**Week:** Fri YYYY-MM-DD → Fri YYYY-MM-DD

## 📦 AG-UI                                     ← community header at the very top of every AG-UI page

## TL;DR
   ### 🚨 Front-door flags
   ### 🔥 Demand
   ### 💢 Pain
   ### 📚 Docs
   ### ✅ Resolved this week
   ### 📊 Pulse
   ### Community ops

## 🔄 Patterns — AG-UI                          ← AG-UI-scoped
## Gaps & follow-ups — AG-UI                     ← AG-UI-scoped checklist
## Methodology
```

If a per-community subsection is empty, render "No X this week." Don't omit the heading.

**Page split is mandatory, not conditional.** AG-UI always gets its own sub-page (even when thin); the main page is always the CopilotKit report. 🏢 Enterprise stays cross-community on the main page. 🔄 Patterns / Gaps / Methodology are split per page (CK-scoped on main, AG-UI-scoped on the sub-page).

**Every page leads with its community header.** The main page opens with `## 📦 CopilotKit`; every AG-UI page opens with `## 📦 AG-UI`. The community header is the first thing on the page (under the `**Week:**` line).

**TL;DR sits right under the community header.** On both pages the TL;DR is the first content section — above 🏢 Enterprise and everything else. On the main page, the AG-UI sub-page link goes between the `## 📦 CopilotKit` header and the `## TL;DR` (i.e. directly above the TL;DR). 🏢 Enterprise sits BELOW the CopilotKit sections, not above them.

**Sub-page naming.** Title the AG-UI sub-page `Weekly Community Signal — AG-UI — <Mon DD>-<DD>, <YYYY>` (e.g. `Weekly Community Signal — AG-UI — May 26-Jun 08, 2026`). Main page keeps `Weekly Community Signal — <Mon DD>-<DD>, <YYYY>`.

## Page rendering rules

- **Always-open sections:** Header, AG-UI sub-page link, 🏢 Enterprise (both subsections), per-community TL;DR, ✅ Resolved this week, Gaps & follow-ups.
- **Toggle headings (`### Title {toggle="true"}`):** every front-door flag + every Demand/Pain cluster card. Body bullets **tab-indented** to be inside the toggle.
- **No 🚨 on individual flag toggles.** The siren appears only on the `### 🚨 Front-door flags` section heading and the TL;DR front-door line — repeating it per flag looks bad.
- **`<details><summary>` blocks:** Early signals, Pulse body, Community ops, 🔄 Patterns, Methodology.
- **Notion XML `<table header-row="true">…</table>`** form (not Markdown pipes) inside toggles/details.
- **Visual polish:** AG-UI sub-page gets a distinct icon (🔷) so its link doesn't read as a duplicate of the 📦 header; an italic "↓ Companion report" label sits above the link; `---` dividers between the top-level `##` sections (TL;DR / Enterprise / Patterns / Methodology) to break up the column. (No table-of-contents — it ate too much vertical space.)

## TL;DR titles must be hyperlinks

Within each per-community `### TL;DR`:
- **Top pain — X** → link to the bug report (GitHub issue or canonical Discord thread). **Not the fix PR.**
- **Top demand — X** → link to the canonical request URL.
- **Pulse this week** → link to repo's open-PRs queue.
- **🏢 Enterprise reporters this week** → link to a `gh issues` filter URL listing the in-week enterprise authors, or omit if zero.

## Front-door flags lead the TL;DR

Add a `🚨 **Front-door flags this week**` line at top of each community's TL;DR bullets — count + linked categories. Even if zero, render "No front-door flags this week. ✅".

## Docs section (standing, weekly)

Every report carries a `### 📚 Docs` section per community, between 💢 Pain and ✅ Resolved. It is the weekly docs-debt window — three labeled item types, plain bullets (no toggles):

- **Drift** — code moved, docs didn't (wrong wrapper in a quickstart, page documenting a broken flow).
- **Gap** — a needed guide that doesn't exist (persistence per adapter, self-host AgentRunner, history retrieval).
- **Links/bot** — dead doc URLs, support-bot citing 404s or stale answers.

Rules:
- A docs item that **blocks** a new/upgrading user is ALSO a front-door flag — list it in both, labeled "(blocking — also flagged front-door)" in the Docs section. Non-blocking docs items live only here, never in front-door.
- Add a `📚 **Docs watch** — N items (M blocking): <short list>` line to the TL;DR, directly under the front-door line.
- Always render the section; if empty, "No docs items this week."

## Reddit Pulse section (cross-community)

A `## 🟠 Reddit Pulse` section on the **main page only** (never the AG-UI sub-page — it reads all of Reddit, not one community). It sits below 🏢 Enterprise, above 🔄 Patterns. This is the outside-the-walls read: what people say about CopilotKit / AG-UI on Reddit, good and bad.

Shape:
- **Vibe line (always open):** one sentence — overall sentiment + volume. e.g. *"Mostly positive (5 threads, 1 critical) — devs like the DX, one recurring gripe about bundle size; one head-to-head vs assistant-ui."*
- **Notable threads (`<details>`-wrapped):** oldest → newest, one bullet each:
  `**YYYY-MM-DD** · r/<sub> · [thread title](permalink) · score N · C comments · 😀/😐/😖 · one-line takeaway.`
- **Competitor comparisons:** call out any thread comparing CopilotKit/AG-UI to alternatives (LangGraph, Vercel AI SDK, assistant-ui, Vapi, …) — these are the highest-signal items for product/marketing.
- **TL;DR line:** add `🟠 **Reddit Pulse** — <N threads · sentiment> · <top-thread link>` to the main-page TL;DR, below the 📚 Docs watch line.

Rules:
- **Every thread is a hyperlink** to its Reddit permalink (same discipline as Discord/GitHub links).
- **Sentiment comes from reading the post + top comments**, not the title — use `get_post`. Don't infer "critical" from a title alone.
- **Relevance over volume:** drop ambiguous `ag-ui` string matches that aren't the project. A quiet week is fine — render "Quiet on Reddit this week." rather than padding with noise.
- **Source-gated:** if the `reddit` MCP isn't configured, render "🟠 Reddit Pulse — source not configured this week." and move on. Don't block the report on it.
- Company-readable: a marketer should be able to skim the vibe line and know how the brand is landing.

## Reporter formatting

- Every Discord mention is a hyperlink — no plain handles.
- **Every named entity in 🔄 Patterns is hyperlinked** — issue numbers → issue URLs, reporter handles → their thread/issue, named surfaces/features → their canonical artifact. No bare `#NNNN`, handles, or feature names in Patterns prose.
- Forum thread URL: `https://discord.com/channels/<guild_id>/<thread_id>` (parent forum channel ID NOT in URL).
- Text channel: link to channel + include date.
- GitHub: `[#NNNN](issue-url)` + backtick handle; no profile link unless they have no filed issue.
- Append `🏢 <Company>` badge inline next to enterprise users' handles. Indie / solo get no badge.
- Identity collisions: merge same person across handles silently in the count; note inline if useful.
- Same-author duplicate-filing: one reporter, one signal.

## Substantive vs process notes

The report is **company-readable** (product, marketing, leadership, sales/CS, engineering). Strip orchestrator process notes:

**Forbidden:** "1 empty thread skipped", "X excluded per triage rules", "identity-merged", "just outside window — flag next week", "compare against prior weeks once N reports exist", "(2 CLOSED WONT_FIX promo)".

**OK to keep:** "Workaround stuck; real fix is PR #5300", "Zero-effort bonus: healed ~10 quickstart docs", "Hidden second bug: snapshot leak; needs own issue", **Action:** lines.

Test before publishing: read each parenthetical aloud and ask "would a non-engineer marketing person care?" If no, cut it.

## Conventions

- **Dated report lists go oldest → newest.** Front-door entries, reporter rosters, Resolved rows.
- **Report list bullets = one sentence.** Leading `**YYYY-MM-DD**` · source icon · linked reporter (+ 🏢 if enterprise) · one-line summary. Deep technical detail lives in 🔄 Patterns or the linked issue.
- Don't post to Discord — read only.
- Don't ping users by handle in Notion; summarize impact instead.
- Reconfirm window at start so Nathan can catch a wrong week before the page lands.
- Convert relative dates to absolute ISO so the page stays interpretable later.

## Cross-referenced skills

- `front-door-triage` — P0 categories and classification rules
- `deep-read-issue` — subagent flow for issue + fix PR deep read
- `enrich-reporter` — subagent for GitHub author enterprise enrichment
- `slack-tldr` — Slack JSON format + curl command
- `enterprise` — standalone enterprise view (run separately or invoked here)
- `topic-search` — ad-hoc cross-repo topic lookup
