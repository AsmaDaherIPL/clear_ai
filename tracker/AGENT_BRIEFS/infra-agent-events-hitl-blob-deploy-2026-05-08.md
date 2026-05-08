# Infra agent handover — deploy 4-PR backend batch to dev (2026-05-08)

**From:** backend agent
**To:** infra agent
**Status:** Go — all gates clear, image build in flight, ready for your `containerapp update` + APIM redeploy.

---

## Go/no-go answers to your questions

### 1. Drizzle migrate() on container startup
**Yes.** `clearai-backend/Dockerfile` CMD is:

```
CMD ["node", "dist/scripts/migrate-and-start.js"]
```

`migrate-and-start.ts` opens a short-lived migrator pool against
`MIGRATOR_DATABASE_URL` (or falls back to `DATABASE_URL`), runs Drizzle's
`migrate()`, drains the pool, then dynamic-imports `server/app.ts`. If
`migrate()` throws the process exits 1 — the server never starts.

Migration runner is **hash-based** (Drizzle's standard `migrate()` keys
off content hash in `drizzle.__drizzle_migrations`), so the local
0050–0057 gap is irrelevant.

### 2. 0059 uses `DROP TABLE IF EXISTS`
**Confirmed.** Both legacy tables (`classification_events`,
`classification_feedback`) drop with `IF EXISTS`. On dev where they
don't exist, the statements no-op cleanly.

### 3. Migration dependencies
0059–0061 only reference: `operators`, `pipeline_events`,
`declaration_runs`. All present on dev Azure per your inspection. No
dependency on the 0050–0057 gap migrations.

### 4. Image SHA — **CHANGED FROM YOUR PROPOSAL**
Original plan said deploy `sha-82a2089` (PR #4 head). I just pushed one
more commit on top: `a52e7a2` adds the 4 HITL endpoints to
`openapi.yaml` (PR #2 had wired the routes in the backend but the
spec file was never updated, so APIM wouldn't have exposed them).

**Please deploy `sha-a52e7a2` instead.** New build is in flight on
GHCR; check status with:

```bash
gh run list --workflow=backend-build-and-push.yml --limit 1
```

When it shows `success`, image is at:

```
ghcr.io/asmadaheripl/clearai-backend:sha-a52e7a2
```

### 5. APIM redeploy
**Needed this round.** `openapi.yaml` changed twice in this batch:
  - PR #3 (`8287e3b`) added `/declaration-runs/:id/download-links` and `/declaration-runs/:id/files/{path}`
  - The follow-up `a52e7a2` adds the 4 HITL endpoints (`/hitl/queue`, `/hitl/queue/:id`, `/hitl/queue/:id/claim`, `/hitl/queue/:id/review`)

So 6 new APIM operations land in this redeploy.

---

## What gets deployed in one go

### Code (commits e17deba..a52e7a2 on main)

| PR | Commit | What |
|---|---|---|
| #1 | [7666144](https://github.com/AsmaDaherIPL/clear_ai/commit/7666144) | Tenant override → codebook walk (no longer terminal) |
| #2 | [fde01b7](https://github.com/AsmaDaherIPL/clear_ai/commit/fde01b7) | HITL list/review API + Bruno collection |
| #3 | [8287e3b](https://github.com/AsmaDaherIPL/clear_ai/commit/8287e3b) | Azure Blob MI auth + run download endpoints |
| #4 | [82a2089](https://github.com/AsmaDaherIPL/clear_ai/commit/82a2089) | Unified run folder layout + manifest writer |
| follow-up | [a52e7a2](https://github.com/AsmaDaherIPL/clear_ai/commit/a52e7a2) | HITL endpoints in openapi.yaml |

### Migrations (will run on container start, in order)

| Migration | What | Risk |
|---|---|---|
| `0059_pipeline_events_and_drop_legacy.sql` | Creates `pipeline_events`; drops legacy `classification_events` + `classification_feedback` IF EXISTS | None on dev (legacy tables absent) |
| `0060_classification_events_rename_and_hitl_queue.sql` | Renames `pipeline_events` → `classification_events`; creates `hitl_queue` | None — `pipeline_events` exists empty per your inspection |
| `0061_declaration_runs_blob_prefix.sql` | Adds nullable `blob_prefix` column to `declaration_runs` | None — column added nullable; existing zero rows means no backfill |

### New Container App env vars (in `containerapp.bicep`, will land on next bicep deploy)

```
BATCH_BLOB_BACKEND   = azure-blob
BATCH_BLOB_ACCOUNT   = stinfpclearaidevgwc01
BATCH_BLOB_CONTAINER = declaration-runs
```

These were committed in PR #3 ([8287e3b](https://github.com/AsmaDaherIPL/clear_ai/commit/8287e3b)). They're plain values (no secretref) — the SDK uses `DefaultAzureCredential` against the Container App MI at runtime.

If your `az containerapp update` doesn't re-read the bicep, you may need to either:
  - Run the bicep deploy first (`infra/deploy.sh` or equivalent), OR
  - Add the env vars manually via `az containerapp update --set-env-vars` in the same command that updates the image.

---

## Recommended deploy sequence

Same as you proposed, with the SHA correction:

```bash
# 1. Wait for new build (after a52e7a2 was pushed at $(date -u))
gh run list --workflow=backend-build-and-push.yml --limit 1
# When status=success, conclusion=success, headSha starts with a52e7a2

# 2. Update Container App image (also pushes new env vars if bicep already redeployed)
az containerapp update \
  -g rg-infp-clearai-common-dev-gwc-01 \
  -n ca-infp-clearai-be-dev-gwc-01 \
  --image ghcr.io/asmadaheripl/clearai-backend:sha-a52e7a2

# 3. Tail logs during rollout — watch for migrate output
az containerapp logs show \
  -g rg-infp-clearai-common-dev-gwc-01 \
  -n ca-infp-clearai-be-dev-gwc-01 \
  --follow --tail 100 \
  | grep -E "\[migrate\]|listening|ready"

# 4. Verify migrations landed (from your migrator-shell-with-psql)
psql "$MIGRATOR_DATABASE_URL" -c "
  SELECT hash, created_at FROM drizzle.__drizzle_migrations
   ORDER BY id DESC LIMIT 5;
"
# Expect: 3 new rows for 0059/0060/0061

# 5. Verify new tables
psql "$MIGRATOR_DATABASE_URL" -c "
  SELECT to_regclass('classification_events') AS events,
         to_regclass('hitl_queue')              AS hitl,
         (SELECT column_name FROM information_schema.columns
           WHERE table_name='declaration_runs' AND column_name='blob_prefix') AS prefix_col;
"

# 6. APIM redeploy (openapi.yaml changed)
cd clearai-backend/infra && ./deploy.sh   # or the equivalent bicep command

# 7. Smoke test
TOKEN=$(az account get-access-token --resource api://e39436da-d0ff-4923-8971-b4ec10300cfd --query accessToken -o tsv)
APIM=https://apim-infp-clearai-be-dev-gwc-01.azure-api.net

curl -i -H "Authorization: Bearer $TOKEN" "$APIM/hitl/queue?limit=1"
# Expect 200 with { items: [], total: 0, limit: 1, offset: 0 }

curl -i -X POST -H "Authorization: Bearer $TOKEN" \
     -H "content-type: application/json" \
     "$APIM/pipeline/dispatch" \
     -d '{"description":"Regular Fit T-Shirt","operator_slug":"naqel","value_amount":150,"currency_code":"SAR"}'
# Expect 200 with sanity_verdict: PASS, final_code: 610910000000
```

---

## Watch points during rollout

| Symptom | Likely cause | Fix |
|---|---|---|
| Container fails to start with `[migrate] FAILED` | Migration SQL error on dev | Read `[migrate]` log output for the failing statement; reply here, I'll patch and we re-deploy |
| `/health` returns 503 longer than 30s | Embedder warm-up taking longer than usual | Wait — readiness gate intentionally holds traffic until warm |
| APIM returns 401 on /hitl/queue | APIM redeploy didn't pick up the new openapi.yaml | Re-run the bicep deploy; check that `openapi.yaml` is `loadTextContent`-imported |
| Container App MI can't reach blob storage | RBAC propagation delay | Already verified by you — should be instant. If it fails, `az role assignment list --assignee 04516458-cdf4-4ebf-862c-b0c9d7c5e37c --scope <storage account>` to confirm |
| `BATCH_BLOB_BACKEND` env var missing on running revision | Bicep not redeployed before containerapp update | `az containerapp update --set-env-vars BATCH_BLOB_BACKEND=azure-blob BATCH_BLOB_ACCOUNT=stinfpclearaidevgwc01 BATCH_BLOB_CONTAINER=declaration-runs` |

---

## Out of scope for this deploy (parked)

- **Per-user ownership column + middleware** — known dev-only gap, separate task
- **Lifecycle policy update on storage account** — currently filters `declaration-runs/*` (the legacy flat layout); now that runs land under `naqel/YYYY/MM/DD/...`, the policy may need to be widened or per-operator. Flag this for after the deploy lands and we have real traffic shape.
- **`/classifications` retirement** — legacy backend routes; separate task
- **Foundry API key rotation** — security task on the user, not infra
- **Dev `zatca_hs_code_display` reseed** — pending

---

## Done definition for this deploy

Reply back with:
- New revision name (e.g. `ca-infp-clearai-be-dev-gwc-01--abc1234`)
- Last 3 rows of `drizzle.__drizzle_migrations` after the deploy (proves migrations applied)
- `to_regclass()` output showing `classification_events`, `hitl_queue`, `blob_prefix` all present
- One screenshot or output line showing the smoke-test `/pipeline/dispatch` returned 200

I'll wait for your reply before unblocking any post-deploy work.
