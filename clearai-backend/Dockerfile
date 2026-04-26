# syntax=docker/dockerfile:1.7
#
# ClearAI backend — multi-stage build for Azure Container Apps.
#
# Stage layout:
#   1. base    — Node 22 alpine + pnpm (shared by deps/build/runtime)
#   2. deps    — pnpm install (with dev deps, needed for tsc + tsx + drizzle-kit)
#   3. build   — tsc compile to dist/, prefetch embedder ONNX model into models/
#   4. runtime — minimal layer with prod deps only + dist/ + models/ + prompts/
#
# The embedder is BAKED INTO the image (~85 MB) so the first request after a
# cold container takes ~2s instead of ~30–60s waiting on Hugging Face CDN.
# The prefetch runs against ./models, which the runtime stage copies verbatim
# — embedder.ts reads cacheDir = './models' so this matches at runtime.
#
# Listens on 0.0.0.0:${PORT} (default 3000) which matches the Container App's
# `targetPort: 3000`. Health probe path: /health.

# Debian slim (glibc) — NOT alpine. `onnxruntime-node` (transitive dep of
# @xenova/transformers) ships a prebuilt linked against glibc, and crashes
# at module load on musl with `ERR_DLOPEN_FAILED: ld-linux-x86-64.so.2`.
# We pay ~80 MB of base size to avoid fighting the runtime.
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
# Full install (incl. dev deps) so the build stage can run tsc + the embedder
# prefetch script. No source code yet — this layer is cached on lockfile only.
FROM base AS deps
COPY package.json pnpm-lock.yaml* ./
# `--prod=false` to ensure devDeps land. NODE_ENV=production from base would
# otherwise tell pnpm to skip them.
#
# `pnpm rebuild` after install forces the postinstall scripts of the
# allow-listed native deps (sharp, esbuild, protobufjs — see package.json
# `pnpm.onlyBuiltDependencies`) to actually run. Without this, sharp's
# linux-x64 prebuilt isn't downloaded, and onnxruntime-node + transformers
# fall over at module load.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod=false \
    && pnpm rebuild

# ---------- 3. build ------------------------------------------------------
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
COPY prompts ./prompts
# Drizzle SQL + meta — needed at runtime by the migrator wrapper, but
# included here because we may run `pnpm db:migrate` from this image too.
COPY drizzle ./drizzle

# Compile TS → dist/.
RUN pnpm build

# Prefetch the ONNX embedder model into ./models so the runtime image
# ships with weights present. We do this with a tiny inline script that
# imports the same pipeline() the app uses, with the same cacheDir, so
# what we bake in is exactly what runtime expects to find.
#
# The model is Xenova/multilingual-e5-small by default (see env.ts).
# Override with EMBEDDER_MODEL build-arg if you need a different one.
ARG EMBEDDER_MODEL=Xenova/multilingual-e5-small
ENV EMBEDDER_MODEL=${EMBEDDER_MODEL}
RUN node --input-type=module -e " \
  import('@xenova/transformers').then(async ({ pipeline, env }) => { \
    env.allowLocalModels = true; \
    env.cacheDir = './models'; \
    console.log('[prefetch] downloading', process.env.EMBEDDER_MODEL); \
    await pipeline('feature-extraction', process.env.EMBEDDER_MODEL, { quantized: true }); \
    console.log('[prefetch] done'); \
  }).catch((e) => { console.error(e); process.exit(1); }); \
"

# ---------- 4. runtime ----------------------------------------------------
# Fresh prod-only install so node_modules has zero dev deps. Then copy in
# dist/, models/, prompts/, drizzle/ from the build stage.
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000

COPY package.json pnpm-lock.yaml* ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod \
    && pnpm rebuild

COPY --from=build /app/dist     ./dist
COPY --from=build /app/models   ./models
COPY --from=build /app/prompts  ./prompts
COPY --from=build /app/drizzle  ./drizzle

# Drop privileges. node:alpine ships a `node` user (uid 1000); use it.
RUN chown -R node:node /app
USER node

EXPOSE 3000

# tini as PID 1 — forwards SIGTERM cleanly to Node so the Fastify
# shutdown() handler runs (closes app + drains DB pool) before the
# Container App scales the replica out.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
