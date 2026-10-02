# syntax=docker/dockerfile:1
#
# The spDEX keeper and its report. docs/KEEPER.md is the operator's guide.
#
# Build context: the repository root (compose.yaml sets it), trimmed by the
# root .dockerignore to the few files the keeper runs on — never an .env file,
# a key or a report.
#
# It runs the repository's TypeScript as it is, the way `pnpm keeper` does:
# Node strips the types, and packages/vault/scripts/ts-hooks.mjs maps the `.js`
# specifiers to their `.ts` files. There is no build step and no bundle, so
# what runs is exactly the source a reader can check.

# Pinned by version and by the manifest list's digest, so amd64 and arm64
# hosts (a free ARM VM, a Raspberry Pi, Apple Silicon) resolve the same pin
# and nobody's build silently moves to a different Node. 22.23 has
# module.registerHooks, which the keeper needs (22.15 or later).
ARG NODE_IMAGE=node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9

# ─── Dependencies ─────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# The pnpm the lockfile was written with (packageManager in package.json).
RUN corepack enable && corepack prepare pnpm@12.4.2 --activate

# Only the manifests the keeper's packages need, each at its own path: the
# filtered, frozen install reads nothing else, and a source change then
# never invalidates this layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/chain/package.json packages/chain/
COPY packages/vault/package.json packages/vault/

# Production dependencies of @spdex/vault and the workspace packages it uses,
# exactly as locked; no install scripts run. --no-optional leaves out viem's
# optional TypeScript peer, about 30 MB the keeper never loads.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts --no-optional \
      --store-dir /pnpm/store --filter "@spdex/vault..."

# ─── Runtime ──────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
# Where the source is published and which commit this is, when the builder
# says (compose passes SPDEX_KEEPER_GIT_SHA); both are empty otherwise.
ARG GIT_SHA=""
ARG SOURCE_URL=""
LABEL org.opencontainers.image.title="spdex-keeper" \
      org.opencontainers.image.description="Triggers due spDEX vault buys in batches, for their buy fees" \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.revision="${GIT_SHA}"
WORKDIR /app

# The workspace links are symlinks into node_modules/.pnpm; COPY keeps them.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=deps /app/packages/chain/node_modules ./packages/chain/node_modules
COPY --from=deps /app/packages/vault/node_modules ./packages/vault/node_modules

# The sources, at their monorepo paths. They must stay outside node_modules:
# the workspace links resolve to these real paths, and Node refuses to strip
# types from a file under node_modules (which is also why `pnpm deploy`,
# which copies packages into node_modules, cannot be used here).
COPY packages/core/package.json packages/core/
COPY packages/core/src packages/core/src
COPY packages/chain/package.json packages/chain/
COPY packages/chain/src packages/chain/src
COPY packages/vault/package.json packages/vault/
COPY packages/vault/src packages/vault/src
COPY packages/vault/scripts packages/vault/scripts
COPY scripts/env.mjs scripts/env.mjs

ENV NODE_ENV=production \
    SPDEX_KEEPER_DATA_DIR=/data \
    SPDEX_KEEPER_GIT_SHA=${GIT_SHA}

# Compose runs the keeper as the operator's own uid (KEEPER_UID), so the
# secrets they created are readable without a chown. /data is world-writable
# with the sticky bit so that any such uid can write its state there; a new
# named volume copies this mode on first use, and the host side of a volume is
# root's alone anyway.
RUN mkdir /data && chmod 1777 /data
VOLUME /data

# uid 1000 when run without compose; compose.yaml overrides it.
USER node

# Liveness only: a heartbeat written within the last three intervals. An RPC
# outage shows in heartbeat.json (`ok`, `attention`), not here, because a
# restart fixes neither. Plain Compose never acts on this; the keeper's own
# watchdog exits instead, and the restart policy brings it back.
HEALTHCHECK --interval=60s --timeout=10s --start-period=180s --retries=3 \
  CMD ["node", "packages/vault/scripts/keeper-health.mjs"]

# No EXPOSE: the keeper listens on nothing.
ENTRYPOINT ["node", "--experimental-transform-types", "--disable-warning=ExperimentalWarning", "--import", "./packages/vault/scripts/ts-hooks.mjs", "packages/vault/scripts/keeper.ts"]
