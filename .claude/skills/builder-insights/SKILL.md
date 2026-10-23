---
name: builder-insights
description: Rules for writing the four sections under Top issues in the Weekly Community Signal — what people are building, their biggest pain points in CopilotKit's zipcode (including ones we don't offer), what is NOT a pain point, and a measured vibe check on community quality. Used by weekly-report at synthesis time; also triggers on "builder insights", "what are people building", "what are their pain points", "vibe check on the community".
---

# Builder insights (four sections under Top issues)

Leadership asked four questions the rest of the report doesn't answer:

1. What are people building, product-wise? (Including the community calls that sales turned away.)
2. What are their biggest pain points in CopilotKit's zipcode, even if we don't offer it today?
3. What is NOT a pain point for them? ("We don't need threads.")
4. How good are the people in our community?

The rest of the report is about tickets. This section is about **people and products**. It's written at synthesis time from returns the orchestrator already holds — no extra pulls besides `community-conversations`:

| Source | From |
|---|---|
| Community calls | `community-conversations` subagent |
| GitHub issues + PRs | Subagent B, `deep-read-issue`, `enrich-reporter` |
| Discord | Subagent A |
| Reddit | Subagent E |
| Commercial surfaces | `product-surface-scan` |
| Last 3 reports | Notion (prior report pages) |

## Placement and shape

**Four separate sections, each its own `##`, directly under `## 🔝 Top issues of the week`** on the main page (cross-community), in this order with `---` between them. ⚠️ Product surface contradictions and 🏢 Enterprise follow them. There's no umbrella heading. Each section is always open, not a toggle.

```
## 🔝 Top issues of the week
---
## 🛠️ What people are building
<i>One line: window + sources + "N community calls held of M booked".</i>   ← first section only
---
## 🎯 Biggest pain points (in our zipcode)
---
## 🚫 Not a pain point
---
## 🌡️ Vibe check
---
## ⚠️ Product surface contradictions   (when present)
## 🏢 Enterprise
```

The AG-UI sub-page doesn't get copies. Every section renders every week. When one is empty, say so in one line ("No one said what they're building this week.").

## 🛠️ What people are building

- **Group by product shape, not by source.** Use 2–4 groups named for what's built, e.g. "an agent in front of an existing SaaS", "one agent across many channels", "agent-built apps / generative UI products", "internal tools". Under each group, one bullet per company or person: `**<Company>** — <what they're building, for whom, at what scale> · <stage> · <stack> · [source](url)`.
- **Stage is one of:** idea · prototype · pilot · production · paying customers. Use the highest stage the source supports.
- **Sources:** call `BUILDING:` lines, plus any GitHub/Discord/Reddit item where the reporter *says what they're building*. A bug report that only names a component doesn't count.
- **Don't duplicate 🏢 Companies building on us.** A company already listed there gets a short pointer ("<Company> — <one line>, see 🏢").
- **Close with one `**The pattern:**` sentence** naming the most common shape and what it implies for us.

## 🎯 Biggest pain points (in our zipcode)

- **Zipcode = everything between an agent and the person using it.** That covers:
  - UI and generative UI
  - channels: web, Slack, Teams, Telegram, voice
  - state, threads and persistence
  - multi-agent orchestration as the user sees it
  - governance and permissions
  - deployment and self-host
  - evals and learning
  - cost

  Out of scope: model quality on its own, and the user's unrelated business problems.
- **Never drop a pain because we don't offer it.** That's half the point of the question. Tag each one:
  - `✅ we offer this`
  - `◐ partly`
  - `○ not offered today`
- **Rank by distinct people or companies** who raised it across all sources. Never rank by issue count: one person filing four issues is one voice, and our own staff count zero (staff test: `@copilotkit.ai` commit email, per weekly-report "Reporter formatting").
- **Bar to appear:** 2+ distinct people this week, or 1 plus a prior-report reference. Reporters of a carried-over issue count as the prior reference, not as people this week. Show the split in the count ("4 people: 1 call this week + 3 on carried-over Top issues").
- **3–6 pains.** Each one is a numbered bold title, then 1–3 plain sentences with the guest's own words quoted where they're sharp, the count ("3 people: 2 calls, 1 GitHub"), the tag, and a link on every supporting point.
- **Point, don't repeat.** A pain that is also a Top issue or a 💢 card points there ("see Top issue #2").

## 🚫 Not a pain point

Silence is weak evidence, so every entry must be one of three kinds, and must say which:

| Kind | Bar | Write it as |
|---|---|---|
| **Stated** | A person says they don't need it | Their words quoted, with the link |
| **Declined** | We raised it on a call and they set it aside | What we offered, how they responded, call link at the timestamp |
| **Measured silence** | A surface we **sell or pitch** (from `product-surface-scan`) got zero mentions across GitHub + Discord + Reddit + calls, in this window **and** the windows of the prior 3 reports | "No one raised X between <start> and <end> (N items read)". The date range is the real span, since prior reports vary in length. N = GitHub issues filed (from each report's 📈 Trends) + in-window Discord threads + Reddit posts + calls held. When a count isn't available, name the source instead of guessing it. |

- **"It didn't come up on this week's calls" is not an entry.** That's below all three bars. Leave it out.
- Silence only means something for things we actually sell or pitch.
- **Not-a-pain and pain can both be true.** "Nobody wants us to host their threads" sits fine next to "self-hosted thread restore is broken". When that happens, say so in one sentence. It's often the most useful line in the section.
- **2–5 entries.** When nothing clears the bar: "Nothing cleared the bar this week."

## 🌡️ Vibe check

**This is a measured read, not a mood.** Lead with a small table, then 1–2 plain sentences.

| Measure | How |
|---|---|
| Calls held / booked | `community-conversations` COUNTS |
| Held calls with a live product or customers | QUALITY lines |
| Held calls with a technical decision-maker | role = founder / CTO / engineering lead |
| Outside GitHub reporters | Distinct issue authors, excluding staff. Staff = an `@copilotkit.ai` commit email, **or** membership in the `CopilotKit` / `ag-ui-protocol` GitHub orgs (`gh api orgs/<org>/members/<login>` returns 204), **or** sitting on our side of a call. The commit-email test alone misses staff who commit from personal addresses. |
| …at a confirmed company | `enrich-reporter`, current employer only |
| Reporters who opened their own fix PR | Author of the issue = author of the linked PR |
| Outside PR authors, and top author's share | `gh pr list --search "created:<window>"`, staff excluded |

- **Add a "last week" column** taken from the prior report's table, so the vibe has a trend. The first week this runs, write "—".
- **No colour band or score.** None is defined, so don't invent one.
- The closing sentences say what the numbers mean ("the people who show up are building real products; the booking funnel is where most drop off"), plus one named example of high-quality participation, linked.

## Writing rules

These rules apply to all four subsections. They're specific to this section because it draws on private conversations.

- **The privacy rule:** name the company and the person's role on this project, nothing more. Leave out:
  - their other jobs or past employers
  - side ventures
  - anything personal said on a call

  This is a company-wide page built partly from private calls.
- **No-shows and cancellations are a number, never a list.** Never quote booking-form text. Nobody's abandoned booking is material for the report, least of all as a joke.
- **Fireflies links are fine here** (the report is internal) and every call-based claim carries one, deep-linked to the timestamp. **They never go into the Slack TL;DR.**
- **Our staff's words aren't evidence.** A pitch line or a product claim made by our host on a call doesn't support a pain or a not-pain. Product facts still need a live-page quote (weekly-report "Conventions"). A `CONFLICT:` from `community-conversations` goes into Gaps & follow-ups.
- **Every item carries a source link**, the same as the rest of the report.
- **Refer to people by company or role, never by a guessed pronoun.** Strip third parties' names out of quotes.
- **Plain, warm, respectful.** These are people who chose to talk to us, so describe them the way you'd want to be described.

## Common mistakes (seen in the first test run)

| Mistake | Fix |
|---|---|
| Published a guest's day job and past employers from a call | Company + role on this project only |
| Listed no-shows by name and quoted silly form answers | Counts only |
| Dropped multi-agent orchestration as "outside what we offer" | Keep it and tag it `○ not offered today`. Adjacent pain is the point. |
| "Price is not a pain" because nobody mentioned it on 5 calls | Doesn't clear any bar. Leave it out. |
| Gave a 🟢 vibe verdict | Show the table and say what it means. No band. |
| Counted fork PRs as outside contributors | Run the staff commit-email test first |
| Repeated a retention limit our host mentioned on a call as a fact | Staff words aren't evidence. Quote-verify against the live page. |
| Quoted a guest naming a colleague, and called the guest "he" | Strip third-party names, and refer to the company |
