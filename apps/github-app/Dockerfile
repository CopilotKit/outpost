# ── Stage 1: prune the monorepo to only what @copilotkit/outpost-github-app needs ───────
FROM node:24-alpine AS pruner
RUN apk add --no-cache libc6-compat
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
RUN npm install -g turbo@2

COPY . .
RUN turbo prune @copilotkit/outpost-github-app --docker

# ── Stage 2: install dependencies and build ──────────────────────────────────
FROM node:24-alpine AS installer
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

COPY --from=pruner /app/out/full/ .
COPY --from=pruner /app/tsconfig.json ./tsconfig.json
RUN pnpm turbo run build --filter=@copilotkit/outpost-github-app

# ── Stage 3: production image ────────────────────────────────────────────────
FROM node:24-alpine AS runner
RUN apk add --no-cache libc6-compat openssl

RUN addgroup --system --gid 1001 outpost && \
    adduser --system --uid 1001 outpost

WORKDIR /app

COPY --from=installer --chown=outpost:outpost /app/node_modules ./node_modules
COPY --from=installer --chown=outpost:outpost /app/apps/github-app/dist ./apps/github-app/dist
COPY --from=installer --chown=outpost:outpost /app/apps/github-app/package.json ./apps/github-app/package.json
# pnpm's isolated layout keeps the app's own deps here (symlinked into root .pnpm) — required at runtime.
COPY --from=installer --chown=outpost:outpost /app/apps/github-app/node_modules ./apps/github-app/node_modules
COPY --from=installer --chown=outpost:outpost /app/packages ./packages
COPY --from=installer --chown=outpost:outpost /app/package.json ./package.json

USER outpost
ENV NODE_ENV=production
ENV PORT=3200
EXPOSE 3200

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:3200/health || exit 1

COPY --from=installer --chown=outpost:outpost /app/apps/github-app/start.sh ./apps/github-app/start.sh

CMD ["sh", "apps/github-app/start.sh"]
