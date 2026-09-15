# Outpost

Support operations for developer tools, where the AI answers only when it can show its work.

Outpost takes every place your users ask for help — Discord, Slack, Teams, GitHub issues and discussions, email, the web — and turns each conversation into one ticket with one history. An AI pipeline drafts a reply grounded in your documentation and source, and a human picks it up when the AI cannot do better than a guess.

Built by [CopilotKit](https://copilotkit.ai) to run our own community support.

> **Status: pre-1.0, in cutover.** The platform is built and tested — 2,244 tests across ten packages — and channels are being brought into production one at a time. The [go-live issues](https://github.com/CopilotKit/outpost/issues?q=is%3Aissue+is%3Aopen+go-live) track exactly where each one is. Treat anything not on that list as working-in-the-repo rather than running-in-production.

## The idea

Most support bots fail the same way: asked something they cannot answer, they answer anyway. The reply is fluent, wrong in a way that takes an engineer ten minutes to unpick, and it arrives before a human has read the question.

Outpost is built the other way round. The pipeline retrieves from real sources, then checks the draft against what it retrieved:

- **Groundedness gate** — every API name in the draft must appear in a retrieved source. Invented identifiers suppress the reply rather than shipping it.
- **Reply rules** — a linter scores the draft against a written rule set before it publishes: no praise openers, no hedged names that mean the model is guessing, no version-mixing, no naming retired packages, a citation or a short honest handoff.
- **A short honest reply is always the fallback.** When a draft breaks a rule, it collapses into a two-sentence handoff that promises a human, rather than being cleaned up and posted.

Every answer carries a disclaimer and an escalation path. The measure is not how many tickets the AI closes; it is how few wrong answers reach a reporter.

## What works today

**Channels.** A ticket can originate from Discord, Slack, Teams, GitHub issues, GitHub discussions, email, the web dashboard, or Linear, and replies thread back to the surface they came from. Each channel is a separate deployable service sharing one database.

**The AI pipeline** (`packages/outpost/ai`) — retrieval over documentation and source, classification, confidence scoring, the groundedness gate, the reply-rule linter, and an offline eval harness that scores replies against the rule set so quality changes are measurable rather than felt.

**A Postgres job queue** (`packages/outpost/queue`) — no Redis. Per-type concurrency limits, per-type timeouts, retry with backoff, dead-lettering, a recurring scheduler, and `FOR UPDATE SKIP LOCKED` claiming so multiple workers can run.

**The dashboard** (`apps/web`) — tickets and conversations, accounts, a docs knowledge base, agents, broadcasts, team and invites, SLA configuration, and email templates.

**Shadow mode.** Every outbound path can be gated, so the whole system can run alongside an incumbent and be measured without posting at real people. It fails closed: anything set but unrecognised means "do not post".

**Sync.** Bidirectional Linear sync, HubSpot account sync, and a tracker-sync abstraction for adding more.

## Architecture

```
                      ┌──────────────────────────────┐
  Discord ─┐          │        apps/web              │
  Slack   ─┤          │  dashboard · tickets · docs  │
  Teams   ─┼─ ingest ─┤  accounts · agents · team    │
  GitHub  ─┤          └──────────────┬───────────────┘
  Email   ─┤                         │
  Web     ─┘                         │
       │                             │
       ▼                             ▼
  ┌─────────────────────────────────────────────────┐
  │  packages/outpost/queue   — Postgres job queue  │
  │  packages/outpost/ai      — retrieval → draft   │
  │                             → gate → lint       │
  │  packages/outpost/shared  — types, adapters     │
  │  packages/outpost/db      — Prisma schema       │
  └─────────────────────┬───────────────────────────┘
                        ▼
              PostgreSQL 16 + pgvector
```

| Path                                    | What it is                                               |
| --------------------------------------- | -------------------------------------------------------- |
| `apps/web`                              | Next.js dashboard and API                                |
| `apps/worker`                           | Job runner — the AI pipeline, SLA checks, syncs, digests |
| `apps/discord-bot`                      | Discord ingest, slash commands, thread management        |
| `apps/slack-bot`                        | Slack ingest via Socket Mode                             |
| `apps/teams-bot`                        | Microsoft Teams ingest                                   |
| `apps/github-app`                       | Issue and discussion webhooks, reaction polling          |
| `apps/linear-sync`                      | Bidirectional Linear sync service                        |
| `apps/docs`                             | Static documentation site                                |
| `packages/outpost/{ai,db,queue,shared}` | The libraries every service shares                       |

## Quick start

Requires Node 20+, pnpm 9+, and Docker for local Postgres.

```bash
git clone git@github.com:CopilotKit/outpost.git
cd outpost
pnpm install

docker compose up -d          # Postgres 16 + pgvector
cp .env.example .env          # then fill it in

pnpm db:generate
pnpm db:push
pnpm db:seed
pnpm dev
```

`.env.example` documents every variable and, importantly, **which service needs it** — several are required on both the worker and the service that creates tickets, and a variable set in only one place is the most common way to end up with a feature that is silently inert.

| Command          |                              |
| ---------------- | ---------------------------- |
| `pnpm dev`       | Run everything in watch mode |
| `pnpm build`     | Build all apps and packages  |
| `pnpm test`      | Run the full suite           |
| `pnpm typecheck` | Type-check every package     |
| `pnpm lint`      | Lint every package           |
| `pnpm format`    | Format with Prettier         |

Deployment, including the per-service environment matrix and the staging/production split, is in [`docs/deployment.md`](./docs/deployment.md).

## Roadmap

Tracked in the issue list under [`roadmap: now`](https://github.com/CopilotKit/outpost/labels/roadmap%3A%20now), [`roadmap: next`](https://github.com/CopilotKit/outpost/labels/roadmap%3A%20next) and [`roadmap: later`](https://github.com/CopilotKit/outpost/labels/roadmap%3A%20later). The shape of it:

**Now — get every channel into production.** Discord, Slack, GitHub, Teams, Linear and email each have a go-live sequence: pre-deploy setup, deploy and verify, then a shadow-mode window before cutover. Alongside that, worker correctness — delivery durability, honest health reporting, and idempotent ingest so a redelivered webhook cannot create a second ticket.

**Next — make the answers better, and prove it.** Retrieval quality is the ceiling on everything: better source coverage, honest confidence scores, and telling a retrieval outage apart from an empty result set. Then instrumentation, because none of the target metrics are measured yet, and a streaming path that is as guarded as the batch one.

**Later — the surfaces around the core.** An integrations settings screen, richer templates, per-account SLAs, and a customer-messaging backend.

Two standing principles behind the ordering: a wrong answer costs more than a slow one, and a feature that reports success without doing anything is worse than one that is visibly missing.

## Contributing

Issues and pull requests are welcome.

```bash
pnpm test && pnpm typecheck && pnpm lint
```

A few things that will make review quick:

- **Describe what you verified, not just what you changed.** The reviews in this repo tend to ask "how do you know" — measured numbers, a mutation you tried, a failure you reproduced. Bringing that up front saves a round trip.
- **Tests that fail when the code is wrong.** If a change is worth making, there is usually a mutation that should break something. It is worth checking that it does.
- **`next build` catches things `pnpm test` does not** — App Router route files may only export HTTP verbs, and Node built-ins cannot reach a client bundle. Both pass the unit tests and fail the build.
- First-time contributors: your CI runs need a maintainer to approve them, so a pull request with no checks is waiting on us rather than on you.

## License

[Elastic License 2.0](./LICENSE) — source-available. You can read, modify and self-host it; you cannot offer it to third parties as a hosted service. See the LICENSE file for the exact terms.
