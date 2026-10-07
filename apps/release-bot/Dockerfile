# ── Stage 1: prune the monorepo to only what @copilotkit/outpost-release-bot needs ──
# Pinned to a minor, like turbo and pnpm below. A floating `node:22-alpine` is
# not a watchPattern input, so a rebuild triggered by any watched file could
# move the runtime version underneath an otherwise identical image.
FROM node:22.20-alpine AS pruner
RUN apk add --no-cache libc6-compat
WORKDIR /app

# No pnpm in this stage: pruning runs on turbo alone.
#
# This literal is the version pnpm-lock.yaml resolves for the root `turbo`
# devDependency (the root declares the range ^2.3.0, which resolves to 2.9.6).
# Nothing enforces the match: npm resolves this pin from the registry, not from
# the lockfile, so the two drift silently and the pruner can run a different
# turbo than every local `turbo run` does. Bump this literal in the same commit
# that bumps the root devDependency, and re-read the resolved version out of
# pnpm-lock.yaml rather than copying the declared range.
RUN npm install -g turbo@2.9.6

COPY . .
# `turbo prune --docker` uses the SCM file list when .git is present. .dockerignore
# excludes .git, so it falls back to a filesystem walk and would rake in whatever
# the host left lying around. .dockerignore keeps node_modules out of the context
# in the first place; this scrub is the second line of defence, because a host
# node_modules reaching out/full/ would be copied over the linux install in the
# stage below and produce an image whose native modules are darwin binaries.
RUN turbo prune @copilotkit/outpost-release-bot --docker \
    && find out/full -name node_modules -type d -prune -exec rm -rf {} +

# ── Stage 2: install dependencies and build ──────────────────────────────────
FROM node:22.20-alpine AS installer
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Matches the root package.json's packageManager field; corepack honours that
# field, so a different pin here would be silently ignored at best.
#
# The Node pin has to stay at 22.14 or later for this line to work at all. npm
# rotated its registry signing keys after 22.12 shipped, and the corepack
# bundled with 22.12 and 22.13 (0.29.4 and 0.30.0) does not carry the new key:
# this exact command fails there with `Cannot find matching keyid`, so the image
# never builds. 0.31.0, in Node 22.14, is the first that works.
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate

# Manifests and the pruned lockfile first, so this install layer is reused on any
# change that touches only sources. Keep this ordering: it is the whole point of
# the two-step pruned copy.
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

# Sources second. out/full/ is scrubbed of node_modules in the pruner stage above,
# so this COPY merges sources over the install rather than overwriting it.
COPY --from=pruner /app/out/full/ .
COPY --from=pruner /app/tsconfig.json ./tsconfig.json
RUN pnpm turbo run build --filter=@copilotkit/outpost-release-bot \
    && rm -f apps/release-bot/dist/*.tsbuildinfo

# ── Stage 3: production image ────────────────────────────────────────────────
# No Prisma, no database, no health server: this service talks to GitHub, YouTube,
# OpenAI and Discord over HTTPS, announces what is new, and exits.
FROM node:22.20-alpine AS runner

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 outpost && \
    adduser --system --uid 1001 outpost

WORKDIR /app

# No node_modules. This package declares no dependencies - every import in src/
# is relative or a Node builtin (`node:fs`, `node:url`) - and the installer stage runs a plain `pnpm install`
# without --prod, so copying either tree would ship turbo, typescript, eslint,
# prettier, vitest and tsx into a container that runs one script and exits.
#
# Adding the first runtime dependency means adding the copy back, and pnpm's
# isolated layout puts an app's own deps in apps/release-bot/node_modules
# symlinked into the root store, so it is both trees plus a --prod install.
COPY --from=installer --chown=outpost:outpost /app/apps/release-bot/dist ./apps/release-bot/dist
# "type": "module" lives here and is load-bearing for ESM resolution of ./x.js.
COPY --from=installer --chown=outpost:outpost /app/apps/release-bot/package.json ./apps/release-bot/package.json

USER outpost

CMD ["node", "apps/release-bot/dist/index.js"]
