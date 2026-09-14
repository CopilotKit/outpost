# Deployment Guide

Outpost consists of seven services (web dashboard, Discord bot, GitHub app, Slack bot, Teams bot, Linear sync, worker) sharing a single PostgreSQL database with pgvector. Each deployment environment (staging, production) has its own separate database — see [Environments](#environments-staging--production).

## Prerequisites

- Node.js 20+
- PostgreSQL 16 with pgvector extension
- Docker (for containerized deployment)
- Railway account (recommended) or equivalent PaaS

## Quick Start with Railway

Railway auto-deploys from GitHub and natively supports Docker-based services.

1. Push the repo to GitHub
2. Create a new project on [Railway](https://railway.app)
3. Add a **PostgreSQL** service (Railway has native Postgres with pgvector support)
4. Enable pgvector: connect to the database and run `CREATE EXTENSION IF NOT EXISTS vector;`
5. Add seven services from the repo, each pointing to its Dockerfile and `railway.toml` (set each service's Config file path to `apps/<app>/railway.toml`, Root Directory empty — build context must be repo root):
    - **outpost-web** — `apps/web/Dockerfile` (web service, port 3000, health check `/api/health`)
    - **outpost-discord-bot** — `apps/discord-bot/Dockerfile` (background worker, no public URL needed — gateway connects outbound)
    - **outpost-github-app** — `apps/github-app/Dockerfile` (web service, port 3200, needs public URL for webhooks)
    - **outpost-slack-bot** — `apps/slack-bot/Dockerfile` (background worker, Socket Mode — no public URL needed)
    - **outpost-teams-bot** — `apps/teams-bot/Dockerfile` (web service, needs public URL for the Bot Framework messaging endpoint)
    - **outpost-linear-sync** — `apps/linear-sync/Dockerfile` (web service, needs public URL for Linear webhooks)
    - **outpost-worker** — `apps/worker/Dockerfile` (background job processor — Postgres queue + scheduler, no public URL needed)
6. Share `DATABASE_URL` across all services using Railway's variable references (`${{Postgres.DATABASE_URL}}`)
7. Fill in the remaining secret environment variables (`DISCORD_TOKEN`, `ANTHROPIC_API_KEY`, etc. — see Environment Variables below)
8. Configure custom domains for the web dashboard, GitHub App webhook endpoint, Teams bot messaging endpoint, and Linear sync webhook endpoint

### What gets deployed

| Service             | Type       | Port (default)            | Health Check    |
| ------------------- | ---------- | ------------------------- | --------------- |
| outpost-web         | Web        | 3000                      | GET /api/health |
| outpost-discord-bot | Worker     | 3001                      | GET /health     |
| outpost-github-app  | Web        | 3200                      | GET /health     |
| outpost-slack-bot   | Worker     | 3002                      | GET /health     |
| outpost-teams-bot   | Web        | 3978 (bot), 3003 (health) | GET /health     |
| outpost-linear-sync | Web        | 3004                      | GET /health     |
| outpost-worker      | Worker     | 3005 (image default)      | GET /health     |
| outpost-db          | PostgreSQL | --                        | --              |

Ports are the code's defaults (`process.env.PORT`/`HEALTH_PORT` fallback) — Railway may assign different values via its own `PORT` env var per service.

**Five** services read the same `HEALTH_PORT` variable, each with a different fallback:

| Service               | Fallback in code | Pinned by its Dockerfile |
| --------------------- | ---------------- | ------------------------ |
| `outpost-discord-bot` | 3001             | `ENV HEALTH_PORT=3001`   |
| `outpost-slack-bot`   | 3002             | `ENV HEALTH_PORT=3002`   |
| `outpost-teams-bot`   | 3003             | `ENV HEALTH_PORT=3003`   |
| `outpost-linear-sync` | 3004             | (not pinned)             |
| `outpost-worker`      | 3003             | `ENV HEALTH_PORT=3005`   |

What separates them in a deployed environment is each image pinning its own value — not the
variable itself. So a single `HEALTH_PORT` in a shared local `.env` collapses **all five**
onto that one port rather than separating anything: `.env.example`'s `HEALTH_PORT=3005` suits
running one service at a time, and running several together needs a per-process override.

One further asymmetry: the worker resolves `PORT ?? HEALTH_PORT ?? 3003`
(`apps/worker/src/index.ts`), so a platform-injected `PORT` **overrides** `HEALTH_PORT` — and
since its Dockerfile probes 3005 unconditionally, an injected `PORT` moves the listener while
the health check keeps checking 3005.

Several services use `PORT` and `HEALTH_PORT` for **different** listeners rather than as
alternatives — the Teams bot serves health on `HEALTH_PORT` (3003) and the Bot Framework
endpoint on `PORT` (3978), and Linear sync reads both as well. Only the worker treats them as
a fallback chain.

## Environment Variables

Copy `.env.example` and fill in all values. Key groups:

- **Database**: `DATABASE_URL`
- **Auth**: `NEXTAUTH_URL`, `NEXTAUTH_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`
- **AI**: `ANTHROPIC_API_KEY`, `PATHFINDER_URL`
- **Discord**: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `GUILD_ID`, `MONITORED_CHANNEL_IDS`
- **GitHub App**: `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_TEAM_LOGINS` (optional)
- **Slack**: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET`, `MONITORED_CHANNEL_IDS`, `TEAM_MEMBER_IDS` (optional)
- **Teams**: `TEAMS_APP_ID`, `TEAMS_APP_PASSWORD`, `TEAMS_TENANT_ID` (optional, blank for multi-tenant), `MONITORED_CHANNEL_IDS`
- **Linear sync**: `LINEAR_API_KEY`, `LINEAR_WEBHOOK_SECRET`, `LINEAR_TEAM_ID`
- **Monitoring**: `SENTRY_DSN` (optional), `LOG_LEVEL`

## GitHub App Setup

Outpost's GitHub integration (`apps/github-app`) responds to issues and discussions the same way the Discord bot responds in threads. Creating the App is a one-time setup per GitHub org/repo.

1. **Create the App.** GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**.
    - Webhook URL: `https://<your-github-app-deployment>/api/webhooks/github` — needs a public URL (the deployed `outpost-github-app` Railway service, or a tunnel like ngrok for local dev on port 3200).
    - Webhook secret: generate a random string and save it — this becomes `GITHUB_WEBHOOK_SECRET`.
    - Permissions: **Issues: Read & write**, **Discussions: Read & write**.
    - Subscribe to events: **Issues**, **Issue comment**, **Discussions**.

    GitHub has no webhook event for comment reactions, so 👍/👎 feedback is picked up by a 24-hour poll job instead (`GITHUB_REACTION_POLL`) — no extra event subscription is needed for that.

2. **Generate credentials.** On the App's settings page, generate a private key (downloads a `.pem` file) — its full contents become `GITHUB_PRIVATE_KEY`. Note the **App ID** shown on the same page — that's `GITHUB_APP_ID`.

3. **Install the App.** App settings → Install App → pick the target repo (scope to one repo rather than the whole org for testing). After installing, the URL bar shows an `installation_id` — that's `GITHUB_INSTALLATION_ID`.

4. **Set environment variables.** Both `apps/github-app` (the webhook receiver) and the worker/web services (via `packages/outpost/shared`'s platform adapter registry) read:

    ```
    GITHUB_APP_ID=<app id>
    GITHUB_PRIVATE_KEY=<full .pem contents>
    GITHUB_INSTALLATION_ID=<installation id>
    GITHUB_WEBHOOK_SECRET=<webhook secret>
    ```

    Optional: `GITHUB_TEAM_LOGINS` (comma-separated GitHub logins treated as internal team members, used by triage logic).

5. **Deploy.** `outpost-github-app` is already defined as a Railway service (see the Quick Start section above) — point its Config file path at `apps/github-app/railway.toml`, leave Root Directory empty, add the env vars, deploy. Health check hits `GET /health`.

6. **Verify.** Open an issue on the installed repo. The agent should reply with an AI-generated answer plus a "Was this helpful? 👍/👎" prompt. React to it, then either wait for the next 24h poll or trigger `GITHUB_REACTION_POLL` manually to confirm the reaction lands as `feedback` on the `Message` row.

    Note: discussion-comment reactions aren't polled today — `GitHubAdapter.postDiscussionComment` returns a GraphQL node ID, not the numeric REST comment ID the reactions endpoint needs. Issue feedback works end-to-end; discussion feedback is a known follow-up.

## Docker Builds

Each app has its own Dockerfile using the Turborepo pruning pattern for efficient builds:

```bash
# Build web app
docker build -f apps/web/Dockerfile -t outpost-web .

# Build Discord bot
docker build -f apps/discord-bot/Dockerfile -t outpost-discord-bot .

# Build GitHub app
docker build -f apps/github-app/Dockerfile -t outpost-github-app .

# Build Slack bot
docker build -f apps/slack-bot/Dockerfile -t outpost-slack-bot .

# Build Teams bot
docker build -f apps/teams-bot/Dockerfile -t outpost-teams-bot .

# Build Linear sync
docker build -f apps/linear-sync/Dockerfile -t outpost-linear-sync .

# Build worker
docker build -f apps/worker/Dockerfile -t outpost-worker .
```

All images:

- Use multi-stage builds (prune -> install -> run)
- Run as non-root user (`outpost`, uid 1001)
- Include Docker HEALTHCHECK instructions
- Base on `node:20-alpine` for minimal size

## CI/CD Pipeline

The GitHub Actions workflow (`.github/workflows/ci.yml`) runs on every PR and push to `main` and `staging` — so both the integration line and every production release are validated:

1. Install dependencies (`pnpm install --frozen-lockfile`)
2. Generate Prisma client
3. Verify the Prisma schema and that a migration directory exists
4. Build all packages
5. Type check
6. Run tests

**Lint does not run in CI**, despite the job being named "Lint, Typecheck & Test" and branch
protection requiring that check. ESLint 9 defaults to flat config while the repo still uses
`.eslintrc.cjs`, and the `ESLINT_USE_FLAT_CONFIG=false` opt-out does not survive turbo's
environment sanitization. Enabling it is tracked in
[#141](https://github.com/CopilotKit/outpost/issues/141); until that lands, treat a green
check as covering build, types and tests only.

`apps/web` is linted by `next lint` against its own `apps/web/.eslintrc.cjs`; every other
workspace uses the root `.eslintrc.cjs`.

## Environments (staging → production)

Railway hosts two environments in the `outpost` project, each with its **own** PostgreSQL instance (staging never touches production data):

`main` is the known-good release line: it is what production runs. Development work — features, fixes, chores — happens on branches, which merge into `staging` for integration testing. Nothing reaches `main` until it has soaked on staging.

|              | staging                              | production              |
| ------------ | ------------------------------------ | ----------------------- |
| Deploys from | `staging` branch (CI-gated)          | `main` (CI-gated)       |
| Web URL      | `outpost-web-staging.up.railway.app` | `outpost.copilotkit.ai` |
| Database     | own Postgres (isolated)              | own Postgres            |
| Role         | integration / soak                   | known good              |

Four services carry deploy triggers in both environments: `outpost-web`, `outpost-github-app`, `outpost-discord-bot`, `outpost-worker`. The remaining three (`outpost-slack-bot`, `outpost-teams-bot`, `outpost-linear-sync`) are optional integrations — deployed manually / left offline until their credentials are configured.

Railway's deploy triggers have "wait for CI" enabled, so a push only deploys after the CI check suite passes on that commit — for both branches.

### Shadow mode (staging safety)

Staging runs the agent with `SHADOW_MODE=true` on `outpost-worker`. The AI response
pipeline runs in full, but instead of posting to the source platform it persists the
response as a shadow `Message` row (`author: outpost-shadow`, `attachments.shadowMode: true`)
carrying the text it would have posted, plus confidence and latency. Inspect those rows
to verify agent behavior without replying to real users.

`SHADOW_MODE` is read by **more than one service**, and each one gates a different point
in the flow. Set it consistently across an environment rather than on a single service:

| Service               | What the flag changes                                                                                                                                                                                                                                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outpost-discord-bot` | At ingest. `thread-create.ts` and `message-create.ts` call `isShadowMode()` and divert to `handleShadowThreadCreate` / `handleShadowMessage`, recording the ticket and a shadow response silently instead of running the normal visible flow (`src/lib/shadow-mode.ts`).                                                                      |
| `outpost-worker`      | At post-back. The `AI_RESPONSE` handler checks the flag immediately before `adapter.postResponse` and persists the response as a shadow `Message` row instead of posting (`queue/src/handlers/ai-response.ts`). Also gates `ONBOARDING_DIGEST`, which posts a daily digest straight to Discord via `DISCORD_DIGEST_CHANNEL_ID` over raw REST. |

For Discord either gate alone is enough to stop a post, so they are belt-and-braces. The
worker's gate is the one that covers **every** platform (GitHub, Slack, Teams) plus the
digest job, because that is where the adapter call lives — so a staging environment must
have it set on `outpost-worker`, not only on a bot.

When adding any new outbound post path, gate it on `isShadowMode()` from
`@copilotkit/outpost/shared` — not on `process.env.SHADOW_MODE` directly. Reading the
variable is what produced three separate copies of `=== 'true'`, all three of which
treated `SHADOW_MODE=TRUE` as "not shadow mode" and posted for real. The helper is the
only version of this that stays fixed.

### Promotion workflow

```
feature branch → PR → staging → CI → auto-deploys to STAGING → verify
release:        merge staging → main → CI → auto-deploys to PRODUCTION
```

Open pull requests against `staging`. On merge, Railway auto-deploys the staging
environment via its GitHub integration, where the change soaks in shadow mode.

Releasing is a deliberate act: merge `staging` into `main` (a PR from `staging` to
`main` is the auditable way to do it), and Railway deploys production from `main`.
Because `main` only ever receives changes that have already run on staging, it stays
"known good" — and its history is the record of what has been in production. No deploy
hooks needed on either side.

To roll production back, revert the offending commit on `main`; the next deploy picks
it up.

## Monitoring

### Structured Logging

All services use `@copilotkit/outpost/shared`'s `createLogger()` for JSON-structured logs:

```
{"timestamp":"2026-04-15T...","level":"info","service":"web","message":"Request processed","requestId":"abc123"}
```

### Alerts

`AlertManager` from `@copilotkit/outpost/shared` detects SLA breaches and bot failures. The default handler logs alerts; swap in a Slack webhook or PagerDuty handler for production.

### Error Tracking

The web app includes a Sentry stub (`apps/web/src/lib/sentry.ts`). Set `SENTRY_DSN` to activate. Without it, errors log to stderr.

## Health Checks

All seven services expose health endpoints returning JSON:

```json
{ "status": "ok", "service": "web", "version": "0.1.0", "uptime": 3600 }
```

- Web: `GET /api/health` (port 3000)
- Discord bot: `GET /health` (port 3001)
- GitHub app: `GET /health` (port 3200)
- Slack bot: `GET /health` (port 3002)
- Teams bot: `GET /health` (port 3003)
- Linear sync: `GET /health` (port 3004)
- Worker: `GET /health` (port 3005 — set by `ENV HEALTH_PORT=3005` in its Dockerfile; a platform-injected `PORT` takes precedence over `HEALTH_PORT`)

## Database Setup

After provisioning PostgreSQL (Railway supports pgvector via `CREATE EXTENSION`):

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

The schema is managed by **versioned Prisma migrations** (`packages/outpost/db/prisma/migrations/`).
Both `apps/web/start.sh` and `apps/worker/start.sh` run `prisma migrate deploy` on every
container start, so a deployed environment migrates itself — there is no manual step for
staging or production.

Because two services migrate, a deploy that restarts web and worker together has **two
concurrent migrators** against one database. Prisma takes an advisory lock, so the second
waits rather than corrupting state, but it can fail its startup if the first migration
outlasts the lock timeout — a restart clears it. Worth knowing before adding a third
migrating service, and worth consolidating onto a single migrate step (or a release-phase
job) if migrations grow long.

To apply migrations by hand (e.g. against a fresh local database):

```bash
pnpm db:generate
pnpm --filter @copilotkit/outpost exec prisma migrate deploy --schema db/prisma/schema.prisma
```

> **Do not run `pnpm db:push` against staging or production.** `prisma db push` syncs the
> schema without recording a migration, which puts the database out of step with the
> migration history and makes the next `migrate deploy` fail or clobber changes. It is for
> throwaway local databases and prototyping only.

To create a new migration during development, use
`prisma migrate dev --name <description>` and commit the generated directory.

### Backups

Railway's managed Postgres handles storage-level durability, but there is **no documented
application-level backup/restore procedure yet** — no scheduled `pg_dump`, and no rehearsed
restore. Treat that as an open gap before relying on this database for anything you cannot
reconstruct.
