---
name: community-conversations
description: Subagent that pulls the in-window COMMUNITY (non-sales) meetings — website bookings routed to the community team instead of sales — from the team's Slack scheduling channel + Fireflies, reads each transcript, and returns per-call building / pain / not-a-pain / quality evidence for the four builder-insight sections under Top issues. Invoked by weekly-report; also triggers on "community calls this week", "what did the non-sales calls say", "turned-away-from-sales conversations".
---

# Community conversations pull

Some website bookings are routed to the community team instead of sales. Leadership wants to know what those calls reveal: what people are building, what hurts, and what doesn't. Nobody else reads them. This subagent finds those calls for the window, reads them, and returns compact evidence.

It runs as a `general-purpose` subagent so transcripts never enter the orchestrator's context.

Read-only. Never post to Slack, never email a guest, never edit a Fireflies meeting.

## Configuration (local only)

Read these from the repo-root `.env`, which is gitignored. They name internal channels and accounts, so they never go in the skill text, a report, or a commit.

| Variable | What it is |
|---|---|
| `COMMUNITY_CALLS_SLACK_CHANNEL` | Slack channel ID of the daily scheduling post that splits the day's meetings into sales and community buckets |
| `COMMUNITY_CALLS_BUCKET_LABEL` | The label of the community bucket in that post |
| `COMMUNITY_CALLS_BOOKING_EMAIL` | The booking account that appears on every website-booked invite |
| `COMMUNITY_CALLS_HOSTS` | Comma-separated emails of the community-team hosts |
| `COMMUNITY_CALLS_SALES_TRACKS` | Comma-separated labels the post uses for sales-owned tracks |

If any variable is missing, return `BLOCKER: community-calls config missing (<names>)` and stop. Don't guess the values.

## 1. Build the meeting list from Slack, then Fireflies

**The list comes from the scheduling channel.** Each morning it carries a post that splits the day's calls into buckets. Pull every daily post in the window:

```
slack_search_public_and_private  filters: "in:<#$COMMUNITY_CALLS_SLACK_CHANNEL> after:<start-1d> before:<end+1d>"
```

**Use the latest routing for each day.** An updated post, or a routing reply in the post's thread, beats the morning post. If the latest routing moves a booking into one of `COMMUNITY_CALLS_SALES_TRACKS`, it's sales and out of scope. A booking that sits in no bucket counts as community unless routing sends it to sales.

From the community bucket, take:
- the company or guest label
- the scheduled time
- the meeting link
- the booking's one-line use case

**Then match each booking to its Fireflies recording** with `fireflies_get_transcripts`, `fromDate`/`toDate` = window. Match on the meeting link or the `CopilotKit and <Company>` title.

**Also include recordings that no Slack bucket lists**, on any day, when all three hold:
- an external-domain or personal-email attendee
- `COMMUNITY_CALLS_BOOKING_EMAIL` or a `COMMUNITY_CALLS_HOSTS` address on the invite
- not in any sales bucket that week

## 2. Classify each meeting

| Status | Test | What the report does with it |
|---|---|---|
| `HELD` | The transcript has speech from the guest | Read it (step 3) |
| `NO_SPEECH` | Summary skipped or silent, or no guest sentences | Count only. Likely a no-show, may be a recording miss. |
| `CANCELLED` | Slack says it was cancelled, or the guest never replied | Count only |
| `NOT_FOUND` | On the Slack list, but no recording | Count only |

**One booking, one row.** A booking moved to another day counts once, on the day it was held. When Slack and Fireflies disagree (Slack says cancelled, but a recording exists), the recording wins.

**Count only means count only.** No-shows and cancellations are never named, and their booking text is never quoted, in the return or on the page. The report goes to the whole company, and someone's abandoned booking is not a story about them.

## 3. Read every HELD call: the transcript, not the summary

Fireflies' auto-summary mixes our pitch in with the guest's needs, and often lists *our* features as if the guest asked for them. Read the guest's own sentences with `fireflies_get_transcript`.

Pull these **from the guest's words only**:

- **Building:** what they're building, who it's for, scale (users, sites, customers), stage (idea · prototype · pilot · production · paying customers), and stack (agent framework, front end, channels).
- **Pain:** what they struggle with, in their own words. Tag each one:
  - `OFFER`: we sell it today
  - `PARTIAL`: we cover part of it
  - `NONE`: we don't offer it

  **Keep `NONE` items.** Leadership asked for pain in CopilotKit's zipcode *even when we don't offer it*. Our zipcode is everything between an agent and its user: UI and generative UI, channels (web, Slack, Teams, Telegram, voice), state, threads and persistence, multi-agent orchestration as the user sees it, governance and permissions, deployment and self-host, evals and learning, and cost. Pure model quality and unrelated business problems are out.
- **Not a pain:** only these forms count.
  - `STATED`: the guest says they don't need it ("we keep our own history").
  - `DECLINED`: we raised it and the guest set it aside or moved on. Record what we offered and how they responded.
  - Measured silence is computed across all sources by `builder-insights`, not here.
- **Quality signals:**
  - the guest's role on this project (founder, CTO, engineer, non-technical builder)
  - whether they have a live product or customers
  - whether they've already built on us
  - any concrete next step they committed to

**Every point carries a Fireflies deep link**, `https://app.fireflies.ai/view/<id>?t=<seconds>`, at the sentence that supports it. No timestamp means no claim.

**Our own people are not evidence.** What `@copilotkit.ai` attendees say is our pitch, not the guest's need. A product fact our host states on a call (a price, a limit, a retention window) is never repeated as fact: the report checks product claims against the live pages only. If a host's claim conflicts with a live page, return it as a `CONFLICT:` line for the orchestrator.

**Identity: company and project role only.** Name the company on the booking, its public site, and the guest's role *on this project*. Never return any of these:
- their other jobs or past employers
- side ventures or partner companies
- their clients' names
- anything personal they said on the call

All of that was said in a private conversation, not to a company-wide report. Also:
- **Strip other people's names out of quotes.**
- **Refer to the guest by company, not by pronoun.**

## Returns

```
WINDOW: <start> → <end>
COUNTS: booked N · held N · no-speech N · cancelled N · not-found N
BLOCKER: <only if config or a source is missing>
CONFLICT: <only if a host claim disagrees with a live page>

HELD
- <Company> (<site>) · <date> · stage: <…> · role: <…> · [call](fireflies url)
  BUILDING: <one sentence> · stack: <…> · scale: <…>
  PAIN: <their words, short> · OFFER|PARTIAL|NONE · [t](url?t=…)
  NOT-A-PAIN: STATED|DECLINED · <what> · [t](url?t=…)
  QUALITY: live product Y/N · built on us Y/N · next step: <…>
```

Return nothing else: no narrative, no recommendations. Keep it compact so the orchestrator stays small.

The return and everything derived from it live only in Notion, per weekly-report "Conventions". Never write call content to the repo.
