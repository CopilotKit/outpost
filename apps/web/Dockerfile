# ── Stage 1: prune the monorepo to only what @copilotkit/outpost-web needs ──────────────
FROM node:24-alpine AS pruner
RUN apk add --no-cache libc6-compat
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
RUN npm install -g turbo@2

COPY . .
RUN turbo prune @copilotkit/outpost-web --docker

# ── Stage 2: install dependencies ────────────────────────────────────────────
FROM node:24-alpine AS installer
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Install only the pruned lockfile first (layer cache)
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

# Copy pruned source and build
COPY --from=pruner /app/out/full/ .
# turbo prune omits the root tsconfig.json that packages/outpost/tsconfig.base.json extends
COPY --from=pruner /app/tsconfig.json ./tsconfig.json

# NEXT_PUBLIC_* values are inlined into the client bundle at build time, not read at
# runtime — so they must exist during `next build` or Next bakes in `undefined`, and
# setting them on the running service afterwards has no effect. Railway supplies service
# variables to Dockerfile builds as build args, so each one needs an ARG here; the ARG
# alone is not enough because Next reads process.env, hence the matching ENV. Both must
# appear ABOVE the build step to have any effect.
#
# ADDING A NEW NEXT_PUBLIC_* VARIABLE REQUIRES ITS OWN ARG + ENV PAIR HERE. turbo.json's
# wildcard covers turbo's side, but Docker has no wildcard for build args — a variable
# without a pair below is silently baked in as `undefined`.
#
# No default value is given deliberately. An unset build arg makes ENV an empty string,
# and consumers treat empty as absent (`||`, not `??`) so the application's own default
# applies. Repeating the default here instead would put it in two places that can drift.
ARG NEXT_PUBLIC_AUTH_PROVIDER
ENV NEXT_PUBLIC_AUTH_PROVIDER=$NEXT_PUBLIC_AUTH_PROVIDER

RUN pnpm turbo run build --filter=@copilotkit/outpost-web

# ── Stage 3: production image ────────────────────────────────────────────────
FROM node:24-alpine AS runner
RUN apk add --no-cache libc6-compat openssl

RUN addgroup --system --gid 1001 outpost && \
    adduser --system --uid 1001 outpost

WORKDIR /app

COPY --from=installer --chown=outpost:outpost /app/apps/web/.next/standalone ./
COPY --from=installer --chown=outpost:outpost /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=installer --chown=outpost:outpost /app/apps/web/public ./apps/web/public
# Prisma query engine for linux-musl (required by Next.js standalone)
COPY --from=installer --chown=outpost:outpost /app/node_modules/.pnpm/@prisma+client*/node_modules/.prisma/client/*.node ./node_modules/.prisma/client/
COPY --from=installer --chown=outpost:outpost /app/node_modules/.pnpm/@prisma+client*/node_modules/.prisma/client/schema.prisma ./node_modules/.prisma/client/
# Also copy engine to .next/server where standalone bundle looks for it
COPY --from=installer --chown=outpost:outpost /app/node_modules/.pnpm/@prisma+client*/node_modules/.prisma/client/*.node ./apps/web/.next/server/
COPY --from=installer --chown=outpost:outpost /app/node_modules/.pnpm/@prisma+client*/node_modules/.prisma/client/schema.prisma ./apps/web/.next/server/
# Prisma schema and migrations for migrate deploy on startup
COPY --from=installer --chown=outpost:outpost /app/packages/outpost/db/prisma ./packages/outpost/db/prisma
# Prisma CLI for running migrations at startup (installed with all transitive deps)
# Pinned in lockstep with apps/worker/Dockerfile. web and worker run migrate deploy
# against the SAME database, and the worker's start.sh now fails its deploy on any
# schema difference -- so if web applies migrations with a different 6.x CLI than the
# worker verifies with, an unrelated web-side bump can hard-fail worker deploys with a
# drift message describing drift that does not exist. A CI step asserts both literals
# match the lockfile.
RUN npm install --prefix /opt/prisma --no-save prisma@6.19.3

USER outpost
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Use 127.0.0.1, not localhost: the standalone server binds IPv4 (0.0.0.0) and
# `localhost` can resolve to IPv6 ::1 inside the container, which is refused.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

COPY --from=installer --chown=outpost:outpost /app/apps/web/start.sh ./apps/web/start.sh

CMD ["sh", "apps/web/start.sh"]
