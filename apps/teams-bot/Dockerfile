# -- Stage 1: prune the monorepo to only what @copilotkit/outpost-teams-bot needs --------
FROM node:24-alpine AS pruner
RUN apk add --no-cache libc6-compat
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
RUN npm install -g turbo@2

COPY . .
RUN turbo prune @copilotkit/outpost-teams-bot --docker

# -- Stage 2: install dependencies and build ----------------------------------
FROM node:24-alpine AS installer
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

COPY --from=pruner /app/out/full/ .
COPY --from=pruner /app/tsconfig.json ./tsconfig.json
RUN pnpm turbo run build --filter=@copilotkit/outpost-teams-bot

# -- Stage 3: production image ------------------------------------------------
FROM node:24-alpine AS runner
RUN apk add --no-cache libc6-compat openssl

RUN addgroup --system --gid 1001 outpost && \
    adduser --system --uid 1001 outpost

WORKDIR /app

COPY --from=installer --chown=outpost:outpost /app/node_modules ./node_modules
COPY --from=installer --chown=outpost:outpost /app/apps/teams-bot/dist ./apps/teams-bot/dist
COPY --from=installer --chown=outpost:outpost /app/apps/teams-bot/package.json ./apps/teams-bot/package.json
# pnpm's isolated layout keeps the app's own deps here (symlinked into root .pnpm) — required at runtime.
COPY --from=installer --chown=outpost:outpost /app/apps/teams-bot/node_modules ./apps/teams-bot/node_modules
COPY --from=installer --chown=outpost:outpost /app/packages ./packages
COPY --from=installer --chown=outpost:outpost /app/package.json ./package.json

USER outpost
ENV NODE_ENV=production
ENV HEALTH_PORT=3003
ENV PORT=3978
EXPOSE 3003 3978

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:3003/health || exit 1

COPY --from=installer --chown=outpost:outpost /app/apps/teams-bot/start.sh ./apps/teams-bot/start.sh

CMD ["sh", "apps/teams-bot/start.sh"]
