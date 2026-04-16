# ── Stage 1: prune the monorepo to only what @outpost/slack-bot needs ────────
FROM node:20-alpine AS pruner
RUN apk add --no-cache libc6-compat
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
RUN npm install -g turbo@2

COPY . .
RUN turbo prune @outpost/slack-bot --docker

# ── Stage 2: install dependencies and build ──────────────────────────────────
FROM node:20-alpine AS installer
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

COPY --from=pruner /app/out/full/ .
RUN pnpm turbo run build --filter=@outpost/slack-bot

# ── Stage 3: production image ────────────────────────────────────────────────
FROM node:20-alpine AS runner
RUN apk add --no-cache libc6-compat openssl

RUN addgroup --system --gid 1001 outpost && \
    adduser --system --uid 1001 outpost

WORKDIR /app

# Copy built output and node_modules
COPY --from=installer --chown=outpost:outpost /app/ ./

USER outpost
ENV NODE_ENV=production
ENV HEALTH_PORT=3002
EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:3002/health || exit 1

CMD ["node", "apps/slack-bot/dist/index.js"]
