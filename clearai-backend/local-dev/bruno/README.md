# Bruno collection — ClearAI Backend API

File-based API client (Bruno) for hand-testing every live endpoint. Lives next to the code so it's version-controlled and reviewable in PRs.

Bruno docs: https://docs.usebruno.com

---

## Why Bruno (not Postman)

- **Files in git.** Each request is a `.bru` text file. Diffs are reviewable. No proprietary cloud sync.
- **Same collection, two environments.** `localhost.bru` vs `dev-apim.bru` — flip with one click.
- **Secrets stay local.** Bearer tokens go into a `.env` next to the collection (gitignored), not into the request file.

---

## Setup (one-time)

1. Install Bruno: https://www.usebruno.com/downloads
2. In Bruno: **Open Collection** → pick `clearai-backend/local-dev/bruno/`.
3. Pick an environment in the top-right dropdown (`localhost` or `dev-apim`).

---

## Environments

| Environment | When to use | `baseUrl` |
|---|---|---|
| `localhost` | Backend running locally via `pnpm dev` (or `docker-compose.full.yml`). No auth. | `http://localhost:3000` |
| `dev-apim` | Live deployed APIM. Real Entra auth required. | `https://apim-infp-clearai-be-dev-gwc-01.azure-api.net` |

Each environment exposes:
- `baseUrl` — gateway/server prefix
- `operatorSlug` — defaults to `naqel`
- `realCode` — a 12-digit HS code that exists in the seeded catalog
- `fakeUuid` — a known-bad UUID for negative testing
- `bearerToken` — **secret**, you fill it in

---

## Setting the bearer token (for `dev-apim`)

Two options.

### Option A — `.env` file (recommended)

Create `clearai-backend/local-dev/bruno/.env` (already gitignored at the repo level):

```
bearerToken=eyJ0eXAiOiJKV1Qi...
```

Get a fresh token via the Azure CLI:

```bash
az account get-access-token \
  --resource api://infp-clearai-api-dev-01 \
  --query accessToken -o tsv
```

The resource id is the API's AppId URI (matches the `validate-jwt` audience in APIM). Tokens last 60 minutes; refresh as needed.

### Option B — set it in the Bruno UI

Click the environment in the top-right → edit → fill in `bearerToken` under "Secret variables." This is saved per-machine and never committed.

---

## What's in the collection

```
local-dev/bruno/
├── bruno.json
├── environments/
│   ├── localhost.bru
│   └── dev-apim.bru
├── probes/
│   ├── 01_health.bru          GET /health           (no auth)
│   └── 02_ready.bru           GET /ready            (auth)
├── declaration-runs/
│   ├── fixtures/
│   │   └── sample-1-row.csv   minimal Naqel-shape upload
│   ├── 01_create.bru          POST /declaration-runs (multipart)
│   ├── 02_get.bru             GET  /declaration-runs/:id
│   ├── 03_classifications.bru GET  /declaration-runs/:id/classifications
│   └── 04_cancel.bru          PATCH /declaration-runs/:id   {status:cancelled}
└── pipeline/
    ├── 01_dispatch.bru                  POST /pipeline/dispatch
    ├── 02_dispatch_with_code.bru        POST /pipeline/dispatch (with merchant_code)
    ├── 03_trace_get.bru                 GET  /pipeline/trace/:id
    └── 04_submission_description.bru    POST /pipeline/submission-description
```

---

## Recommended test flow

### Quick health check (any env)

1. `probes/01_health` → 200
2. `probes/02_ready` → 200 (after warmup)

### End-to-end declaration run (10–60s)

1. `declaration-runs/01_create` — uploads `sample-1-row.csv`. The post-response script auto-stores the new `declaration_run_id` into the collection variable `lastRunId` for the next requests.
2. `declaration-runs/02_get` — poll until `classification_status: "completed"`.
3. `declaration-runs/03_classifications` — inspect per-item results (`final_code`, `sanity_verdict`, full `trace`).
4. `declaration-runs/04_cancel` — only if you want to abort mid-flight.

### Single-shot pipeline (5–15s)

1. `pipeline/01_dispatch` — single description, no merchant code.
2. `pipeline/02_dispatch_with_code` — same description with a merchant 6-digit prefix; verify Track A and Track B agree (or note the disagreement in `trace.verdict`).
3. `pipeline/04_submission_description` — generate the ZATCA Arabic for a chosen code.

### Trace replay

`pipeline/03_trace_get` — uses an item id from a real `declaration-runs` classifications response (single-shot dispatch results aren't persisted).

---

## Auth behaviour by environment

| Endpoint | localhost | dev-apim (no token) | dev-apim (bad token) | dev-apim (valid token) |
|---|---|---|---|---|
| `GET /health` | 200 (Fastify) | 200 (APIM short-circuit) | 200 | 200 |
| Everything else | 200 (NODE_ENV=development) | 401 (validate-jwt) | 401 | 200 / route response |

The `dev-apim (no token)` column is exactly the verification matrix the infra agent ran in commit `9c18182`. Use the same requests to spot-check after any APIM redeploy.

---

## When to update this collection

- **Backend ships a new endpoint** → add a `.bru` file under the matching folder + update [openapi.yaml](../../openapi.yaml) in the same PR.
- **APIM URL changes** (custom domain, new env) → update `environments/<env>.bru` only.
- **Schemas change** (request body or response shape) → update the body block + asserts in the relevant `.bru` files.

---

## CI / automation

Bruno has a `bru run` CLI that can drive this collection in CI:

```bash
npx -y @usebruno/cli run --env localhost
```

Out of scope for this commit. Could be wired into `pnpm test:smoke` later if useful.
