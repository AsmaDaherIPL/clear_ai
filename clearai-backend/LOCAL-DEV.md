# Local development

Two ways to run the backend locally. Pick based on what you're testing.

| Mode | Postgres | Backend | When to use |
|---|---|---|---|
| **A. Hybrid (default)** | Docker | `pnpm dev` on host | Day-to-day. Hot reload on every save. |
| **B. Full Docker** | Docker | Docker (built from `Dockerfile`) | Verifying the prod image actually boots end-to-end. |

Both modes give you the **same backend at `http://localhost:3000`** and the **same routes** the deployed app exposes. APIM is the production gateway only — locally, the Fastify server is hit directly. The `APIM_SHARED_SECRET` guard is a no-op when `NODE_ENV=development`.

---

## Mode A — Hybrid (recommended for iteration)

Postgres in Docker, backend on the host with `tsx watch` for sub-second reload.

### One-time setup

```bash
cd clearai-backend
cp .env.example .env
# Edit .env — at minimum set ANTHROPIC_API_KEY
```

You need a working Foundry deployment to make LLM calls. Without it, `/health` and `/ready` and route-validation paths still work, but anything that calls the LLM (declaration-runs, submission-description) returns degraded.

### Boot

```bash
# 1. Postgres (idempotent — does nothing if already running)
pnpm db:up

# 2. Apply migrations
pnpm db:migrate

# 3. Seed the catalog (one-time per fresh DB) — these can take several minutes
pnpm db:seed              # zatca_hs_codes
pnpm db:seed:display      # zatca_hs_code_display (paths, labels)
pnpm db:seed:search       # zatca_hs_code_search (embeddings; ~25 min on M-series)
pnpm db:seed:procedures   # procedure_codes
pnpm db:seed:deleted      # SABER deleted codes
pnpm db:seed:tenants      # operators table (Naqel)
pnpm db:seed:tenant-lookups
pnpm db:seed:overrides:naqel

# 4. Start the backend
pnpm dev
```

You should see `readiness probe now passing — instance ready for traffic` after ~10–60 seconds (embedder load is the slowest step).

### Smoke test

In another terminal:

```bash
./local-dev/scripts/smoke-test.sh
```

Expected output: 8 ✓ checks pass. The `submission-description (real code)` check returns 404 if you haven't seeded the catalog yet — that's fine for a basic smoke test.

### Stop

```bash
# Ctrl-C the backend, then optionally:
pnpm db:down              # stops Postgres but keeps data
# OR
docker compose down -v    # stops + wipes pgdata volume
```

---

## Mode B — Full Docker

Builds the prod `Dockerfile` and runs both Postgres and the backend in compose. Slower (image build is ~3 min cold; the embedder ONNX model is baked into the image at ~85 MB), but it's the closest local mirror of what runs on Azure Container Apps.

### Boot

```bash
cd clearai-backend
cp .env.example .env.docker
# Edit .env.docker — set ANTHROPIC_API_KEY etc.

docker compose -f docker-compose.full.yml --env-file .env.docker up --build
```

Migrations run automatically (the runtime CMD is `migrate-and-start.js`).

### Smoke test

Same script:

```bash
./local-dev/scripts/smoke-test.sh
```

### Stop

```bash
docker compose -f docker-compose.full.yml down       # keeps pgdata
docker compose -f docker-compose.full.yml down -v    # wipes pgdata
```

### When to rebuild

Image rebuilds are needed when:

- `package.json` / `pnpm-lock.yaml` changed (deps)
- `src/`, `prompts/`, `drizzle/` changed (compiled into the image)
- `Dockerfile` changed

For all of those, `docker compose up --build` again.

If you're iterating on **just** Drizzle migrations or seed scripts, run them on the host against the Docker Postgres:

```bash
DATABASE_URL=postgres://clearai:clearai@localhost:5432/clearai pnpm db:migrate
```

---

## Routes you can hit locally

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Always 200 unless DB is down |
| GET | `/ready` | 503 during boot, then 200 |
| POST | `/declaration-runs` | Multipart upload (xlsx/csv) — 25 MB cap |
| GET | `/declaration-runs/:id` | Run summary |
| GET | `/declaration-runs/:id/classifications` | 425 while phase 1 running, then 200 |
| PATCH | `/declaration-runs/:id` | Body: `{ "status": "cancelled" }` |
| POST | `/pipeline/submission-description` | `{ description, code }` → Arabic |

See [openapi.yaml](openapi.yaml) for the full spec.

---

## Useful commands

```bash
# Typecheck without compiling
pnpm typecheck

# Run the full test suite (vitest)
pnpm test

# Watch mode for tests
pnpm test:watch

# Drizzle Studio — UI for browsing the local DB
pnpm db:studio

# Generate a new Drizzle migration after changing src/db/schema/*
pnpm db:generate

# Rebuild and migrate (Docker DB lifecycle from scratch)
pnpm db:down -v && pnpm db:up && pnpm db:migrate
```

---

## Common issues

**`relation "operators" does not exist`** — you skipped `pnpm db:migrate`. Run it.

**`/ready` returns 503 forever** — embedder failed to load. Check logs for `embedder warmup failed`. Common cause: ONNX runtime can't find a writable cache dir (`./models`). Verify `models/` is present and writable, or delete it and let it re-download.

**Submission-description returns `unknown_code`** — the HS code you sent isn't in `zatca_hs_codes`. Either seed the catalog (`pnpm db:seed`) or use a code from your seeded subset.

**`origin_access_denied` on every request locally** — `NODE_ENV` is set to `production` somewhere. Check `.env`. The APIM-secret guard only fires in production.

**Docker compose backend exits with `Cannot find module '@xenova/transformers'`** — your image is stale. Rebuild: `docker compose -f docker-compose.full.yml up --build`.

---

## What this doesn't cover

- **APIM-fronted testing.** That requires the infra agent's deployment to land. See [tracker/AGENT_BRIEFS/infra-agent-apim-handover-2026-05-06.md](../tracker/AGENT_BRIEFS/infra-agent-apim-handover-2026-05-06.md) for the production-traffic test plan.
- **Frontend integration.** SPA dev runs separately under `clearai-frontend/`. CORS is allowlisted by default for `localhost:5173` and `localhost:4321`.
- **Azure Blob storage.** Locally everything writes to `./.local-blob/` (a host directory mounted into the container in mode B). To exercise the real Azure SDK path, override `BATCH_BLOB_CONNECTION` with a real connection string.
