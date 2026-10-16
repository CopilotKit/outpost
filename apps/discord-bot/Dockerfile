# ── Stage 1: prune the monorepo to only what @copilotkit/outpost-discord-bot needs ──────
FROM node:24-alpine AS pruner
RUN apk add --no-cache libc6-compat
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
RUN npm install -g turbo@2

COPY . .
RUN turbo prune @copilotkit/outpost-discord-bot --docker

# ── Stage 2: install dependencies and build ──────────────────────────────────
FROM node:24-alpine AS installer
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

COPY --from=pruner /app/out/full/ .
COPY --from=pruner /app/tsconfig.json ./tsconfig.json
RUN pnpm turbo run build --filter=@copilotkit/outpost-discord-bot

# ── Stage 3: production image ────────────────────────────────────────────────
FROM node:24-alpine AS runner
RUN apk add --no-cache libc6-compat openssl

RUN addgroup --system --gid 1001 outpost && \
    adduser --system --uid 1001 outpost

WORKDIR /app

COPY --from=installer --chown=outpost:outpost /app/node_modules ./node_modules
COPY --from=installer --chown=outpost:outpost /app/apps/discord-bot/dist ./apps/discord-bot/dist
COPY --from=installer --chown=outpost:outpost /app/apps/discord-bot/package.json ./apps/discord-bot/package.json
# pnpm's isolated layout puts the bot's own deps (e.g. discord.js) here, symlinked
# into the root .pnpm store — must be copied or runtime fails with ERR_MODULE_NOT_FOUND.
COPY --from=installer --chown=outpost:outpost /app/apps/discord-bot/node_modules ./apps/discord-bot/node_modules
COPY --from=installer --chown=outpost:outpost /app/packages ./packages
COPY --from=installer --chown=outpost:outpost /app/package.json ./package.json

USER outpost
ENV NODE_ENV=production
ENV HEALTH_PORT=3001
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:3001/health || exit 1

COPY --from=installer --chown=outpost:outpost /app/apps/discord-bot/start.sh ./apps/discord-bot/start.sh

CMD ["sh", "apps/discord-bot/start.sh"]
