---
name: product-surface-scan
description: Scans CopilotKit's public product / pricing / Premium pages at the start of every weekly report to produce the authoritative list of COMMERCIAL surfaces (Premium · CopilotKit Enterprise · Intelligence Platform · paid tiers) and detect any newly-added or changed commercial feature since last week. This list defines what the report's 🏢 Enterprise section is about — CopilotKit's commercial/paid product, NOT "CopilotKit running inside an enterprise company." Emits the surface list + a free-vs-paid classifier the report uses to decide "does this issue hit a commercial surface?", plus a diff of what changed. Runs as a subagent (many web fetches) so the orchestrator's context stays small. Invoked by weekly-report (spawned at report start) and the enterprise skill; also triggers on "scan product surfaces", "what's premium", "commercial surfaces", "did we add a premium feature".
---

# Product surface scan

**What "Enterprise" means in this report (read this first).** The report's 🏢 Enterprise section is about **CopilotKit's commercial product surfaces** — anything sold as **Premium**, **CopilotKit Enterprise**, the **Intelligence Platform** (aka Enterprise Intelligence), **CopilotKit Cloud**, or gated behind a paid tier / license key. It is **NOT** about "CopilotKit being used in an enterprise environment." A bug in a free, open-source path used by a Fortune 500 is a normal community issue — it belongs in Pain/Demand, not Enterprise. An issue only lands in 🏢 Enterprise when it **hits a commercial surface** (see the classifier below).

A feature can be **free-but-limited AND commercial** at the same time — **threads / persistence** is the canonical example: free up to a cap (200 threads / 3-day retention / 1 GB), then Premium above it, and the durable-persistence platform features (replay, resume-across-devices, hosted inspection) are the paid Intelligence layer. So "it's free" does not mean "not a commercial surface" — what matters is whether the issue touches the paid boundary or a paid-only capability.

This skill produces, every week, the **current** authoritative list of those surfaces (they change — features get added, tiers get re-drawn) so the report never runs off a stale hand-maintained list.

## HARD RULE — every claim is quote-verified against a live page this run (NO shortcuts)

This report is read by the **product + engineering teams**. A false surface / tier / pricing claim makes us look bad and erodes trust. So:

- **Never emit a tier, price, free-vs-paid boundary, Premium/Enterprise gating, or "coming soon" status from memory, from the baseline lists in THIS file, or from last week's snapshot.** Those are reference/diff scaffolding ONLY, and they go stale.
- **Every such claim in your return MUST be backed by text you fetched from the live page THIS run, and you must include the exact quoted source text** (the page URL + the words on it). If you can't fetch the page, or can't find the words on it, you do **not** make the claim — record `could not verify on <page>` and omit it. A missing claim is fine; a false one is not.
- **Report a contradiction ONLY when you hold both conflicting quotes**, each tied to its page. Never infer a conflict from a half-remembered tier. If one side can't be quoted from a live fetch this run, there is no contradiction to report.
- **The baseline lists below are stale by design** — they were true at a past snapshot. Treat them as "what to diff against," never as "what to publish." Your return replaces them.

Non-negotiable. When in doubt, fetch again or drop the claim. The orchestrator's link-review pass re-checks these against the live pages before publish.

### A WebFetch extraction is not a quote — grep the raw payload before claiming a gate

**Learned 2026-08-21, the hard way.** This scan reported that `docs.copilotkit.ai/premium/headless-ui` had gained an explicit premium gate, quoting a sentence about needing Cloud or a self-hosted license. It went into the report and into this file. The link-review pass then grepped the page's full 264KB Next.js payload — markdown extraction, raw-HTML text, and the script/RSC blocks — and found `license` **zero times**. Every hit for "Enterprise Intelligence Platform", "self-host" and "premium" was sidebar navigation, sidebar-tree JSON, or `<meta>`/OG tags. The "quote" was assembled from chrome, not from body copy. Both the report and this file had to be corrected.

So, for any claim that a feature **is gated, is Premium, is Enterprise-only, or changed tier**:

- **WebFetch markdown extraction alone is not sufficient evidence.** These are JS-heavy marketing and docs pages; the extractor flattens nav, sidebar JSON, and meta tags into the same text stream as the prose, and a gating sentence can be synthesized from fragments that are not next to each other on the rendered page.
- **Fetch the raw payload and grep it**, then confirm the words sit in **body copy** — not in a nav list, a sidebar tree, a `<meta>` tag, or an OG description. Say which, in your return.
- **A URL path is not a gate.** A page living under `/premium/` tells you how the docs are organized. It does not tell you the feature is paid. Report the path as a path.
- **Absence claims need the same treatment, and they hold up better** — the same pass confirmed "Coming Soon" was genuinely gone from `/copilotkit-intelligence` by grepping the full page twice. A negative you have grepped is stronger evidence than a positive you have only extracted.

When the two methods disagree, the raw grep wins and the claim is dropped.

## What it does

1. **Fetch the canonical pages** (below) with `WebFetch`. If a page 404s or is unreachable, record that (don't guess) — a page going live/dead is itself a signal (e.g. `copilotkit.ai/enterprise` is currently a 404; if it goes live, flag it).
2. **Extract the commercial surfaces + the pricing-tier caps + the free-vs-paid boundaries** from the fetched pages.
3. **Diff against last week's report in Notion** — read the prior Weekly Community Signal page's 🏢 Enterprise "Surfaces this week" table + the pricing note under it (that IS last week's baseline) to detect **what changed since last week** — new named product/surface, a new premium feature, a moved free-vs-paid boundary (a cap change), a tier rename/reprice, a page appearing/disappearing. **Nothing is stored on disk** — the report lives only in Notion (see the rule in `weekly-report`).
4. **Return** the surface list + tier table + the "changed since last week" delta + the classifier. (Nothing is written to the repo.)

## Canonical pages to scan (re-check every week)

| # | URL | What it tells us |
|---|---|---|
| 1 | `https://www.copilotkit.ai/pricing` | Tier names, prices, and the load-bearing free-vs-paid caps (threads, retention, storage, seats, deployment, support) |
| 2 | `https://www.copilotkit.ai/copilotkit-intelligence` | Enterprise Intelligence feature list + "coming soon" premium features |
| 3 | `https://www.copilotkit.ai/product` | Product surface list — which SDKs/features are OSS vs premium |
| 4 | `https://docs.copilotkit.ai/premium/overview` | Canonical premium/OSS split + the API-key (Cloud) vs license-key (self-host) model |
| 5 | `https://docs.copilotkit.ai/mastra/premium/self-hosting` + `.../mastra/premium/threads-explained` | Self-host Helm + threads/persistence architecture |
| 6 | `https://www.copilotkit.ai/` | Landing page — newly-named products |
| 7 | `https://www.copilotkit.ai/enterprise` | **Currently 404.** Watch: if it goes live it signals a repositioning. |

Also sweep the CopilotKit **docs** for any page under a `premium/` path or tagged Premium/Enterprise (the docs carry Premium pages beyond the two above) — `docs.copilotkit.ai/premium/*` and framework-scoped `docs.copilotkit.ai/<framework>/premium/*`. Prefer the CopilotKit Docs MCP (`mcp__claude_ai_CopilotKit_Docs__search-docs` / `explore-docs`) when it's reachable; fall back to `WebFetch` on the public URLs when the MCP has no session.

## The commercial surfaces (current known set — refresh from the scan, don't trust this list blind)

Snapshot as of 2026-07-10 (source-linked in the pages above). The scan **replaces** this each week; it's here as the starting baseline + so a reader knows the shape.

- **Enterprise Intelligence Platform** — the paid production/persistence layer beside the OSS runtime (durable threads, persistence, hosted inspection, analytics, continuous learning). The umbrella paid product.
- **CopilotKit Cloud** — fully-managed hosting of the Intelligence Platform; connects via a **project API key**; "99.9% uptime SLA available".
- **Self-Hosted Enterprise Intelligence** — same platform in your own K8s/VPC/air-gapped boundary via the `copilot-intelligence` Helm chart; unlocked by a **license key** (offline validation).
- **Threads & Persistence** — persistent server-side thread containers (full event history, resumable). Free-but-limited (200 threads / 3-day / 1 GB), paid above.
- **CopilotKit Inspector** — real-time + historical interaction monitoring, replay, decision tracing, perf/error tracking.
- **Premium UI components** — platform-gated UI (e.g. **Fully Headless Chat UI**). **The Angular SDK is open source (MIT), same as React** — verified on /product + npm 2026-07-21; optional premium UI extras exist but the SDK itself is not paid. (A products PDF still mislabels the Angular client "Premium" — that PDF is stale.) **2026-07-31 re-check: no live page carries a literal premium label for the Angular SDK, Fully Headless UI, *or* Inspector — `/pricing` lists Inspector on the free Developer tier. Treat all three as unlabelled until a scan can quote otherwise.**
- **Analytics & Self-Learning** — perf dashboard, SQL-queryable lakehouse for compliance/audit, OTLP observability, in-context RL / per-user prompt mutation. **Status: "Coming Soon"** on both /product and the Intelligence page (verified 2026-07-21) — there is no "Early Access" label; don't invent one.
- **Enterprise security bundle** — SOC 2 Type II, SSO + RBAC, offline licensing.
- **Support / SLA** — Dedicated Slack Support (Team+), SLA + priority bug fixes + dedicated engineering hrs + roadmap input (Enterprise).
- **Slack & Teams integrations** — deploy agentic UI into Slack/Teams/messaging surfaces (paid product ecosystem).

**Free / OSS (NOT a commercial surface):** the core framework + React SDK + AG-UI protocol + backend connections (any LLM/framework/protocol) — MIT, free to self-host. Issues here are normal community issues, not Enterprise.

## Pricing tiers (baseline 2026-07-10 — refresh from the scan)

| Tier | Price | Key unlocks / caps |
|---|---|---|
| **Developer** | Free forever | 1 seat · VPC/on-prem runtime only · 3-day retention · 200 threads · 1 GB multimodal · Inspector · Discord support |
| **Pro** | $39/dev/mo (≤5 seats) | 5-day retention · 5,000 threads · 10 GB · frontend SDKs + backend connections |
| **Team** | **$100/dev/mo** (5 seats incl.) — verified /pricing 2026-07-21 | self-hosting **with database** · 14-day retention · 25,000 threads · 100 GB · dedicated Slack support · all frameworks/integrations |
| **Enterprise** | Custom | VPC/on-prem · unlimited threads · custom retention/storage · Analytics + Self-Learning (**Coming Soon**) · dedicated eng (≤5 hrs/wk) · SLA · priority bug fixes · roadmap input |

*(Inspector is shown across **all** tiers incl. free Developer — it is not Premium/Team-gated. Re-verify every value live each run per the HARD RULE above; do not trust this table blind.)*

## The classifier — "does this issue hit a commercial surface?"

Apply to every issue/thread when deciding whether it belongs in 🏢 Enterprise.

**YES — belongs in 🏢 Enterprise** if it touches any of:
- **threads / persistence** — esp. the retention window, the max-thread cap, resume/replay, or paying for persistence;
- **CopilotKit Inspector**;
- **CopilotKit Cloud** hosting / project API keys;
- **self-host license keys / the `copilot-intelligence` Helm chart**;
- **SSO / RBAC / SOC 2 / the security bundle**;
- **Analytics / Self-Learning**;
- **the Fully Headless Chat UI or the Angular SDK** (premium components);
- **Slack / Teams deployment**;
- **pricing / licensing / "is X Premium?"** questions.

**NO — normal community issue (Pain / Demand)** if it's pure OSS usage that stays under the free caps: the React SDK, the AG-UI protocol, a backend/framework connection, a third-party integration's own auth (e.g. an agno/watsonx endpoint requiring a token is *that framework's* auth, not a CopilotKit commercial surface), a bundle-size or build bug in the free packages, etc. — even when the reporter works at a large company.

**Worked calls (this cycle):**
- agno AgentOS auth header (`ag-ui#2130`) → **NO.** Third-party framework's endpoint auth; a feature request against the OSS dojo integration → Demand, not Enterprise.
- Angular SDK bug (`@copilotkit/angular`) → **NO, as of the 2026-07-31 scan.** No live page labels the Angular SDK premium — `/product` carries no license label and the landing page only says Angular support is "Now available". An Angular-only bug is Pain/Demand. **Only a "which tier is this?" / pricing question about Angular is YES**, and then it's the *question* that hits the commercial surface, not the SDK. Same rule for Fully Headless UI and for Inspector: `/pricing` lists Inspector on the **free** Developer tier, so "Inspector is Premium" is unsupported. **Route on the question, never on assumed gating — if the live scan can't quote a label, there is no gate.**
- Multi-tenant Slack bot (`@copilotkit/bot-slack`) → **YES.** Slack/Teams deployment is a paid ecosystem surface.
- Thread-reloading with LangGraph (`#2200`, resolved via Enterprise Intelligence) → **YES.** Threads/persistence + the Intelligence Platform.

## Detecting "a feature was added"

The diff is the point — leadership wants to know when the commercial product grew. Compare the fresh scan to **last week's report in Notion** (its 🏢 Enterprise "Surfaces this week" table + pricing note) and report any of:
- **New named surface / product** (a page or a product name that wasn't there last week).
- **New premium feature** under an existing surface (e.g. a "coming soon" that shipped, or a new Inspector capability).
- **Moved free-vs-paid boundary** — a cap changed (threads/retention/storage/seats), a feature moved between tiers, a price changed.
- **A previously-free feature now gated** (or vice-versa) — the highest-signal change; call it out loudly.
- **Page appeared / disappeared** (esp. `copilotkit.ai/enterprise`).

If nothing changed, say "No commercial-surface changes since last week" — that's a valid, useful result.

## Cross-page contradiction check (product-facing — high value)

A second job, for product: **do the scanned pages contradict each other?** Marketing pages, the pricing page, and the docs drift out of sync — the pricing page says one thread cap, a docs page says another; the product page calls a component free while the pricing page gates it; a "coming soon" is live in docs but still "coming soon" on the landing page. These are real, fixable messaging bugs, and product can only fix them if we hand them the exact conflicting page links.

- **Compare every scanned page against every other** for conflicting claims about: tier caps (threads / retention / storage / seats), prices, which features are free vs premium, which SDKs are OSS vs Enterprise, feature availability ("coming soon" vs "available"), product/surface names.
- **Every scanned page must be referenced** — cite the URL for each side of a contradiction so the fix target is unambiguous. Link all canonical pages in the output even when they agree (so product has the full reference set).
- **A page-vs-page conflict is the target**, but also flag a **page-vs-reality** conflict when a maintainer/GitHub/Discord statement plainly contradicts a page (e.g. a maintainer says a component is "going fully open source" while the product/pricing page still marks it Enterprise) — tag it `page-vs-source` and link both.
- **Be under oath — don't invent contradictions.** Quote the exact conflicting text from each page. If two pages merely describe different things, that's not a contradiction. When unsure, describe both statements and mark it `possible`.
- **Map every claim to the actual product model before flagging — two pages describing *different scopes of the same word* is NOT a contradiction.** Read the claim in the context of how the product actually works (fetch `/product` + `/copilotkit-intelligence` + `/pricing` and reconcile them), not as two isolated strings.
- **Known product model — do NOT re-flag (verified live 2026-07-24):** CopilotKit's **Enterprise Intelligence Platform is self-hostable.** Full-platform self-host is on the **Team self-hosted plan / custom Enterprise** (your own Kubernetes, bring-your-own-database, air-gapped supported); the **/pricing** per-tier line "VPC or On-Prem Deployment — Runtime only" on Developer/Pro means only the *runtime* deploys to your infra on those tiers. Those are **different scopes** (full-platform self-host tier vs runtime-deployment location) — the pricing page and the self-hosting doc do **not** contradict each other. Don't file this as a contradiction.
- Each finding: `<what conflicts> · Page A: "<quote>" (<url>) · Page B: "<quote>" (<url>) · suggested source of truth`.

## Report placement — the ⚠️ Product surface contradictions category

The contradiction check gets its **own category in the report**, and **when there is a contradiction it goes toward the TOP** (product needs to see it) — render `## ⚠️ Product surface contradictions` on the main page **directly under 🔝 Top issues, above 🏢 Enterprise**. Each contradiction is a short card: what conflicts, the two quoted claims, both page links, and the suggested source of truth. Owner blank for Nathan; priority derived like any card.

- **When there ARE contradictions:** the section sits high (under Top issues), one card per contradiction, page links mandatory.
- **When there are NONE:** don't take top space — render a single quiet line inside the 🏢 Enterprise section: *"Product pages checked for contradictions — none this week."* plus the referenced page list, so the reference set is always present.
- This is cross-community (it's about the CopilotKit product), main page only.

## No snapshot on disk — Notion is the baseline

**This scan writes nothing to the repo.** The report and every artifact derived from it live only in Notion (see the "report data lives only in Notion" rule in `weekly-report`). To get the week-over-week diff, read the **prior** Weekly Community Signal page in Notion — its 🏢 Enterprise "Surfaces this week" table + the pricing note under it are last week's baseline — and compare the fresh live scan against that. (Historical note: this used to persist `docs/community-signal/commercial-surfaces.json`; that snapshot was removed — report-derived data does not get committed to the codebase.)

## Output (return to the orchestrator)

Compact, so the orchestrator's context stays small:

1. **Surfaces this week** — the current commercial-surface list (drives the Enterprise "Surfaces this week" table; the enterprise skill renders it).
2. **Changed since last week** — the diff (or "No commercial-surface changes since last week").
3. **⚠️ Contradictions** — the cross-page contradiction findings, each with both quoted claims + both page links + suggested source of truth (or "none this week"). Feeds the `## ⚠️ Product surface contradictions` category — top of report when non-empty.
4. **Referenced pages** — the full list of scanned page URLs (always returned, so the report carries the reference set even when everything agrees).
5. **Tier caps** — the current free-vs-paid numbers (so the report can judge whether a threads/retention/storage complaint crosses the paid boundary).
6. **Page-reachability notes** — anything that 404'd or was unreachable.

## Cross-references

- `weekly-report` — spawns this at report start; its output defines the 🏢 Enterprise scope + the "Surfaces this week" table for the run.
- `enterprise` — consumes the surface list + the classifier; renders the Surfaces table and applies "does this hit a commercial surface?" when placing issues.
- `front-door-triage` — a commercial-surface break can also be a front-door P0 (e.g. Cloud sign-in broken); tag both.
