# Deployment Guide

Outpost consists of three services (web dashboard, Discord bot, GitHub app) sharing a single PostgreSQL database with pgvector.

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
5. Add three services from the repo, each pointing to its Dockerfile:
   - **outpost-web** — `apps/web/Dockerfile` (web service, port 3000, health check `/api/health`)
   - **outpost-discord-bot** — `apps/discord-bot/Dockerfile` (background worker)
   - **outpost-github-app** — `apps/github-app/Dockerfile` (web service, port 3200, needs public URL for webhooks)
6. Share `DATABASE_URL` across all services using Railway's variable references (`${{Postgres.DATABASE_URL}}`)
7. Fill in the remaining secret environment variables (`DISCORD_TOKEN`, `ANTHROPIC_API_KEY`, etc.)
8. Configure custom domains for the web dashboard and GitHub App webhook endpoint

### What gets deployed

| Service              | Type       | Port | Health Check       |
|----------------------|------------|------|--------------------|
| outpost-web          | Web        | 3000 | GET /api/health    |
| outpost-discord-bot  | Worker     | 3001 | GET /health        |
| outpost-github-app   | Web        | 3200 | GET /health        |
| outpost-db           | PostgreSQL | --   | --                 |

## Environment Variables

Copy `.env.example` and fill in all values. Key groups:

- **Database**: `DATABASE_URL`
- **Auth**: `NEXTAUTH_URL`, `NEXTAUTH_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`
- **AI**: `ANTHROPIC_API_KEY`, `PATHFINDER_URL`
- **Discord**: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `GUILD_ID`
- **GitHub App**: `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID`, `GITHUB_WEBHOOK_SECRET`
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
```

All images:
- Use multi-stage builds (prune -> install -> run)
- Run as non-root user (`outpost`, uid 1001)
- Include Docker HEALTHCHECK instructions
- Base on `node:20-alpine` for minimal size

## CI/CD Pipeline

The GitHub Actions workflow (`.github/workflows/ci.yml`) runs on every PR and push to main:

1. Install dependencies (`pnpm install --frozen-lockfile`)
2. Generate Prisma client
3. Build all packages
4. Lint
5. Type check
6. Run tests

On merge to main — and only after the `Lint, Typecheck & Test` job passes — the `deploy` job in the same workflow runs `railway up` for each GitHub-connected service (`outpost-web`, `outpost-worker`, `outpost-github-app`, `outpost-discord-bot`), shipping the merged commit. This replaces Railway's native GitHub auto-deploy, which staged every deploy behind a manual "Needs approval" click.

**Setup for CLI deploys:**

1. Create a Railway **project token** for the production environment and add it as the `RAILWAY_TOKEN` repository secret (repo Settings → Secrets and variables → Actions). Project tokens are environment-scoped, so no `--environment` flag is needed.
2. In the Railway dashboard, disable each service's native **Auto Deploy** (Service → Settings → Deploy) so a merge doesn't also stage a GitHub-integration deployment alongside the CLI deploy.

`outpost-slack-bot`, `outpost-teams-bot`, and `outpost-linear-sync` are currently offline and excluded from the deploy matrix — add a matrix entry in `ci.yml` when they're brought online.

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

All three services expose health endpoints returning JSON:

```json
{"status": "ok", "service": "web", "version": "0.1.0", "uptime": 3600}
```

- Web: `GET /api/health` (port 3000)
- Discord bot: `GET /health` (port 3001)
- GitHub app: `GET /health` (port 3200)

## Database Setup

After provisioning PostgreSQL (Railway supports pgvector via `CREATE EXTENSION`):

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Then run migrations:

```bash
pnpm db:generate
pnpm db:push
```
