---
name: weekly-report
description: Fri→Fri community signals routine across CopilotKit + AG-UI. Orchestrator that supervises subagents — Discord pull, GitHub pull, deep-read, reporter enrichment, Reddit Pulse — and synthesizes a Notion report under the Community Signals parent page. Triggers on "go", "weekly report", "community signals", "run routine".
---

# Weekly community signals — orchestrator

You are the orchestrator. Your job is to **delegate the heavy work to subagents** so your context stays small, then synthesize their compact returns into the Notion report. Do not pull all Discord / GitHub / Reddit data into your own context.

## Maintaining these rules (meta-rule)

**Whenever the workflow gains or loses something — a section, a data source, a scoring change, a window change, a tool swap — update these skill rules in the SAME change, and clean them up.** Don't leave the old text sitting next to the new (that's how this file rots into contradictions). Remove the superseded rule, fix every place that referenced it (page-structure block, rendering rules, the relevant section spec, memory), and keep the file internally consistent. These skills are the source of truth for the manual routine until the native TS port lands ([#66](https://github.com/CopilotKit/outpost/issues/66)) — a rule that isn't written here doesn't exist.

**Also update the human-readable reference page in the SAME change.** Everything that goes into Community Signal is written down on the **Community Signal — Playbook & Reference** Notion page (child of the Outpost page): `https://app.notion.com/p/3913aa3818528149930feaf69de83b2b`. Whenever you change the workflow, mirror it there and **add a dated row to that page's Changelog table** — so there's one referable record humans can read without opening the skills. A change that isn't reflected on that page isn't done.

## Output

A new Notion page under **Community Signals** parent (`3673aa38-1852-80bc-a71f-d328d765668d`) titled:

```
Weekly Community Signal — <Mon DD>-<DD>, <YYYY>
```

The main page is the **CopilotKit** report. It opens with the `## 📦 CopilotKit` header + a link to the AG-UI companion sub-page, then **leads the body with the cross-community `## 🔝 Top issues of the week`** (ranked), then the CopilotKit community sections, then the cross-community 🏢 Enterprise, 🟠 Reddit Pulse — CopilotKit, and 🔄 Patterns sections. **AG-UI always lives on its own sub-page**, created as a child of the main page and linked at the top (via a `<page url="…">` block). The AG-UI sub-page holds AG-UI's per-community detail — including its **own** `## 🔝 Top issues of the week — AG-UI` (AG-UI-scoped) and its own 🟠 Reddit Pulse — AG-UI section. The main page's Top issues are cross-community (and may include AG-UI front-door breaks); the cross-community Patterns takeaways stay on the main page.

Covering the **most recent complete Friday→Friday week** (Friday end-date inclusive) for Discord + GitHub. (Reddit Pulse uses a rolling 90-day window — see step 6.) State the window before pulling data.

## The orchestrator verifies every subagent's work (supervisor rule)

**The orchestrator is accountable for everything published — a subagent's return is INPUT, not truth.** Every subagent (Discord pull, GitHub pull, deep-read, release-scan, enrich-reporter, enrich-prospect, Reddit Pulse, product-surface, link-review, report-sources) can be wrong, stale, or incomplete. Before using any return:

- **Spot-check its claims against source** — issue/PR numbers + state + dates (`gh`), versions (release-scan), company affiliation (bio, not just the `company` field), links resolve, product-surface quotes appear on the live page. If a claim can't be traced to a source, don't publish it.
- **Reconcile contradictions between subagents** — if two returns disagree (e.g. deep-read says OPEN but release-scan says shipped), run it down before writing.
- **The two formal gates are still mandatory:** the **link-review pass (step 14)** re-verifies every link + product-surface claim, and the **report-sources pass (14b)** defends every placement against evidence and **feeds corrections back into the report** (fix the report first, then the defense reflects it). Loop each until clean.
- **Re-spawn or correct** when a return looks off, rather than passing it through. Precedents this cycle: the Fri→Fri window was set to the wrong week and caught mid-run; enrich flagged a stale ("ex-") employer; the release cross-check caught issues already fixed in a shipped release. None of those should reach the published page.
- **The final state-refresh before publish (and any post-publish edit pass) covers EVERY referenced item, BOTH repos — never a subset.** Re-pull the live state of every issue/PR the report cites, even ones nobody flagged. A headline issue can close the same day it's ranked. If the user says "I touched some AG-UI items," still re-verify the CopilotKit items too. (Precedent: [#4893](https://github.com/CopilotKit/CopilotKit/issues/4893) was Top issue #1 at build time and closed hours later; an AG-UI-only refresh missed it because it was CopilotKit — it should have moved to Resolved.)

## Orchestrator flow

0. **Fresh pull first — before anything else.** `git pull` the repo so you're running the LATEST skills/rules (they're the source of truth and change often — a stale checkout runs an old spec). And pull **fresh** source data for the window from Discord / GitHub / Reddit every run — never reuse a prior run's pull, a cache, or last week's numbers.

1. **Determine the window.** Today's date → most recent complete Fri→Fri. State it.

1b. **Spawn Subagent H — product-surface scan** (see `product-surface-scan` skill). Spawn it **at report start, in parallel with A/B/G**. It fetches CopilotKit's product / pricing / Premium pages and returns: the authoritative **commercial-surface list** (drives the 🏢 Enterprise "Surfaces this week" table), the **free-vs-paid classifier** (used to decide whether each issue belongs in 🏢 Enterprise — a commercial surface — vs Pain/Demand), a **diff of what commercial features changed since last week**, and a **cross-page contradiction check** (page-vs-page / page-vs-source conflicts → the ⚠️ Product surface contradictions category). It writes nothing to the repo — the week-over-week baseline is last week's report in Notion (see "Report data lives only in Notion" below). **Enterprise = CopilotKit's commercial product, NOT "CopilotKit used at a big company"** — apply the classifier, don't shelve a free-OSS bug under Enterprise just because the reporter is enterprise.

2. **Spawn Subagent A — Discord pull.** Tell it to pull both servers:
   - CopilotKit (`1122926057641742418`): `#💬｜general` (text `1182553320540352563`) + `#🤔｜support` (forum `1313616713647919218`)
   - AG-UI (`1379082175625953370`): `#🔧-building` (text `1379082271642095738`) + `#✈️-support` (forum `1384529894972592158`)
   For forums use `mcp__discord__list_forum_threads` → filter to window → `mcp__discord__read_thread_messages` per in-window thread. **Read every thread to the bottom.** Return: compact per-channel substantive-message summary, with reporter handles + 1-line summaries. Skip hiring / self-promo / greetings entirely — they're not published (the Community ops section was removed).
   **Capture resolution signal per thread:** a **green-check ✅** reaction, or an explicit accepted/"marked solved" / "issue has been resolved ✅" marker in the comments, means the answer was confirmed correct → the thread counts as **resolved** (feeds ✅ Resolved this week + the Discord-resolved count, see steps 9 and Pulse). Be strict — a reply, a 👍, or a ❤️ is NOT a resolution; only a green-check / accepted-answer marker is. Return each thread's status `RESOLVED (green-check)` / `OPEN`.

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
   An old front-door issue with in-window comment activity belongs in this week's report — in BOTH community reports if the broken artifact spans them (precedent: [ag-ui#1518](https://github.com/ag-ui-protocol/ag-ui/issues/1518), quickstart CLI broken since April, escalated via comment two months later; the failing `npx create-ag-ui-app` scaffold made it a CopilotKit front door too).

4. **Spawn Subagent C — Deep-read** (see `deep-read-issue` skill). For each in-window actionable issue + every detected fix PR. Returns: file paths, reviewer concerns, hidden bugs, test coverage, fix-PR scope.

5. **Spawn Subagent D — Enrich reporters** (see `enrich-reporter` skill). For every GitHub author across both repos + the prior-week roster. Returns: company affiliation table + enterprise list.

5b. **Spawn Subagent D2 — Deep-enrich prospects** (see `enrich-prospect` skill). AFTER D classifies the enterprise list, take the **prospect shortlist** (recognizable enterprise / well-funded scale-ups, e.g. Jasper AI / commercetools tier) and deep-enrich each: LinkedIn profile (employer verified against the GitHub company — keep searching if mismatched), company website, company size (ARR / latest funding round / employee count). Returns one structured block per prospect for the 🎯 Prospective enterprise customers subsection. Run on the shortlist ONLY, not every reporter.

6. **Subagent E — Reddit Pulse pull** (per-community, rolling 90-day window). Data source = **Composio REST + a write-scoped API key** (NOT the `composio` MCP — its OAuth identity can't see the dashboard connection; and a default read-only API key 403s on `tool_execution`). See "Reddit Pulse section" for the full spec; the mechanics:
   - **Auth.** Need a Composio API key with the `Tools` resource = **Write**, set as `COMPOSIO_API_KEY` in repo-root `.env`. All calls use header `x-api-key: $COMPOSIO_API_KEY`.
   - **Get the connected account.** `GET https://backend.composio.dev/api/v3/connected_accounts?toolkit_slugs=reddit` → pick the `ACTIVE` account's `id` (`ca_…`; it changes whenever the auth config is recreated). If none is ACTIVE → render "source not configured" and move on. (Prior blockers, now avoided: the MCP entity mismatch + a default read-only key.)
   - **Window:** rolling **last 90 days**. Compute cutoff = now − 90d (epoch seconds); filter posts by `created_utc >= cutoff` client-side (Reddit search has no native date filter).
   - **Dedup ledger:** load `docs/community-signal/reddit-pulse-seen.json`. Skip any post `id` already listed. **Entries come in two shapes — bare `"1abc234"` strings (runs up to 2026-08-14) and `{"id": "1abc234", "created": "YYYY-MM-DD"}` objects (2026-08-21 onward) — so normalise before comparing:** flatten with `ids = entry.seen_ids.map(x => typeof x === 'string' ? x : x.id)`. A check shaped like `entry.seen_ids.includes(post.id)` or `new Set(entry.seen_ids)` matches **nothing** against the object shape, so every post recorded by a recent run would be re-reported next week — in the one file whose entire job is dedup. After the run, append ALL surfaced + dropped-as-noise ids under a new dated entry (so noise can't resurface).
     **Record each id WITH its post date — `{"id": "<base36>", "created": "YYYY-MM-DD"}` — so the >90d prune is actually possible.** Older entries store bare id strings and therefore **cannot be pruned**: a run window (e.g. `2026-03-21..2026-06-19`) spans both sides of any later cutoff, so you can't tell from the entry which of its ids have aged out, and dropping one that is still in-window would let that post re-report. Until every entry carries dates, **skip the prune and say so** rather than guessing — the file is a few hundred ids, so carrying extras costs nothing while a wrong prune costs a duplicate report. Readers of both shapes must tolerate bare strings and `{id, created}` objects.
   - **Execute via REST:** `POST https://backend.composio.dev/api/v3/tools/execute/<TOOL_SLUG>` with body `{"connected_account_id":"ca_…","arguments":{…}}`. Response posts nest under `.data.search_results.data.children[].data` (parse defensively — a `posts[]` array may also appear). Tools:
     - `REDDIT_SEARCH_ACROSS_SUBREDDITS` — one call per `REDDIT_BRAND_TERMS` entry (default `CopilotKit`, `AG-UI`, `ag-ui`), `restrict_sr=false`, `sort` new + relevance.
       **Bare brand terms alone LOSE POSTS — always run the narrowing queries too.** Reddit tokenizes `CopilotKit` as `copilot`+`kit` and `AG-UI` as `ag`+`ui`, so a bare `sort=new` search returns ~95% junk (exam-cheating spam, DNA reports, card collections) and **hits the 100-item cap inside the 90-day window**, silently truncating real hits. Add these six and they each return under the cap (= full recall): `title:copilotkit` · `selftext:copilotkit` · `title:"AG-UI"` · `"AG-UI protocol"` · `copilotkit agent` · `AG-UI CopilotKit`. (Precedent: on the 2026-08-14 run the bare queries capped out and the ONLY genuine CopilotKit mention of the cycle — a production user naming us across r/Playwright, r/mcp, r/AgentsOfAI and r/SaaS — was found only by the narrowing queries.)
     - `REDDIT_RETRIEVE_REDDIT_POST` — per `REDDIT_WATCHLIST` subreddit (default LocalLLaMA, LangChain, AI_Agents, nextjs, SaaS, LLMDevs) for landscape/competitor chatter.
     - `REDDIT_RETRIEVE_POST_COMMENTS` — for high-signal / debatable threads; pass the **bare base36 article id** (no `t3_`). Top comments are the sentiment.
   - **Relevance filter:** keep only genuine CopilotKit/AG-UI posts. Drop false positives (e.g. the `jscpd` tool listing CopilotKit in a scanned-repo list) and ambiguous `ag-ui` matches — but still record their ids in the ledger.
   - **Classify per post** 👍 good / 🙂 mixed-positive / 😐 neutral / 🫤 mixed-negative / 👎 pain, from post + top comments. Flag competitor comparisons (LangGraph, Vercel AI SDK, assistant-ui, Vapi…) and recurring comment themes (e.g. "how is AG-UI different from Google A2UI?").
   - **For scoring, fetch each distinct subreddit's recent `new` feed** (`REDDIT_RETRIEVE_REDDIT_POST` sort=new, ~30) → median of `(upvotes + 2·comments)` = the room baseline `M`. Needed for the reach weight + reception ratio (see "Reddit Pulse scoring algorithm").
   - **Split by community subject** (see "Reddit Pulse section") and **score each page 0–100** (see "Reddit Pulse scoring algorithm").
   Returns, per community: scored post list (`👍/🙂/😐/🫤/👎 · [title](permalink) · r/<sub> · ⬆score 💬comments · one-line`), the computed Pulse Score + band, an overall-vibe sentence, competitor + recurring-theme notes, and the list of ids to add to the ledger.

6b. **Spawn Subagent G — Release scan** (see `release-scan` skill). Spawn it **in parallel with Subagents A/B** (no other subagent depends on it; the fix-map is only needed by clustering/resolution). It pulls every CopilotKit + AG-UI release shipped in (and just after) the window, **diffs the git tags** — not the release notes, which are often empty stubs — to extract what each release fixed, and returns: the authoritative latest version per repo, the in-cycle release list, and a **fix-map** (`#NNNN · fixed in <version> · via PR #MMMM · what`). This is the source of truth for every version claim AND the input to the open-issue cross-check below.

7. **Cluster into Demand + Pain.** Per community. Apply threshold rule:
   - 2+ distinct people this week, OR
   - 1+ this week AND verifiable prior reference (issue #, thread ID, prior-report URL).
   Singletons → Early signals.
   **Override:** front-door categories skip threshold (see `front-door-triage` skill). Front-door / P0 items don't just headline their community — they feed the cross-community **🔝 Top issues of the week** ranking (see below), led by the biggest front-door break.
   **Bug vs feature-request first (use the `deep-read-issue` `TYPE:` verdict).** A **feature request goes to 🔥 Demand — never 💢 Pain or 🔝 Top issues** (Top issues + Pain are breakage; a feature gap isn't a break). The tell: a `feat(...)`/"proposal" PR, an `enhancement`/`feature` label, or a `Feature Request` / `[Feature]` / `RFC` title ⇒ feature ⇒ Demand. A `fix(...)` PR / `[Bug]` / error-crash-broken language ⇒ bug ⇒ Pain/Top-issue eligible. **Run these checks before classifying anything as a bug**; if it's genuinely ambiguous, flag it `UNSURE` and treat it as a candidate issue (as now) only after checking — don't default to bug. (Precedent: `ag-ui#2075` "Feature Request: ADK STEP events" with a `feat(adk)` PR was moved out of AG-UI Top issues into Demand.)

   **Exception — observed behaviour beats the template when the body reports a break.** The label/title tells above are about *how someone filed*, not *what the software does*. If a `[Feature]`/`enhancement` item's own body describes a crash, silent data loss, or wrong output, it is **breakage → 💢 Pain**, and the card says plainly that it was filed on a feature template. Reporters routinely pick the wrong template; the report classifies the defect, not the form. Keep the `UNSURE` flag and state the conflict on the card either way.
   (Precedent: `ag-ui#2254` — `[Feature]:` title + `enhancement` label, but the body reports document attachments silently never reaching the backend, in the *same file* as `ag-ui#2290`, which was filed as a bug. Originally placed in Demand on the label tell, which split one root cause across two sections; moved to Pain 2026-08-01.)

8. **Compute trend vs prior 7 days.** ↑ grew · ↓ shrank · → flat · ↑ new cluster.

8b. **Build the 📈 Trends strip** (see "Trends section"). ~12-week weekly series, cheap to compute:
   - **Bucket boundaries — use non-overlapping `[Sat … Fri]` weeks.** The window is stated Fri→Fri, but a `created:<Fri>..<Fri>` search counts BOTH Fridays, so consecutive weeks double-count the shared day. Query each week as `<Sat>..<Fri>` (the week labelled `Jul 24 → Jul 31` is queried `2026-07-25..2026-07-31`). Cross-check by summing the per-week counts against one full-range query — they must match exactly. (Adopted 2026-07-31; earlier reports double-counted, so historical rows read slightly higher in them. Add a one-line counting note under the table whenever the numbers differ from a prior published report.)
   - **Issues filed / week** — bucket the last 12 Fri→Fri weeks. Per week, per repo: `gh issue list --repo <repo> --state all --limit 500 --search "created:<wk-start>..<wk-end>" --json number --jq 'length'`. **Set `--limit` high enough that no bucket is truncated** (the flag caps the count) and say so if a week hits the cap. Main page = CK + AG-UI combined per week; AG-UI page = AG-UI only.
   - **Issues resolved (closed) / week** — same buckets: `gh issue list --repo <repo> --state closed --search "closed:<wk-start>..<wk-end>" --json number --jq 'length'`. Pairs with filed for the filed-vs-resolved chart. **Watch for bulk-close outliers** (a single week with a 100s-of-issues sweep) — cap the bar + annotate, don't let it set the scale.
   - **Reddit mentions / week** — from Subagent E's 90-day pull (≈13 weeks), bucket the surfaced+deduped brand-term posts by `created_utc`. Usually sparse → render as a one-line note, not a weekly bar chart, unless volume justifies bars.
   - Hand the series to the synthesis as small integer arrays → render as ASCII bars in the collapsible Trends toggle. This week's row is the bottom; the strip is what makes "30 issues" read as up/down/flat and shows whether the backlog is growing.

9. **Detect resolutions.** **First, verify live state for EVERY referenced issue — this decides open-vs-resolved, not the issue body or the thread narrative.** For each issue: `gh issue view <n> --repo <repo> --json state,stateReason,closedAt` AND follow its linked/closing PRs and check their merged state: `gh pr view <PR> --repo <repo> --json state,mergedAt,reviewDecision` (or read `closedByPullRequestsReferences`). **If the issue is CLOSED, or its closing PR is MERGED, it is RESOLVED — report it in ✅ Resolved, never as an open Pain/Top issue.** (This is the control that would have caught #4893: its fix PR #5883 was merged and the issue closed; reading the linked PR's merged state is a required check, not optional.) Then classify each in-window CLOSED GitHub issue: `FIX_PR_MERGED` / `BACKFILLED` / `FALSE_POSITIVE` / `DUPLICATE` / `WONT_FIX` / `CLOSED_NO_ACTION`. **Discord threads with a green-check ✅ / accepted-answer marker (step 2) are ALSO resolutions** — classify them `DISCORD_ANSWERED` and list them in ✅ Resolved this week alongside the GitHub closures. (A Discord thread can be resolved even when a related GitHub issue stays open — they're different tickets; resolve only what the green-check actually covers.)

9b. **Cross-check open issues against the release fix-map** (Subagent G). For every issue heading into Demand / Pain / Top issues / Early signals, check the fix-map. If it appears there, it shipped a fix we'd otherwise miss — **flag it inline, in place**: annotate `NOTE: appears fixed in vX.Y.Z (PR #MMMM) — verify` rather than silently reclassifying (a `Fixes #N` in a commit isn't always a complete fix; the human verifies before it moves to Resolved). Also stamp each `✅ Resolved this week` row with its `shipped in vX.Y.Z` from the fix-map.

10. **Fix-PR detection** for every issue mentioned (this week + carryover):
   ```
   gh pr list --repo <repo> --state all --search "fixes #<num> OR closes #<num>" --json number,title,state,url,isDraft,mergedAt
   ```
   Markers: `🛠️ Fix PR [#NNNN](url) OPEN` · `🛠️ Fix PR [#NNNN](url) MERGED <date>` · `🛠️ No fix PR yet.`
   **The `fixes/closes` search is NOT sufficient on its own — always also read the issue's own `closedByPullRequestsReferences`.** The search depends on GitHub's indexing and on *when* you ran it; the field is authoritative and cheap:
   ```
   gh issue view <n> --repo <repo> --json closedByPullRequestsReferences
   gh api repos/<repo>/issues/<n>/timeline --paginate --jq '.[] | select(.event=="cross-referenced")'
   ```
   **Re-run this on every ranked item during the final pre-publish refresh, not only during the first pull.** A fix PR can appear hours after the deep-read pass — and the busiest hour for it is right after a maintainer posts a root cause, which is exactly when a contributor picks the issue up.
   *(Precedent 2026-08-21: Top issue #1 `#3510` published as "no PR yet". PR #6648 declared `closes #3510` and was opened **56 seconds after** the contributor's claim comment — a comment the correction pass did record, without re-checking for the PR that followed it. Detection had run before the PR existed; `closedByPullRequestsReferences` would have caught it either way. Rank was unaffected because the PR was open, but the card was wrong on the most-read line of the report.)*
   **A claim comment is not a fix PR, and a fix PR is not a merge.** Record all three states distinctly: someone volunteered · a PR is open awaiting review · a PR is merged (→ ✅ Resolved).
   **The MERGED/OPEN marker must come from the live PR state (`mergedAt` non-null), never inferred from the thread — always read the actual PR.** A **MERGED** closing PR (or a CLOSED issue) means the item is **resolved** → it goes to ✅ Resolved (step 9), not into Pain/Top issues with a "fix PR merged" note. "Fix PR MERGED" on a *still-open* issue is only valid when the merge genuinely didn't resolve it (e.g. partial fix) — say why. Procedurally-closed PRs (branch-name violation etc.) don't count as competing fixes — read the closing comment.

11. **Score & rank the Top issues** (see the ranking rubric in `front-door-triage`). First **record the naive order** — what you'd get ranking the candidates by loudness alone (engagement: 👍 + comments, recency, reporter count) — so the comparison page can show the delta. Then **score each candidate on the five axes** (surface tier · blast radius · severity · exposure · signal), using measurable inputs — `gh issue view --json reactionGroups,comments,labels`, fix-PR status from step 10, Discord distinct-reporter counts, and the enrichment. Sum, sort descending; the top 3–5 are the Top issues, ranked. Keep BOTH the scored table and the naive order — they get published in the ranking + comparison child pages (step 12). Community (CK vs AG-UI) is never an axis.

12. **Build the Notion pages** via `mcp__plugin_Notion_notion__notion-create-pages`. Create the AG-UI sub-page FIRST (as a child of the main page), then the main CopilotKit page references it at top with a `<page url="…">` block. **Then create the child pages** at the bottom of the main report (children of the main page):
   - **`📊 Top-issue ranking`** — the rubric + this week's scored table.
   - **`🔬 Ranking comparison — before vs after the algo`** — naive-by-loudness order vs scored order, with the delta + a "why it moved" note.
   - **`🟠 Reddit Pulse — scoring algorithm`** — the standing, public algo page (sentiment tiers, engagement weight, formula, bands, worked example). **Reuse the canonical one if it already exists** — link it, don't recreate it weekly (the algorithm is constant; only the worked example refreshes). Currently at `https://app.notion.com/p/3843aa38185281019809caf6af8efd67`.
   Link the ranking + comparison from a bottom line on both pages; link the algo page from each 🟠 Reddit Pulse section. See "Page structure", "Top-issue ranking child page", and "Reddit Pulse section" below.

   **Notion tooling gotchas (learned the hard way):**
   - `notion-create-pages` interprets `\n` / `\t` escapes correctly — author content with them.
   - `notion-update-page` `replace_content` / `insert_content` do **NOT** interpret `\n` / `\t` — they pass through as literal `n` / `t` and mangle the page. Use **real newline and tab characters** in `new_str`.
   - `notion-update-page` `update_content` (search/replace via `content_updates`) **does** interpret `\n` — handy for surgical inline edits and small block inserts. **Notion normalizes stored markdown** (strips blank lines between bullets, may split one link into two) — so always `fetch` the page and match the *current stored* text in `old_str`, not the text you originally wrote.
   - **Never put a `####`/heading line inside an `update_content` `new_str`.** Re-inserting a card header mid-edit can strip its `{toggle="true"}` and de-indent the body — the card then renders flat (no ▸ triangle, fields un-nested). To add a field (e.g. an Owner line) to a card, anchor on a line INSIDE that card (its **Fix plan** / **Fix** / **Status** line) and append the new tab-indented line; never let the match span into the next card's `####` header. (Precedent: a `.NET` card edit whose `new_str` re-included the next `#### mastra …` header flattened the mastra card.)
   - `replace_content` deletes any child page not referenced in `new_str`. To preserve sub/child pages, include their `<page url="…">` blocks in the new content (don't rely on `allow_deleting_content`).
   - **Never start a link's anchor text with `[`** — Notion escapes the brackets and nests the URL inside itself, so `[[Feature]: Add X](url)` is stored as `\[\[Feature\]: Add X\]([url](url))` and renders as literal `[[Feature]: Add X]` followed by a raw-URL link. GitHub issue titles routinely begin `[Bug]:` / `[Feature]:`, so **strip or reword the leading bracket** when you use a title as anchor text (`[Feature: Add X](url)`). Applies everywhere, but bites hardest on 🎯 prospect `Issue:` lines. (Precedent 2026-08-14: three of five prospect issue links shipped broken and were caught by the link-review pass.)
   - **You cannot ADD a `<page url="…">` block for a child page — you can only MOVE the one that already exists.** Creating a page with `parent.type="page_id"` automatically appends its `<page url="…">` block to the END of the parent's content. Trying to insert a second copy fails with `validation_error: "Cannot add a page by using the corresponding tag with a URL."` To place the AG-UI companion link up under the community header, issue **one `update_content` call with two `content_updates`**: the first replaces the auto-appended tag with an empty string, the second re-inserts that same tag at the anchor line. (The bottom-of-page child pages — ranking, comparison, Report Sources — need no move: appended-at-the-end is already where they belong.) To reference a page *inline* instead, use `<mention-page>` or a plain markdown link — that's also the only way to link a page that is NOT a child of this report, e.g. the standing Reddit Pulse algorithm page.

13. **Draft Slack TL;DR** via `slack-tldr` skill. Save to `/tmp/slack-msg.json`. Show Nathan to review before he curls.

14. **Spawn Subagent F — link review (after the pages are built).** A dedicated review pass over both published pages. Two jobs:
   - **Claim support — open every Source link and ask whether it evidences the sentence beside it.** This is a SEPARATE check from coverage and correctness, and it is the one that has actually failed: a link can resolve, carry the right issue number, and match its quoted title, while still pointing at something that proves a *different* thing than the card asserts. Flag any card whose source, read cold by someone who knows nothing about the run, would lead them to the opposite conclusion. See "Source links are mandatory" for the 2026-08-14 precedent that both other checks passed.
   - **Fix-plan PR links — the PR leads the line, every named PR is clickable, and every "no fix PR yet" is re-checked.** Walk every card's **Fix plan** / **Status** / **Fix** line and confirm it opens with the linked live PR (`[PR #NNNN](url) · …`) or with `No PR yet · …`. Any PR referenced anywhere in the line must be a markdown link — flag bare `#NNNN`. Any card claiming no fix PR must be re-verified against the issue's `closedByPullRequestsReferences` at review time, because a PR can land after the report is drafted. Flag stale "not started" lines.
   - **Coverage — every item has a source link.** Scan every Top-issue card, Demand/Pain bullet, Docs bullet, Resolved row, Reddit Pulse thread, Enterprise reporter, and Patterns entity. **Any item with no source link is flagged.** For each flagged item, hand it to a search retrieval pass (gh search for the issue/PR, Discord `list_forum_threads`/search for the thread, Composio for the Reddit permalink) to find the canonical link. If a link is found → add it. If none can be found → **the item does not stay on the page** (remove it). No bare claims survive. (See "Source links are mandatory".)
   - **Correctness.** For links that exist: every Discord thread URL's thread ID came from this run's pull (never memory/prior report) and the anchor matches the thread's title; every issue/PR number matches the title quoted next to it; every Reddit permalink is the one returned by Composio this run; external links (YouTube/Loom repro, docs) appear verbatim in the source — never reconstructed; anchor text names what the reader lands on.
   - **🎯 Prospect LinkedIn links are sales-critical — VERIFY each against the person's own GitHub `social_accounts`.** For every prospect, run `gh api users/<login>/social_accounts`. If the person self-linked a `linkedin` URL there, the report's LinkedIn link **MUST equal it exactly** — a differing link is a wrong-person guess and must be corrected (or set to "LinkedIn not confirmed"). A self-linked account is authoritative; never publish a name-searched LinkedIn when the profile provides its own. (Precedent: the report linked `in/nchatlapalli` for Ashling Partners' Naveen when his GitHub self-linked `in/navaifanatic` — a different person.) **The published name must match the linked profile — verify it.** LinkedIn itself usually can't be fetched (returns HTTP 999), so confirm the person's FULL name (first + last) against a self-owned source that IS fetchable — their self-linked blog/personal site or a LinkedIn article they authored (byline). GitHub's `name` field is often just a first name or a handle — never publish that alone for a sales list. Don't attach a surname the sources don't support. (Precedent: published "Naveen" then a wrong-person link; his self-linked blog gave the full "Naveen Chatlapalli" and his GitHub self-linked the correct profile.)
   - **Product-surface claims re-verified against the live page.** Re-fetch the relevant page (`WebFetch` /pricing, /product, Intelligence, the products PDF) for every ⚠️ Product surface contradiction card, every 🏢 Enterprise "Surfaces this week" row, and any tier/price/Premium/free/"coming soon" statement anywhere in the report. Confirm the exact claim appears on the live page **now**. Anything that can't be quote-confirmed is **corrected or removed before publish** — a contradiction whose two quotes don't both check out is dropped.
   Returns: the flagged-item list + what was retrieved/removed. Re-run until zero linkless items remain.

14b. **Spawn the Report Sources subagent** (see `report-sources` skill). After the link-review pass, build a **"Report Sources"** child page for the report — an evidence-backed defense of WHY every item landed in its column/section/rank (front-door yes/no, the five-axis rank, bug-vs-feature, community attribution, resolved class, enterprise/prospect, maturity flag). Lawyer-rigorous (claim → evidence → rule → rebuttal → confidence) but **under oath — every claim cites a verifiable source, no invention/spin, weaknesses conceded.** One per report page (main + AG-UI). Create the returned page as a child at the bottom of the report.
   **Findings feed BACK into the report — always.** If this pass uncovers a discrepancy (wrong resolved class/date, wrong attribution, stale version, a rank whose inputs don't add up, a "fixed" with no merged PR), **correct the report item first, then the defense reflects the corrected state** — the Report Sources page never sits next to a report it just proved wrong. Loop until zero entries contradict the report. (Precedent: the sources pass caught `ag-ui#2048` listed as `FIX_PR_MERGED / 07-01` when it was `CLOSED COMPLETED 2026-06-29` with no linked PR → the Resolved row was corrected, then defended.)
   **This pass also writes the `Gaps & follow-ups` items** — it returns a short plain-human checklist of what's unresolved, which the orchestrator drops into the report's Gaps section. Written so the reader can't tell it came from an evidence pass (no lawyer voice, no citations) — see `report-sources`.

14c. **Carry owners forward from last week** (see `carry-forward-owners`). Diff the just-built report against the PRIOR week's report and find every item that appears in **both** — matched on the canonical source identifier (`repo#number`, Discord thread id, prospect GitHub login), **never on card titles**, which get re-worded between weeks. For each recurrence, print the `Owner:` value the prior report recorded, **verbatim including its `<mention-user url="user://…"/>` tag**, so it can be re-pasted. **PRINT ONLY — never write an owner into a page**; Nathan verifies each match and re-tags by hand. Three things the pass must separate: a real assignee (carry it), a `(reported by …)` mention (that's the REPORTER — never carry), and an item unowned in both weeks (escalate as **⚠️ Unowned N weeks running** and add to Gaps). Also state when a recurring item has since landed in ✅ Resolved, so nobody re-tags closed work. Run it after 14b and **before** the Slack TL;DR and Loom, since a reassignment changes what the Loom says needs an owner.

15. **Generate the Loom walkthrough script + remind Nathan to record it — every report, no exceptions.** As the LAST step, invoke the `loom-walkthrough` skill to produce the ≤10-minute plain-spoken walkthrough briefing from the finished report (plain English, factual — a briefing, not a radio show; includes the CEO-level Pain read) so recording is painless. Then remind him to record. When he shares the link: add a `**Loom:** [Walkthrough](url)` line to the main page header (directly under the `**Week:**` line) and a `🎥 Walkthrough → <url|Loom>` line to the Slack message above the "Full report" link. Don't let the Slack message go out without asking about the Loom first.

16. **Update the ledger + the rules.** Write the run's surfaced + noise post ids into `docs/community-signal/reddit-pulse-seen.json`. And per the meta-rule at the top: if anything about the format changed this run, update these skill files in the same pass.

## Page structure

**MAIN PAGE — CopilotKit + cross-community Enterprise / Reddit / Patterns**

```
[H1 title]
**Week:** Fri YYYY-MM-DD → Fri YYYY-MM-DD     ← only line in the header block (+ **Loom:** line once recorded)

## 📦 CopilotKit                                ← community header, at the very top of the body
*↓ Companion report — the AG-UI half of this week is on its own page:*   ← italic label so the link reads as nav, not a heading
<page url="…">AG-UI sub-page title</page>      ← AG-UI sub-page link (give the sub-page a DISTINCT icon, e.g. 🔷, so it doesn't mirror the 📦 header)
---

## 📈 Trends {toggle="true"}                    ← collapsible context strip, cross-community. ONE ~12-week filed-vs-resolved table (Week · Filed · Resolved, counts + bars) + the per-community month-over-month table + a Reddit-mentions note. See "Trends section".
---

## 🔝 Top issues of the week                    ← THE LEAD body section — cross-community, ranked by importance. Each item a toggle: what · impact · fix plan · owner · priority, tagged [CK]/[AG-UI]. Lead with the biggest front-door break. See "Top issues of the week".
---

## ⚠️ Product surface contradictions            ← CONDITIONAL — render ONLY when `product-surface-scan` finds a page-vs-page (or page-vs-source) conflict; sits here, under Top issues + above Enterprise. One card per contradiction: what conflicts · both quoted claims · both page links · suggested source of truth · Owner blank + Priority. When there are none, OMIT this section — a quiet "Product pages checked for contradictions — none this week." line + the referenced-page list lives inside 🏢 Enterprise instead. See `product-surface-scan`.
---

## 🏢 Enterprise                                ← ELEVATED — sits directly under Top issues / the contradictions category (highlighted near the top, not buried). Cross-community. **Scope: CopilotKit's COMMERCIAL surfaces** (Premium / CopilotKit Enterprise / Intelligence Platform / paid tiers), NOT "CopilotKit used at a big company" — apply the `product-surface-scan` classifier. See "Enterprise section".
   ### 🚩 Enterprise questions & complaints     ← any enterprise-related question/complaint this week (e.g. threads/persistence = the "enterprise threads" tier). Each a card with owner + priority. Highlighted at the top of this section.
   ### 🎯 Prospective enterprise customers {toggle="true"}   ← COLLAPSIBLE, company-first. Community members who look like enterprise prospects (e.g. Jasper AI), deep-enriched (LinkedIn + company site + size) via `enrich-prospect`, each with a **Passed to (sales):** owner field. See "Prospective enterprise customers".
   ### Surfaces this week                       ← table: Enterprise Intelligence, CopilotKit Cloud, License onboarding, Security disclosure channel, Self-host runtime. Skip SSO/OAuth + Billing rows when no reports.
   ### Companies building on us this week       ← CURRENT-employer only; per-company bullets
   ### Enterprise-offering reactions            ← reaction to Slack / Teams / threads-persistence; state the silence explicitly when there's none
---

   ### 🔥 Demand                               ← CopilotKit community body; plain `###` header, each item a `#### {toggle}` card (see "Section item cards")
   ### 💢 Pain                                  ← plain `###` header, each item a `#### {toggle}` card (What/Impact/Fix plan)
   ### 📚 Docs                                  ← standing weekly section; plain `###` header, each item a `#### {toggle}` card (see "Docs section")
   ### ✅ Resolved this week                    ← XML table
   ### 🌱 Early signals                         ← CONDITIONAL — `<details><summary>` block; singletons / one-off low-volume items not yet a pattern (step 7 routes them here). Tables / one-liners, NOT full cards. Omit when there are none.
---

## 🟠 Reddit Pulse — CopilotKit · <band> NN/100 {toggle="true"}   ← CopilotKit-subject Reddit posts only, scored. Collapsible; score+band in the heading. (see "Reddit Pulse section")
---

## 🔄 Patterns — the takeaways {toggle="true"}   ← collapsible, cross-community. The compressed read — what to act on. Body tab-indented to nest in the toggle.
## Gaps & follow-ups                            ← cross-community checklist, drawn from the report-sources evidence but written plain-human (see "Gaps & follow-ups")
## Methodology                                  ← <details><summary> wrapped; threshold, window, sources
<page url="…">📊 Top-issue ranking</page>      ← child pages at the very bottom
<page url="…">🔬 Ranking comparison</page>
<page url="…">🟠 Reddit Pulse — scoring algorithm</page>
<page url="…">Report Sources</page>            ← evidence-backed defense of every placement (see `report-sources`)
```

**AG-UI SUB-PAGE — same shape, AG-UI only**

```
[H1 title]
**Week:** Fri YYYY-MM-DD → Fri YYYY-MM-DD

## 🔷 AG-UI                                     ← community header (distinct 🔷 icon) at the very top of every AG-UI page
*↑ Companion report — the CopilotKit half of this week is the main page:*   ← italic nav label (mirrors the main page's companion link)
<page url="…main report…">CopilotKit main report title</page>             ← companion link BACK to the main page (every AG-UI page has one)
## 📈 Trends — AG-UI {toggle="true"}            ← collapsible context strip, AG-UI-scoped: ONE filed-vs-resolved table + per-community month-over-month table + Reddit-mentions note, ~12 weeks. (Enterprise + prospects stay cross-community on the main page — not duplicated here.)
---

## 🔝 Top issues of the week — AG-UI            ← AG-UI's OWN ranked list. AG-UI front-door breaks appear here AND on the main page; CopilotKit-only issues NEVER appear here. Same card format (### 1. … {toggle}, with owner + priority). Note "(also Top issue #N on the CopilotKit report)" on the shared ones.
---

   ### 💢 Pain                                 ← AG-UI community body; plain `###` header, each item a `#### {toggle}` card (see "Section item cards")
   ### 🔥 Demand                                ← plain `###` header, each item a `#### {toggle}` card
   ### 📚 Docs                                  ← plain `###` header, each item a `#### {toggle}` card
   ### ✅ Resolved this week
   ### 🌱 Early signals                         ← CONDITIONAL — `<details><summary>` block; AG-UI singletons not yet a pattern. Tables / one-liners, not full cards. Omit when there are none.
---

## 🟠 Reddit Pulse — AG-UI · <band> NN/100 {toggle="true"}   ← AG-UI-subject Reddit posts only, scored. (see "Reddit Pulse section")
---

## 🔄 Patterns — AG-UI {toggle="true"}          ← collapsible, AG-UI-scoped; points to the main "Patterns — the takeaways" for the cross-community read
## Gaps & follow-ups — AG-UI                     ← AG-UI-scoped checklist
## Methodology
<mention-page>📊 Top-issue ranking</mention-page>  ← bottom link to the main report's ranking child page
<page url="…">Report Sources</page>            ← AG-UI page's own evidence-backed defense (see `report-sources`)
```

If a per-community subsection is empty, render "No X this week." Don't omit the heading.

**Page split is mandatory, not conditional.** AG-UI always gets its own sub-page (even when thin); the main page is always the CopilotKit report. 🏢 Enterprise, 🔝 Top issues, and 🔄 Patterns — the takeaways are cross-community on the main page. 🟠 Reddit Pulse is split per community (each page scores its own posts). Gaps / Methodology are split per page; AG-UI keeps a short AG-UI-scoped Patterns that points back to the main takeaways.

**Order on the main page:** `## 📦 CopilotKit` header + companion link **first**, then `## 🔝 Top issues of the week`, then the CopilotKit community body. (There is no `## TL;DR` heading — that wrapper was removed; Demand/Pain/Docs/Resolved/Pulse/ops sit directly under Top issues. Front-door breaks are the Top issues, not a separate TL;DR line.) The AG-UI sub-page opens with its `## 🔷 AG-UI` header + companion link, then its **own** `## 🔝 Top issues of the week — AG-UI`.

**Sub-page naming.** Title the AG-UI sub-page `Weekly Community Signal — AG-UI — <Mon DD>-<DD>, <YYYY>`. Main page keeps `Weekly Community Signal — <Mon DD>-<DD>, <YYYY>`.

## Page rendering rules

- **Always-open sections:** Header, 📦/🔷 community header + companion link, 🔝 Top issues of the week, 🏢 Enterprise (all subsections), ✅ Resolved this week, Gaps & follow-ups.
- **📈 Trends is a collapsible heading toggle** (`## 📈 Trends {toggle="true"}`) — its whole body (both tables + notes) is **tab-indented** to nest inside the toggle. (Notion heading-toggles only collapse children that are indented; un-indented tables render outside the toggle.)
- **Toggle headings:** every Top-issue card (`### N. … {toggle="true"}`), **every item card in 🔥 Demand / 💢 Pain / 📚 Docs** (`#### … {toggle="true"}` — see "Section item cards"; the 🔥/💢/📚 section headers themselves are plain `###`, not toggles), and **each 🟠 Reddit Pulse section** (`## … {toggle="true"}`, with its score + band in the heading so it reads while collapsed). Card/body lines **tab-indented** to sit inside the toggle.
- **No 🚨 sirens on the Top-issue cards.** Rank them `### 1.` / `### 2.` … — the numbering carries the priority.
- **Collapsible:** `## 📈 Trends`, `## 🟠 Reddit Pulse`, and `## 🔄 Patterns — the takeaways` are heading toggles (`{toggle="true"}`, body tab-indented). Early signals + Methodology stay `<details><summary>` blocks.
- **Notion XML `<table header-row="true">…</table>`** form (not Markdown pipes) inside toggles/details.
- **Visual polish:** AG-UI sub-page gets a distinct icon (🔷) so its link doesn't read as a duplicate of the 📦 header; an italic "↓ Companion report" label sits above the link; `---` dividers between the top-level `##` sections to break up the column. (No table-of-contents — it ate too much vertical space.)

## Section item cards (the universal format)

Every reported item — in 🔝 Top issues, 🔥 Demand, 💢 Pain, and 📚 Docs — renders as a **self-contained toggle card**, never a run-on paragraph bullet. This is the format readers like on Top issues; it now applies to every section. A wall of prose in Pain (or anywhere) is the anti-pattern this replaces — if a reader has to parse a paragraph to find the impact, the card failed.

**This report is read by HUMANS, not agents.** No card is a wall of text. Each field is one short, plain, readable line/clause a busy non-engineer scans in seconds. If a field reads like an agent wrote it (meta, scores, jargon dumps, "this issue…"), rewrite it in human voice.

- **Section header stays a plain heading** (`### 🔥 Demand`, `### 💢 Pain`, `### 📚 Docs`). **Each item under it is its own toggle card**, one level down: `#### <short title> {toggle="true"}`. (Top issues are ranked one level up — `### N. <title> {toggle="true"}` — same card body.)
- **Short title ≈ 3–6 words that name the thing** (`A2UI needs scaffolding`, not `Issue with A2UI`).
- **Card body = these tab-indented labeled lines, IN THIS ORDER:**

  | Line | Label | Content |
  |---|---|---|
  | 1 | **What it is:** | One plain-English line — what the thing actually is, said the way a person would out loud. NOT agent/meta (never "Landed Top issue #1, score 13, mirrored into Enterprise" — placement is obvious from where the card sits). ~8–18 words. Surface experimental/deprecated/pre-release maturity here in plain words if it applies. |
  | 2 | **Source:** | The platform + the linked number/thread + **when it was opened**: `GitHub [#NNNN](url) · opened YYYY-MM-DD` or `Discord [thread](url) · opened YYYY-MM-DD`. (Mandatory source link; the created date is absolute ISO, from `gh issue view <n> --json createdAt` / the thread's first message. On a multi-issue card, list each date, e.g. `· opened 2026-03-23 / 2026-07-21`.) |
  | 3 | **Reported by:** | The reporter's handle **linked to their GitHub profile** — `[``login``](https://github.com/login)` — plus a **linked** `🏢 [Company](company-url)` badge if enterprise. Both the profile URL and the company URL come from `enrich-reporter`; never leave the handle or company as plain text. Multiple reporters → link each. |
  | 4 | **Description:** | The longer, very-readable explanation — 1–3 human sentences, no wall of text, no jargon dump. This is where detail lives (not the one-liner). |
  | 5 | **CPK version:** | Just the version number — `v1.61.0`, `@copilotkitnext/core 1.54.0`, `unknown`, or `n/a — AG-UI`. **Number only** — the deprecated/experimental note goes in *What it is* / *Description* / *Fix plan*, not here. |
  | 6 | **Impact:** | Human-readable — who it hits and how bad, in plain terms. (Demand: this is "why it matters".) |
  | 7 | **Fix plan:** | **The linked PR comes FIRST, before the prose** — same shape as the *Source* line, so the reader can open the thread without hunting for the link. Format: `**Fix plan:** [PR #NNNN](url) · <status> — <prose>`. Write the anchor as `PR #NNNN` (not bare `#NNNN`, which reads as an issue), separated from the status by ` · `. When there is no PR: `**Fix plan:** No PR yet · <status> — <prose>`. When several PRs are in play, lead with the **live** one and mention the closed or competing ones in the prose, linked. Status vocabulary: shipped / in progress / in testing / not started.<br/>**The link is mandatory whenever a PR exists.** Never write a bare `#NNNN` or the words "a PR" with nothing to click — the reader's next action after a Fix plan is to open the thread, and an unlinked PR silently blocks it. A "No PR yet" claim must be backed by the issue's `closedByPullRequestsReferences` per step 10, not by a search. (Demand → **Status:**; Docs → **Fix:** — same leading-link rule.) |
  | 8 | **Owner + Priority** | `**Owner:** _<blank — Nathan fills>_ · **Priority:** 🔴 High / 🟡 Medium / 🟢 Low`. **Mandatory on 🔝 Top issues, 🏢 Enterprise, 💢 Pain, and 📚 Docs cards** (optional only on 🔥 Demand). Owner always blank (never auto-named); Priority derived from the rank/severity (see `front-door-triage`). |

- **Docs cards:** prefix *What it is* with the type — `Drift` / `Gap` / `Links-bot`.
- **Deprecated `@copilotkitnext/*` (still true, just relocated):** it's the useAgent-era experimental v2 line, deprecated on npm 2026-06-18 → merged into `@copilotkit` v2 (`@copilotkitnext/core`→`@copilotkit/core`, `/react`→`@copilotkit/react-core/v2`, `/runtime`→`@copilotkit/runtime/v2`; last publish 1.54.1). When a reporter is on it: say so in **What it is** (plain: "on a retired/experimental package"), keep **CPK version** to the bare number, and have **Fix plan** lead with "ask them to migrate to `@copilotkit` v2 — the bug may already be gone there." Cite the exact subpackage, never the bare scope; only when the reporter's own text used it (agents invent it from training data).
- **One item, one card — no exceptions, no bundling to save space.** Don't merge two unrelated reports; depth lives in **Description** or the linked issue, never a run-on paragraph. **This holds even for small "housekeeping" items**: a release-cut request, a docs-table addition, and an SDK chore are three different issues → three cards, in whichever section each belongs (they rarely share one). Never combine multiple issue numbers into a single card. If several issues are genuinely the same root cause (e.g. two bugs in one adapter by one reporter), a shared card is fine — but distinct asks are never bundled.

Sections that do NOT use this card format: ✅ Resolved (XML table), 🟠 Reddit Pulse (one-line post bullets), 🎯 Prospective enterprise customers (its own company-first block — see that section), Early signals — these stay tables / one-liners as specified.

## Source links are mandatory

**Every item on the report carries a source link — no link, it does not get published.** This is a hard rule, not a preference. It applies to every Top-issue card, Demand/Pain bullet, Docs bullet, Resolved row, Reddit Pulse thread, Enterprise reporter, and every named entity in Patterns.

- The link points to the **canonical source**: GitHub issue/PR URL, the Discord forum-thread URL, or the Reddit permalink — wherever the claim originated.
- **A link that resolves is not the same as a link that SUPPORTS the claim — check what a reader lands on.** For every card, open its own Source link and ask: *does this page actually evidence the sentence next to it?* If it doesn't, the card is mis-sourced even though nothing is broken — the link is live, the title matches, and the reader still concludes the opposite of what you wrote. **Cite the artifact that carries the evidence**, which for a release/publishing problem is the merged PRs plus the registry output, not the issues those PRs closed. (Precedent 2026-08-14: Top issue #1 was "merged fixes aren't reaching npm" but sourced to `ag-ui#2305`/`#2306` — two *tool-error* bugs, closed and fixed. Following them showed fixed work and nothing about publishing, so the reader reasonably concluded the whole item was resolved. Both automated gates passed it: coverage checked that links exist, correctness checked that numbers matched titles, and **neither asked whether the source supported the claim.** Re-sourced to PRs `#2330`/`#2335`/`#2316`/`#2317` + npm/PyPI timestamps.)
- **Beware preview-channel comments on merged PRs.** `pkg.pr.new`, TestPyPI and canary/`.dev` bot comments make a merged PR look published. They are per-PR previews. Only a stable version on the `latest` dist-tag (npm) or `info.version` (PyPI) counts as released.
- If you have an observation but no sourceable link, **do not write it as a bare claim** — find the link, or leave it out. The step-14 review pass (Subagent F) enforces this: it walks the finished pages, flags every linkless item, retrieves the missing link via search, and deletes anything that still can't be sourced.

## Top issues of the week (the lead body section)

The body **leads** with `## 🔝 Top issues of the week` — cross-community, directly under the CopilotKit header + companion link. Front-door breaks ARE the top issues, ranked together across both repos.

What goes in it (per leadership):
- **A merged/confirmed fix is NOT an open Top issue — rank by "is the underlying problem solved?", not "is the ticket open?"** If the fix PR is MERGED (even if unreleased), or a maintainer/reporter says "this can be closed," the item is **resolved / release-pending** → put it in ✅ Resolved (note "shipped-pending-release" if the release hasn't cut), never at the top of the open-break list. Read the thread to the BOTTOM: a "looks fixed on main, can close" comment outranks an earlier "this is a blocker" escalation. (Precedent: [#4893](https://github.com/CopilotKit/CopilotKit/issues/4893) was ranked Top issue #1 as "fix merged, unreleased" when the thread already had a maintainer "can be closed" and it closed that day — it should have been Resolved from the start.)
- **Not exhaustive — only what leadership should actually know.** 3–5 items, max. A quiet week can have fewer.
- **Ranked by importance.** Number them `### 1.` `### 2.` … Lead with the biggest front-door break — the surface the most users hit. A broken install/quickstart CLI (e.g. `npx create-ag-ui-app`) is a bigger front door than any single feature bug; an outage on the current release is front-page.
- **Each card is self-contained** — four lines:
  - **What:** the concrete failure.
  - **CopilotKit version:** the version the reporter is on (from repro / body / comments), or `unknown` — see "Section item cards".
  - **Impact:** who hit it and how bad.
  - **Fix plan:** `[PR #NNNN](url) · <status> — <prose>` — **the linked PR leads the line**, before the prose, mirroring the *Source* line (see the card-format table). `No PR yet · …` when there is none. Call out **"fixed same day"** when true.
  - **Owner + Priority** (meta line): `**Owner:** _<blank>_ · **Priority:** 🔴 High / 🟡 Medium / 🟢 Low` — owner left blank for Nathan to assign; priority derived from the rank (see `front-door-triage` "Priority from rank").
- **Tag each `[CK]` / `[AG-UI]` / `[CK + AG-UI]`** and link the canonical issue.
- **Front-page items get the CI-gap takeaway.** If something big shipped broken, ask "how did this ship?" — usually a missing smoke test.
- The front-door P0 categories (`front-door-triage` skill) define what's *eligible*; the ranking decides what's *shown*.

**Per-page scope (both pages carry a Top issues list):**
- **Main (CopilotKit) page** — `## 🔝 Top issues of the week`, **cross-community**: ranks CK + AG-UI items together. An AG-UI front-door break can lead here.
- **AG-UI sub-page** — `## 🔝 Top issues of the week — AG-UI`, **AG-UI-only**: its own ranked list of AG-UI issues.
- **ALWAYS run the front-door check before demoting an AG-UI issue off the main list — never assume.** The test: *does it block the DOCUMENTED quickstart / getting-started path, or a core integration the general audience actually hits?* Read the repro + the getting-started docs to answer it, don't guess. If it breaks the front door → it stays on the main cross-community list (and both pages). Only a BROAD front-door break (install/quickstart CLI, current-release outage, default-path integration) earns a main slot; a **narrow AG-UI-specific issue stays on the AG-UI page ONLY** — do not duplicate it onto the main page just because it's a Top issue for AG-UI.
  - **Worked precedent — `ag-ui#2067` (FastAPI hard-import):** front-door check = **PASSED as narrow** → AG-UI page only. Why: `fastapi` is an *optional* dep and the documented getting-started is the FastAPI-served endpoint (which installs it, so the import works); the crash only hits the advanced *in-process / middleware-only* install done *without* the `[fastapi]` extra (reporter's repro says "NOT the [fastapi] extra"). New users on the quickstart aren't blocked → not a front-door break → off the main list.
- **A genuinely broad AG-UI front-door break appears on BOTH pages** (cross-community on the main list AND headline on the AG-UI list) — tag the shared ones "(also Top issue #N on the CopilotKit report)".
- **A CopilotKit-only issue NEVER appears on the AG-UI page.** (e.g. `#5533` agent-naming, `#5535` auth-header stay on the main page only.)
- Don't double-list an AG-UI Top issue in that page's Demand/Pain — elevate it to Top issues, leave the detail there (same as the main page).

**Community = the issue's subject, not the repo it's filed in.** A CopilotKit bug filed in the `ag-ui` repo (it targets/breaks CopilotKit) is a **CopilotKit** issue — count it on the CopilotKit side, never AG-UI, even though it was submitted in the wrong community. (And the reverse.) Precedent: `ag-ui#1891` "Illegal invocation" was filed in ag-ui but is a CopilotKit `HttpAgent` bug fixed in CopilotKit 1.60.1 → counted as CK, removed from AG-UI. **But ownership of the broken *tool* still decides it:** `create-ag-ui-app` failing is AG-UI's even though it scaffolds CopilotKit — the broken artifact is AG-UI's. Judge by *what is actually broken*, not which names are mentioned. This attribution applies everywhere (Top issues, clustering, enterprise counts, resolutions), not just Top issues.

## Top-issue ranking child page (public algo)

Every report ends with a child page — `📊 Top-issue ranking` — created as a child of the main page and linked from the bottom of both pages. It makes the ranking **auditable**.

Contents:
- **The rubric** — the five-axis scoring table (surface tier · blast radius · severity · exposure · signal) copied from `front-door-triage`, plus the "community is never an axis" + "fix status is a tag, not a demotion" rules.
- **This week's scored table** — one row per ranked candidate: `# · candidate (linked) · [CK]/[AG-UI] · surface · blast · severity · exposure · signal · TOTAL`, sorted by total. Note the measurable input behind any non-obvious score.
- **Tie-breaks** — note any (Blast radius, then Surface tier) so the order is fully reproducible.

**Companion `🔬 Ranking comparison` child page.** Shows the algo earning its keep: the **naive order** (rank by loudness) vs the **scored order**, as a `candidate | naive rank | algo rank | Δ` table, then a short "what changed, and why". When the order is unchanged, say so — that's the algo validating the read.

## Trends section (counts in context)

`## 📈 Trends {toggle="true"}` is a **collapsible** toggle, compact, sitting directly under the companion link, above 🔝 Top issues — so every number this week reads against its recent history. The point is context, not analysis: "is this a heavy week or a quiet one, and are we keeping up?" **Its whole body is tab-indented to nest inside the toggle** (see Page rendering rules — un-indented tables fall outside the collapse).

Contents, in order (whole body tab-indented to nest in the toggle):

1. **ONE weekly filed-vs-resolved table — `Week · Filed · Resolved (closed)`, ~12 weeks** (rolling, oldest → newest, newest row at the bottom + bolded). Each Filed/Resolved cell is `<count> <bar>` — the **number and the bar together**, `▓` filed · `▒` resolved. (Don't ship a number-less bar column — a bar with no number tells the reader nothing; that's why the old standalone "filed sparkline" + "Trend" column were dropped. One table, both series, numbers on every bar.)
2. **Month-over-month, per community** — `Community · Filed prev (<Mon YYYY>) · Resolved prev · Filed this (<Mon YYYY>, MTD) · Resolved this (MTD)` with a bold **Combined (CK + AG-UI)** row. The per-community + monthly cut the weekly table lacks; it lives **here in Trends**, not 📊 Pulse (moved 2026-06-30 to kill the duplicate filed-vs-resolved view). **Label the current month MTD** + note the cutoff (the month isn't over, so a drop vs last month is partly calendar). GitHub-only (Discord resolutions stay in ✅ Resolved). **Same combined table on BOTH pages** — don't split it per page.
3. **A Reddit-mentions note** (not a bar chart) — brand-term post counts are usually too sparse for weekly bars; state the rolling count and point to 🟠 Reddit Pulse.

- **One-line read under each table** — e.g. *"30 filed this week vs ~24/wk trailing — hot week"* and *"resolved ≥ filed the last 3 weeks — backlog shrinking."* State up/down/flat vs the trailing average; don't over-interpret. No percentage column — keep the cells to count + bar (a % vs-average column was considered and cut as clutter).
- **Cap bulk-close outliers.** A one-time mass-close (e.g. a 280-issue triage sweep in a single week) wrecks the resolved-bar scale — **cap the bar and annotate it inline** (`(1-time sweep)`), so it doesn't read as normal throughput.
- **Data** from orchestrator step 8b: filed = `gh issue list --search "created:<wk>"` per week; resolved = `gh issue list --state closed --search "closed:<wk>"` per week; both repos. Monthly table = same with month windows.
- **Scope:** the **weekly filed-vs-resolved table** is per-page — main page = CK + AG-UI combined, AG-UI sub-page = AG-UI-only. The **month-over-month table is the SAME combined table (CK · AG-UI · Combined rows) on BOTH pages** (per the "Same combined table on BOTH pages" rule above) — it is *not* scoped or split per page.

## Docs section (standing, weekly)

Every report carries a `### 📚 Docs` section per community, between 💢 Pain and ✅ Resolved. The header is a plain `###`; **each docs item is its own `#### {toggle="true"}` card** in the universal format (What / Impact / Fix — see "Section item cards"). The **What** line is prefixed with the item type:

- **Drift** — code moved, docs didn't.
- **Gap** — a needed guide that doesn't exist.
- **Links-bot** — dead doc URLs, support-bot citing 404s or stale answers.

(So a card reads: **What:** `Drift` — the React API surface… · **Impact:** … · **Fix:** rewrite the X page.)

Rules:
- **Every docs card carries a source link** (the issue/PR/Discord thread that raised it) — per the mandatory-source-link rule. A docs observation with no sourceable link doesn't get published; it's flagged for the review agent to source.
- A docs item that **blocks** a new/upgrading user is ALSO a Top issue — list it in both; in the Docs **Fix** line note "(blocking — also a Top issue)". Non-blocking docs items live only here.
- Always render the section; if empty, "No docs items this week."

## Removed sections (2026-07-02)

**📊 Pulse (the this-window snapshot) and Community ops are removed** — no longer in the report. The filed/closed counts that Pulse carried live in 📈 Trends; open-fix-PR detail lives on the cards' **Fix plan** lines. Hiring/self-promo/greetings noise is simply skipped in the Discord pull (never published). Don't re-add either section. (🟠 Reddit Pulse — below — is a *different* section and stays.)

## Reddit Pulse section (per community, 90-day, scored)

Reddit Pulse is the outside-the-walls read: what people say about CopilotKit / AG-UI on Reddit, good and bad. **It is split by community — each report page carries its own section, scored independently:**

- **`## 🟠 Reddit Pulse — CopilotKit`** on the main page (CopilotKit-subject posts).
- **`## 🟠 Reddit Pulse — AG-UI`** on the AG-UI sub-page (AG-UI-subject posts).

**Which page a post lands on — by primary subject:**
- Mentions **only CopilotKit** → CopilotKit section.
- About **AG-UI** (the protocol) → AG-UI section.
- Mentions **both** (common — AG-UI is CopilotKit's protocol) → the section matching the post's **primary subject** (e.g. "AG-UI is now an industry standard" → AG-UI even though CopilotKit is named; "CopilotKit building blocks" that mention AG-UI as the protocol it speaks → CopilotKit).

**Window:** rolling **last 90 days**, deduped against every post covered in prior weeks (ledger `docs/community-signal/reddit-pulse-seen.json`) so a thread is reported once — the week it first surfaces.

**Each section is a collapsible toggle** (`## 🟠 Reddit Pulse — <community> · <band> NN/100 {toggle="true"}`) with the 0–100 Pulse Score + band in the heading (so it reads while collapsed). Inside, tab-indented:
- the window/dedup note + a one-line link to the algo child page ("How this is scored → 🟠 Reddit Pulse scoring algorithm");
- a **Vibe** sentence (overall sentiment);
- scored post groups — three render buckets: **👍 Good** / **😐 Neutral / awareness** / **👎 Pain**. The scoring step classifies into five sentiment tiers (see the algorithm's `s` values); for display, **🙂 mixed-positive folds into 👍 Good and 🫤 mixed-negative into 👎 Pain**. Each post is one bullet: `[title](permalink) — r/<sub> ⬆score 💬comments. one-line.`;
- a **🔁 Recurring** line for comment themes worth addressing (e.g. the A2UI-vs-AG-UI confusion);
- a closing `*Net: …· Pulse Score NN/100.*` tally.

Rules:
- **Every post is a source link** to its Reddit permalink. **Sentiment comes from reading the post + top comments** (`REDDIT_RETRIEVE_POST_COMMENTS`), not the title.
- **Cross-posts** of the same story merge into one bullet (note the copies + use max engagement).
- **Noise** (spam, false-positive keyword hits) is dropped from the section but still recorded in the ledger so it can't resurface.
- **Source-gated:** if there's no write-scoped `COMPOSIO_API_KEY` or no ACTIVE Reddit connected account, render "🟠 Reddit Pulse — source not configured this week." and move on — never block the report on it.
- **Data source:** **Composio REST** with a **write-scoped** Composio API key (`Tools` resource = Write) in `COMPOSIO_API_KEY` (repo-root `.env`) — see **step 6** for the auth rationale (why not the `composio` MCP, why a read-only key 403s). Call `POST /api/v3/tools/execute/<TOOL>` with the ACTIVE Reddit `connected_account_id` from `GET /api/v3/connected_accounts?toolkit_slugs=reddit`. Tools: `REDDIT_SEARCH_ACROSS_SUBREDDITS`, `REDDIT_RETRIEVE_REDDIT_POST`, `REDDIT_RETRIEVE_POST_COMMENTS`. Scope vars `REDDIT_BRAND_TERMS` + `REDDIT_WATCHLIST` in the repo-root `.env`.

### Reddit Pulse scoring algorithm

Each section's 0–100 score is **calculated, not asserted**, and published on a standing public child page (`🟠 Reddit Pulse — scoring algorithm`) linked from each section. Community is never an input — each community is scored on its own posts.

**Current formula — reach × reception** (introduced as v2 on 2026-06-19, corrected by v3 below; the values in this block are the current v3 values). v1 weighted by the post's own engagement only, so a win in a tiny sub outweighed a flop in a big one. This weights by the *room* and judges each post against that room's own norm:

- **Sentiment per post** `s` (from post + top comments): `+1` good · `+0.5` mixed-positive · `0` neutral · `−0.5` mixed-negative · `−1` pain.
- **Room baseline** `M` = median of `(upvotes + 2·comments)` over the subreddit's recent **`new`** posts (NOT `hot` — hot oversamples winners). Fetch ~30 per distinct sub. `M` is the room's activity proxy (quiet "<10 posts/day" sub → low `M`).
- **Reception** `ρ = (upvotes + 2·comments) / M`. `ρ ≥ 1` landed; `ρ < 0.3` flopped for that room.
- **Effective sentiment** `s'`: positive `s` → `s' = s · clamp(ρ, 0.3, 1.2)`; **positive big-room flop** (`M ≥ 10` and `ρ < 0.3` and `s > 0`) → `s' = 0`; `s = 0` → `0`; negative `s` → unchanged.
- **Reach weight** `W = log10(1 + M)` (quiet rooms barely move the score).
- **Score** `= clamp( 50 + 50 · Σ(s'ᵢ·Wᵢ) / Σ(Wᵢ) , 0 .. 100 )` (50 = neutral baseline).
- **Bands:** 🟢 75–100 · 🟡 50–74 · 🔴 0–49. Tunable knobs: `M ≥ 10` active-room threshold, `ρ < 0.3` flop line, `0.3–1.2` clamp.

**v3 (2026-06-29) — community-reception fix.** Three corrections after v2 mislabeled a modestly-positive AG-UI week as 🔴 (a positive post read as the biggest *negative*, and a self-published critique scored twice):

- **Subreddit eligibility — `r/u_*` user-profile feeds are NOT community rooms.** A self-post to your own profile has no community audience; it's self-promo, not reception. **Exclude profile-feed posts from scoring** (still record their ids in the ledger). Micro-subs are fine — they just carry tiny `W`.
- **Cross-post merge happens BEFORE scoring.** Identical story across subs counts **once** (max engagement), scored in the most-real sub it appeared in. A duplicate can never double a sentiment. (This was always the rendering rule; v3 makes it a scoring rule too.)
- **Positive big-room flop floors at neutral, never negative** (changed from v2's `s' = −0.25` to **`s' = 0`**). Under-performing a busy room removes a post's positive credit; it must not manufacture negativity. Otherwise a genuinely positive post in the highest-`W` room becomes the single biggest *negative* contributor — which is exactly the v2 bug. Negative `s` is still passed through unchanged.

When the algorithm changes, update the child page (don't recreate it) AND this section — per the meta-rule.

## Enterprise section (elevated, current-employer rule)

🏢 Enterprise is **cross-community and elevated to the top of the main page — directly under 🔝 Top issues (and the ⚠️ contradictions category when present), above the CopilotKit community body** (per Nathan: enterprise gets highlighted, not buried).

**Scope — commercial surfaces only.** This section is CopilotKit's **commercial product** (Premium / CopilotKit Enterprise / Intelligence Platform / Cloud / paid-tier / license-gated), **not** "CopilotKit running at an enterprise company." Use the `product-surface-scan` **classifier** to decide whether a report belongs here: it belongs only if it hits a commercial surface (threads/persistence paid boundary, Inspector, Cloud/API-keys, self-host license/Helm, SSO/RBAC/SOC 2, analytics/self-learning, premium UI / Angular SDK, Slack/Teams, or a pricing/licensing question). A free-OSS bug (React SDK, AG-UI protocol, a backend/framework connection, a third-party integration's own auth) is a normal community issue **even when the reporter is at a big company** → Pain/Demand, not here. The "Surfaces this week" list is the `product-surface-scan` output, refreshed each run.

Four subsections, in order:

**🚩 Enterprise questions & complaints** (highlighted first) — **any question or complaint this week that touches an enterprise surface or the enterprise offering**, gathered from GitHub + Discord + Slack. This is the catch-all so nothing enterprise hides in the general body.
- The **threads / persistence ("enterprise threads") tier** is enterprise by definition — a complaint about paying for threads, the persistence tier, or the self-host runtime belongs here, not just in Pain. (Precedent this cycle: the "threads off" / paid-persistence friction is an enterprise complaint.)
- Each item is a **card** in the universal format (What / Impact / Fix plan) **plus the Owner + Priority meta line** — owner blank for Nathan, priority derived from rank.
- Cross-reference, don't duplicate: if it's already a Top issue, list it here with a one-line pointer ("see Top issue #N") rather than repeating the full card.
- If there were none, say so explicitly: "No enterprise-specific questions or complaints this week."

**🎯 Prospective enterprise customers** (community-sourced) — see "Prospective enterprise customers" below.

**Companies building on us this week** — the signal is **a company currently using/building on us**, surfaced through someone who *currently* works there.
- **Verify the current employer** with `gh api users/<login>` AND read the bio — the `company` field is often stale. If the bio says "ex-", "previously", "prior experience: …", they do NOT count. (Precedent: a reporter showed `company: Apple` but bio said "Prior experience: Apple" — ex-Apple, dropped.)
- **Ex-employers and "notable individuals" don't count** — track them as community reporters, not enterprise.
- **Flag unconfirmed employers explicitly.** If the company can't be independently confirmed — only the self-declared GitHub `company` field, no bio / LinkedIn / other corroboration, or the identity itself can't be pinned — append a **⚠️ Company unconfirmed — <why>** note to that bullet (and mirror it in the 🎯 prospect block). Never present an unverified employer as fact; a reader/sales must see the confidence. (Precedent: `GeauxEric` listed `company: Nvidia` on GitHub with no verifiable name/LinkedIn → bullet marked "Company unconfirmed — self-declared, single-IC.")
- Per-company bullet: who, where they currently work (confirmed or flagged unconfirmed), what they filed, and the strength of signal.
- When correcting a prior week's overcount, say so in a short `<details>` so the trend stays honest.

**Enterprise-offering reactions** — explicitly report community reaction to the enterprise surfaces, especially **Slack / Teams integrations** and **threads / persistence**. **If there was no reaction, say so** — silence is itself a signal.

### Prospective enterprise customers (community-sourced)

A standing subsection naming **community members who look like enterprise prospects** — people the sales team would want to know are in the community, building on us. This is a *lead list from the wild*, separate from "Companies building on us" (which is about who's already a confirmed current-employer signal).

- **Who qualifies:** someone active in Discord/GitHub/Reddit whose company is a recognizable enterprise/well-funded scale-up evaluating or building with CopilotKit/AG-UI — e.g. **Jasper AI** this cycle. Judge by the company, the depth of engagement, and the use case, not just a logo. When unsure, include with a "(worth a look)" note rather than dropping.
- **Deep-enrich every prospect via the `enrich-prospect` subagent** (spawn it once with the prospect shortlist — see that skill). It finds the LinkedIn profile, **verifies the LinkedIn employer matches the GitHub company** (keeps searching if it doesn't; never links a guess), and pulls the company website + company size. This is a *deep* pass — run it only on the prospect shortlist, not on every reporter (that's `enrich-reporter`).
- **The subsection is a COLLAPSIBLE toggle heading, company-named-first** (from `enrich-prospect`). Section heading `### 🎯 Prospective enterprise customers {toggle="true"}`; every block tab-indented to nest inside so the whole list collapses to one line. Author with REAL newlines + REAL tabs (not `\n`/`\t` — they mangle into literal `n`/`t`).
  ```
  ### 🎯 Prospective enterprise customers {toggle="true"}
  	- **Company:** [<Company>](<company website url>)
  		**Name:** [<Full Name>](<LinkedIn url>)          ← or "<Full Name> — LinkedIn not confirmed"
  		**Issue:** [<GitHub issue title>](<issue url>) · opened YYYY-MM-DD   ← use **Source:** [<thread/post>](<url>) · opened YYYY-MM-DD for Discord/Reddit
  		**Company Details:** <ARR / latest funding round only / employee count — most-recent only, or "size unknown">
  		**Passed to (sales):** _<blank — Nathan fills>_
  ```
- **`Passed to (sales):` is a blank owner field** — never auto-name a person; Nathan tags whoever on sales he handed the lead to. Same manual-owner rule as the issue cards.
- **Identity accuracy over completeness:** a wrong LinkedIn link in a sales handoff is a real cost — when the LinkedIn↔company match can't be confirmed, write `LinkedIn not confirmed`, don't guess. Never fabricate a funding/ARR/employee number; use "size unknown (private, no public figures)".
- **Source link mandatory** (the `Issue:` / `Source:` link that surfaced them) — per the source-link rule. No source link → not published.
- If none this week: "No new community-sourced enterprise prospects this week."

## Patterns — the takeaways

`## 🔄 Patterns — the takeaways {toggle="true"}` is a **collapsible** heading toggle (body tab-indented to nest) and sits cross-community on the main page. The compressed read of what to *act on*.

- Each bullet = one pattern, stated as a takeaway a busy exec can act on. Not "issue #X and #Y and #Z."
- Think: "truck coming," not "there's a green flower." Surface the thing that changes a decision.
- Every named entity hyperlinked (issues, handles, surfaces).
- 3–5 patterns.

## Gaps & follow-ups

The action checklist. **Draw the items from the `report-sources` evidence pass** — every unresolved thing that pass surfaced (an owner not yet assigned, a fix awaiting confirmation, a discrepancy to run down, a doc to write) becomes a follow-up — but **write each one as plain, human, actionable text.** The reader never sees that it came from an evidence/defense pass; there's no "per the sources page," no lawyer voice, no citations — just a clear next step a person can pick up.

- One checkbox per item, imperative, human: `- [ ] Assign an owner for the self-host auth issue and pick one of the three proposed fixes.` — not `- [ ] #5712 (score 13) requires owner assignment per rubric.`
- Link the relevant issue/PR inline where it helps, but the sentence stands on its own in plain English.
- Cross-community on the main page; AG-UI-scoped on the sub-page.
- Keep it short — the few things that actually need doing, not every open issue.

## Reporter formatting

- Every Discord mention is a hyperlink — no plain handles.
- **Every named entity in 🔄 Patterns is hyperlinked** — no bare `#NNNN`, handles, or feature names in Patterns prose.
- Forum thread URL: `https://discord.com/channels/<guild_id>/<thread_id>` (parent forum channel ID NOT in URL).
- Text channel: link to channel + include date.
- GitHub reporters: **link the handle to its GitHub profile** — `[``login``](https://github.com/login)` — and **link the `🏢 Company` badge to the company site** when enterprise (`🏢 [Amazon](https://www.amazon.com)`). Both URLs come from `enrich-reporter` (profile_url + company_url). The issue number itself is linked on the Source line. No plain-text handles or company names on any card.
- Append `🏢 <Company>` badge inline next to enterprise users' handles. Indie / solo get no badge.
- **`Reported by:` is the issue AUTHOR, taken from the author field — never the most recent commenter.** Get it from `gh issue view <n> --json author`, every time, for every card. Do not infer it from whoever appears in the pull's summary, whoever is loudest in the thread, or whoever opened the fix PR.
  **This is load-bearing, not cosmetic — it feeds two mechanisms.** The final Top-issue tie-break is *community-confirmed over staff-filed*, and the enterprise reporter counts and 🎯 prospect roster are built from the same field. A wrong author silently changes a rank and can put a real person's name on work they never filed.
  When the filer and the person doing the work differ, name both and say which is which: `**Reported by:** [author] , with [implementer] now implementing it` — the implementer belongs in **Fix plan**, never alone in *Reported by*.
  **Mark staff-filed cards as staff-filed.** Our own team files issues too, and they are not community signal. Staff are invisible on their GitHub profile (no org membership, empty `company`) — **only the commit email reveals them**: `gh search commits --author <login>` and look for an `@copilotkit.ai` address. Do this for every reporter before publishing a community count.
  *(Precedent 2026-08-21: five cards named the in-window commenter instead of the filer, and one — `#6408` — hid that it was staff-filed, which put it above a community-filed item at an equal score. The rank had to be corrected post-publish. One card named a handle that appears nowhere on its issue.)*
- **Never publish a bare "community authors: N" figure without its definition.** Distinct authors, distinct authors excluding staff, and distinct unaffiliated authors excluding contracted partner maintainers are three different numbers, and the gap between them is large. State which one you mean in the sentence that carries it.
- Identity collisions: merge same person across handles silently in the count; note inline if useful.
- Same-author duplicate-filing: one reporter, one signal.

## Substantive vs process notes

The report is **company-readable** (product, marketing, leadership, sales/CS, engineering). Strip orchestrator process notes.

**Forbidden:** "1 empty thread skipped", "X excluded per triage rules", "identity-merged", "just outside window — flag next week", "(2 CLOSED WONT_FIX promo)".

**OK to keep:** "Workaround stuck; real fix is PR #5300", "Zero-effort bonus: healed ~10 quickstart docs", "Hidden second bug: snapshot leak; needs own issue", **Action:** lines.

Test before publishing: read each parenthetical aloud and ask "would a non-engineer marketing person care?" If no, cut it.

**Tone — honest but constructive; never reflect poorly on engineering.** This is an internal CopilotKit report; frame the state accurately without blame language. Prefer the constructive, true description over the negative-sounding one:
- an in-progress fix is **"in progress" / "in active testing with the reporter" / "iterating on review"** — NOT "stalled" / "neglected" / "lagging" / "no live review."
- a re-requested or dismissed review is part of **iteration**, not failure — describe it as testing/iterating, not as the fix being stuck.
- an unowned item is **"needs an owner assigned"** — not "drifting" / "nobody cares."
- keep every fact intact (PR numbers, states, dates, "shipped for Vue, in testing for React") — reframe the *interpretation*, don't drop the *facts*. Honesty first; blame never. (Precedent: `#5533`'s React fix `#5592` had its approval dismissed twice — that was Nathan iterating/testing the fix WITH the reporter, so it's "in active testing," not "stalled.")

## Conventions

- **Report data lives ONLY in Notion — never in the codebase.** The report and everything derived from it (surface snapshots, issue lists, scored rankings, prospect data, weekly numbers) get published to the Notion pages and nowhere else. **Do not persist report content or per-run snapshots as files in the repo** (no `commercial-surfaces.json`-style ledgers). When a step needs last week's numbers to diff against, read the **prior report in Notion** — that is the baseline. The single allowed data artifact in the repo is `docs/community-signal/reddit-pulse-seen.json`, and only because it is operational **dedup state** (a list of already-seen Reddit post IDs), not report content — its header comment says so. If a future step wants to "save" anything else, the answer is: put it in the Notion report.
- **Report list bullets = one sentence.** Deep technical detail lives in 🔄 Patterns or the linked issue.
- Don't post to Discord / Reddit — read only.
- Don't ping users by handle in Notion; summarize impact instead.
- Reconfirm window at start so Nathan can catch a wrong week before the page lands.
- Convert relative dates to absolute ISO so the page stays interpretable later.
- **Never cite a CopilotKit (or AG-UI) version from memory — the `release-scan` subagent (step 6b) is the authoritative source.** Any "current release vX.Y.Z" / "fixed in vX.Y.Z" / "shipped in vX.Y.Z" claim uses that scan's latest/attributed version, never a remembered one. (If running outside the orchestrator, verify live: `npm view @copilotkit/react-core version` + `gh release list --repo CopilotKit/CopilotKit`; AG-UI: `npm view @ag-ui/core version` / `@ag-ui/langgraph` + `gh release list --repo ag-ui-protocol/ag-ui`.) A wrong version number is a credibility hit on the most-read card.
- **Every product-surface claim is quote-verified against a live page — NO shortcuts, no exceptions.** This report is read by product + engineering; a false pricing / tier / Premium-vs-free / "coming soon" claim looks bad and erodes trust. Any statement about a **tier, price, free-vs-paid boundary, Premium/Enterprise gating, "coming soon" status, or a product-surface contradiction** must be backed by text fetched from the live page **this run**, with the exact quote in hand — never from memory, the `product-surface-scan` baseline, or last week's snapshot (those are diff scaffolding only). If it can't be fetched and quoted, it does **not** get published. A contradiction requires **both** conflicting quotes, each tied to its live page. The link-review pass (step 14) re-checks these against the live pages, same as it checks issue/thread links.

## Cross-referenced skills

- `front-door-triage` — P0 categories and classification rules
- `product-surface-scan` — subagent: scans product/pricing/Premium pages → commercial-surface list + free-vs-paid classifier (defines the 🏢 Enterprise scope) + cross-page contradiction check (⚠️ category)
- `deep-read-issue` — subagent flow for issue + fix PR deep read
- `release-scan` — subagent: in-cycle release fix-map + authoritative version (open-issue cross-check)
- `enrich-reporter` — subagent for GitHub author enterprise enrichment (shallow: company field → 🏢 badge, all reporters)
- `enrich-prospect` — subagent for DEEP enterprise-prospect enrichment (LinkedIn + company website + size; prospect shortlist only)
- `slack-tldr` — Slack JSON format + curl command
- `loom-walkthrough` — the ≤10-minute plain-spoken walkthrough briefing, generated after every report (last step)
- `report-sources` — subagent: the "Report Sources" child page defending every placement with evidence (front-door, rank, section, attribution, resolved, enterprise, maturity)
- `carry-forward-owners` — diffs this report against the prior one and prints the owners of recurring items so they don't silently reset to blank (print-only; Nathan re-tags)
- `enterprise` — standalone enterprise view (run separately or invoked here)
- `topic-search` — ad-hoc cross-repo topic lookup
