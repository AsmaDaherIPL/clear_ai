# syntax=docker/dockerfile:1.7
#
# ClearAI backend — multi-stage build for Azure Container Apps.
#
# Stage layout:
#   1. base    — Node 22 slim + pnpm (shared by deps/build/runtime)
#   2. deps    — pnpm install (with dev deps, needed for tsc + tsx + drizzle-kit)
#   3. build   — tsc compile to dist/
#   4. runtime — minimal layer with prod deps only + dist/ + prompts/ + drizzle/
#
# Plan B step 1 swap (2026-05-07): the embedder is now Foundry-hosted
# text-embedding-3-large. The image no longer bakes any ONNX model
# weights, no longer pulls @xenova/transformers, and no longer pre-fetches
# anything at build time. Cold-start is now a clean ~2s Node boot.
#
# Listens on 0.0.0.0:${PORT} (default 3000) which matches the Container
# App's `targetPort: 3000`. Health probe path: /health.

# Debian slim. Pre-Plan-B we needed glibc for onnxruntime-node's prebuilt;
# now that ONNX is gone we could move to alpine, but slim still gives us
# `apt-get install tini` cheaply and no app surface depends on glibc.
ARG NODE_VERSION=22-bookworm-slim

# ---------- 1. base -------------------------------------------------------
FROM node:${NODE_VERSION} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NODE_ENV=production
# tini for proper PID-1 signal handling (Container Apps sends SIGTERM on
# scale-in; without tini, Node receives it but child sockets can hang).
RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
WORKDIR /app

# ---------- 2. deps -------------------------------------------------------
# Full install (incl. dev deps) so the build stage can run tsc. No source
# code yet — this layer is cached on lockfile only.
FROM base AS deps
COPY package.json pnpm-lock.yaml* ./
# `--prod=false` to ensure devDeps land. NODE_ENV=production from base
# would otherwise tell pnpm to skip them.
#
# `pnpm rebuild` after install forces the postinstall scripts of the
# allow-listed native deps (sharp, esbuild — see package.json
# `pnpm.onlyBuiltDependencies`) to actually run. Without this, sharp's
# linux-x64 prebuilt isn't downloaded.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod=false \
    && pnpm rebuild

# ---------- 3. build ------------------------------------------------------
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
COPY prompts ./prompts
# Drizzle SQL + meta — needed at runtime by the migrator wrapper.
COPY drizzle ./drizzle

# Compile TS → dist/.
RUN pnpm build

# ---------- 4. runtime ----------------------------------------------------
# Fresh prod-only install so node_modules has zero dev deps. Then copy in
# dist/, prompts/, drizzle/ from the build stage.
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000

COPY package.json pnpm-lock.yaml* ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod \
    && pnpm rebuild

COPY --from=build /app/dist     ./dist
COPY --from=build /app/prompts  ./prompts
COPY --from=build /app/drizzle  ./drizzle

# Drop privileges. The `node` user (uid 1000) ships in the slim image.
RUN chown -R node:node /app
USER node

EXPOSE 3000

# tini as PID 1 — forwards SIGTERM cleanly to Node so the Fastify
# shutdown() handler runs (closes app + drains DB pool) before the
# Container App scales the replica out.
ENTRYPOINT ["/usr/bin/tini", "--"]
# Production entry runs Drizzle migrations first, then boots Fastify. The
# migrator is idempotent (drizzle ledger, ADR-0010), so cold starts after
# the first deploy of a release are no-ops. If migrations fail, the process
# exits non-zero and Container Apps keeps the previous revision serving.
CMD ["node", "dist/scripts/migrate-and-start.js"]
