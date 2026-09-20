# ── Stage 1: prune the monorepo to only what @copilotkit/outpost-worker needs ──────
FROM node:24-alpine AS pruner
RUN apk add --no-cache libc6-compat
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
RUN npm install -g turbo@2

COPY . .
RUN turbo prune @copilotkit/outpost-worker --docker

# ── Stage 2: install dependencies and build ──────────────────────────────────
FROM node:24-alpine AS installer
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

COPY --from=pruner /app/out/full/ .
COPY --from=pruner /app/tsconfig.json ./tsconfig.json
RUN pnpm turbo run build --filter=@copilotkit/outpost-worker

# ── Stage 3: production image ────────────────────────────────────────────────
FROM node:24-alpine AS runner
RUN apk add --no-cache libc6-compat openssl

RUN addgroup --system --gid 1001 outpost && \
    adduser --system --uid 1001 outpost

WORKDIR /app

COPY --from=installer --chown=outpost:outpost /app/node_modules ./node_modules
COPY --from=installer --chown=outpost:outpost /app/apps/worker/dist ./apps/worker/dist
COPY --from=installer --chown=outpost:outpost /app/apps/worker/package.json ./apps/worker/package.json
# pnpm's isolated layout keeps the app's own deps here (symlinked into root .pnpm) — required at runtime.
COPY --from=installer --chown=outpost:outpost /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=installer --chown=outpost:outpost /app/packages ./packages
COPY --from=installer --chown=outpost:outpost /app/package.json ./package.json

COPY --chown=outpost:outpost apps/worker/start.sh ./apps/worker/start.sh
RUN chmod +x apps/worker/start.sh

# Prisma CLI for running migrations at startup (installed standalone, mirrors apps/web/Dockerfile —
# the pnpm workspace .bin paths don't resolve reliably in the pruned production image).
# Pinned to the lockfile's resolved version rather than the `prisma@6` range, because
# start.sh now gates the worker's boot on this CLI's `migrate diff` exit code: a CLI
# that has drifted from @prisma/client can report false drift and block every deploy
# with a message pointing at the database. `prisma@6` floats freely across 6.x, and
# apps/web applies migrations to this same database with its own CLI — so the two must
# move together. A CI step asserts this literal matches the lockfile.
RUN npm install --prefix /opt/prisma --no-save prisma@6.19.3

USER outpost
ENV NODE_ENV=production
ENV HEALTH_PORT=3005
EXPOSE 3005

# start-period covers the whole pre-listen window, which is now two full prisma CLI
# invocations (migrate deploy, then the drift check) before anything binds /health.
# At the old 10s an orchestrator honouring this status could restart the container
# mid-migration — manufacturing the failed-migration (P3009) state start.sh exists to
# diagnose. The URL follows the same PORT-over-HEALTH_PORT precedence as src/index.ts
# rather than hardcoding 3005, and uses 127.0.0.1 because `localhost` can resolve to
# ::1 in-container and be refused (see apps/web/Dockerfile).
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${PORT:-${HEALTH_PORT:-3003}}/health" || exit 1

CMD ["./apps/worker/start.sh"]
