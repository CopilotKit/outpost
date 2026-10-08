---
name: loom-walkthrough
description: Generate the ≤10-minute Loom walkthrough script for a completed Weekly Community Signal report — a plain spoken briefing that dives straight into what the team needs to know, walking the report top to bottom (CopilotKit page first, then AG-UI in the same order). Straightforward and factual, NOT a radio show or a performance; no hype opener, no blame framing. Runs after every report (invoked by weekly-report) and on "loom script", "walkthrough script", "record the loom", "narrate the report".
---

# Loom walkthrough script

Turn a finished Weekly Community Signal report into a spoken briefing the host can record with confidence. **This is a plain internal update — the host is notifying the team of the week's highlights and what needs flagging, not putting on a show.** The host doesn't know the engineering deeply, so every line must be in plain "what it means for us" English, never internals.

This runs **after every report** — the `weekly-report` orchestrator invokes it once both pages are published, and it's independently triggerable ("loom script", "record the loom").

## Mandatory: the script MUST cover the AG-UI page

The report is **two pages** — the main page (CopilotKit) and the AG-UI sub-page. **The script must walk BOTH.** A script that only covers the CopilotKit page is incomplete and must not be delivered. Segments 7–9 are the AG-UI page (top issues, pain, momentum); open them with a `[SWITCH to the AG-UI sub-page]` cue and a spoken transition so the viewer knows the page changed. Even a thin AG-UI week gets covered (compress, don't skip). This is non-negotiable.

## Tone: a plain briefing, not a performance

This is an internal report-out. The host is telling the team the week's highlights and what they need to flag — nothing more. Keep it neutral and factual. **No cheeky openers, no radio-show energy, no jokes, no dramatic asides, no manufactured suspense.** If a line sounds like entertainment, cut it.

- **Straightforward and plain.** State the thing, its status, and whether it needs attention. The host is notifying, not narrating a story.
- **Still easy to read aloud** — contractions and short sentences are fine (it's spoken, not a memo), but the register is a calm colleague giving an update, not a presenter.
- **Dive straight in — no hype opener.** One short orienting sentence (week + "I'll walk CopilotKit top to bottom, then AG-UI"), then start at the top of the report. No "hook," no rotating gimmick, no callback bit, no "biggest thing first" reordering — the page order IS the order.
- **Never imply the engineering team isn't doing its job.** State status neutrally: an in-progress fix is "a fix is in review" / "in testing," an unowned item "needs an owner assigned," a shipped-broken item is just described by what broke + the fix — never "stalled," "neglected," "dropped the ball," or "how did this ship." Keep every fact; frame it as a status, not a failing.
- **No on-camera meta.** Don't narrate the document's structure — no "in this report," "next section," "as you can see." Just say what happened.
- **No catchphrase / no through-line slogan.** Don't invent a theme to repeat. If there's a genuine pattern worth naming, state it once, plainly, where it's relevant.
- **Numbers spoken, not written.** "about two months," "fifty out of a hundred" — never "~2mo" or "50/100" in the spoken lines.
- **Stage directions live in a hidden sidebar** (`[SCROLL to …]`, `[beat]`, time markers) — clearly separated so the host reads them silently and never speaks them. They are cues, not lines.

## Top issues are numbered — one beat each, never a paragraph

The Top issues are the core of the briefing. Deliver them as a **numbered list matching the report's ranking** — "number one … number two … number three …" — each its **own short beat** with a `[beat]` between. **Never blur two or more top issues together into one paragraph.** Each beat says, plainly: what the issue is (user-facing), and its status (fixed / fix in progress / not started). Give each its own time marker so the host paces one at a time. If a top issue is AG-UI-scoped, still number it here, and note you'll revisit it on the AG-UI page.

## Length

**10 minutes or less** (~1,300–1,500 spoken words max; shorter is fine on a quiet week). Mark rough time stamps so the host can pace. Always include a "to trim, cut these" note listing the 2–3 most trimmable lines (usually the Docs beats and the Reddit lines).

## Segment flow — walk the report top to bottom

**Dive straight in and follow the report's own order, top to bottom — the CopilotKit page first, then the AG-UI sub-page in the same order.** The page order IS the order — no curated narrative that reorders it (opener/hype rules live in `## Tone`). One short orienting sentence ("This is the community signal for the week of X — I'll walk CopilotKit top to bottom, then AG-UI"), then go. Cover each section in the order it appears on the page; skip a section only when it's empty (say nothing, move on).

**CopilotKit page (in page order):**
1. **Trends** — one or two sentences: heavy or quiet week, and are we keeping up. Note capped bulk-close sweeps so the resolved number isn't misread.
2. **Top issues — NUMBERED, one beat each** ("number one … number two …"), a `[beat]` between, each with a time marker. Per issue: what it means for a user + status (fixed / fix in review / needs an owner). **For a `↩ Week N` carry-over, say it's a carry-over and lead with the "Since last report" change** ("second week — the fix is approved but missed this week's release"); don't re-explain an issue the team heard last week. Open the walk with one sentence from 🆕 What changed since last report. Never how it broke internally; never blur two into one paragraph. (See "Top issues are numbered.")
3. **Product surface contradictions** (only if present) — the page-vs-page conflicts and whose job it is to reconcile the pages.
4. **Enterprise** — who showed up + the one or two to hand to sales + any enterprise-surface questions.
5. **Demand** — the notable feature asks, briefly (these are asks, not bugs).
6. **Pain — the high-level read.** NOT issue-by-issue. Name *where people are struggling* as a pattern + the one structural pain. The shape of the hurt, not a bug list. (See "Pain segment.")
7. **Docs** — the doc gaps, one line each (trimmable).
8. **Resolved** — what closed this week.
9. **Reddit Pulse** — score + one-phrase vibe (trimmable).

Then `[SWITCH to the AG-UI sub-page]` with a plain spoken transition ("now the AG-UI page, same walk"), and cover it in the **same page order**: Trends → Top issues (numbered) → Pain (pattern read) → Demand → Docs → Resolved → Reddit Pulse.

**Close** (~15s) — the week in a sentence, the one or two things the host needs the team to action, point to the linked report. Plain sign-off, no flourish.

## Pain segment (what the CEO wants)

Lead with this framing in mind: **fixes are one thing; the *pattern* of pain is where to invest.** Per community, answer "where are people actually struggling?" as a theme, not a ticket list:
- Cluster the friction into 1–2 named patterns ("almost all the friction is around one feature — X; people are adopting it faster than we've documented it").
- Call out the one **structural** pain (review bandwidth, single-contributor concentration, docs lagging capability).
- End each community's pain with a one-sentence high-level read the CEO can repeat ("the product's capability is ahead of its polish").
- Source the pain from the report's 💢 Pain + 🔄 Patterns sections — translate, don't transcribe.

## Plain-English translation rules

- **Always say what it means for a user, never the mechanism.** "the chat window crashes when you name your agent" — not "useAgent resolves to the default id." If pushed for depth, the host points to the report.
- Map jargon → plain: *quickstart/CLI* → "the get-started command"; *runtime/HttpAgent* → "running it in the browser"; *adapter* → "the connector for <framework>"; *generative UI / A2UI* → "agents drawing interactive buttons and forms"; *CI* → "an automated check."
- Keep one concrete anchor per issue so it's real ("Siemens," "fourteen thousand stars"), drop the rest.
- Fixed items still get airtime — "we said we'd fix it, it's fixed" is good news worth saying.
- **Don't say "confirmed" (or "verified", "acknowledged") unless a maintainer actually said so in the GitHub issue/PR comments — and you read it.** A support-bot "high-confidence" flag, a clear repro, or cited file paths are NOT a maintainer confirmation. Attribute precisely to what the source shows: "the support bot flagged it as high-confidence," "the reporter cited the exact files," "a maintainer confirmed it in the thread" (only if true). When unsure, describe what was filed, not who agreed. Overstating confirmation is the fastest way to lose credibility on camera.

## Output format

Two columns / two blocks so the host can hide the cues:

- **The spoken script** — what to say, top to bottom, with `[SCROLL to …]` / `[beat]` / `[~m:ss]` cues in brackets the host reads silently. **Bold the one anchor line per segment** so a host who blanks can just read the bold and move on. Top issues appear as a numbered list, one beat each.
- **A cue card** (≤12 lines) — scroll cues + bold anchors only, for off-screen glancing while recording. List the top issues numbered.
- **Pacing notes** — which segment to slow down on (the Pain read), and which lines to cut to stay under 10 minutes (per the Length section). No through-line/catchphrase note.

## Hand-off

This is the **last step of the routine** — the report is done; this makes recording painless. Do NOT post the Loom anywhere or add the link yourself — the host records, then the `weekly-report` orchestrator (step 15) adds the `**Loom:**` line to the page + the `🎥 Walkthrough` line to the Slack message once the host shares the URL.

## Cross-references

- `weekly-report` — invokes this skill after publishing; carries the Loom-link insertion rule (step 15)
- `slack-tldr` — the Slack message that gets the `🎥 Walkthrough` line once recorded
