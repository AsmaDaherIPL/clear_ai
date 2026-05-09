# Infra agent — deploy update (2026-05-09)

**From:** backend agent
**Status:** Image built on GHCR, awaiting `az containerapp update`. Backend agent attempted from this shell but `az` requires MFA re-auth.

---

## Image to deploy

```
ghcr.io/asmadaheripl/clearai-backend:sha-ad798f1
```

GHCR build for `ad798f1` completed at 17:41 UTC.

---

## What's new since the last brief (sha-a52e7a2)

Five commits, all backend, all on main:

| SHA | What |
|---|---|
| `972839f` | Sanity prompt loosened — order-of-magnitude only, default PASS |
| `c59edf7` | SPA Batch tab wiring (frontend) |
| `f777ef6` | classification_events single-source rule (drop /pipeline/trace fallback) |
| `9b7fc22` | ZATCA submitter cols on operators (later moved in 0063) |
| `7fc9813` | Batch HITL enqueue + drop empty-string finalCode (P1.1) |
| `62a43d5` | Reconciliation rejects hallucinated codes; Track B null on uncertainty (P1.2/P1.3) |
| `71e92a9` | Cleanup deny-list for generic shipping nouns (P1.4) |
| `fff9e3b` | operator_declaration_config — collapse render defaults into one table (0063) |
| `ad798f1` | Drop operator_constants — last 3 keys move to typed columns (0064) |

---

## Migrations that run on container start

Three new migrations land in this revision. All run via `migrate-and-start.js` as the `clearai_migrator` role.

| Migration | What | Risk |
|---|---|---|
| `0062_operators_zatca_submitter.sql` | Adds 3 nullable columns to `operators` | None |
| `0063_operator_declaration_config.sql` | Creates `operator_declaration_config`, backfills from `operators.zatca_*` + `operators.default_consignee_address` + `zatca_declaration_defaults`. Drops `operators.zatca_*`, `operators.default_consignee_address`, `zatca_declaration_defaults` table | Defensive PL/pgSQL; tested locally |
| `0064_operator_declaration_config_constants.sql` | Adds 3 cols to `operator_declaration_config`, backfills from `operator_constants`, drops `operator_constants` table | Defensive PL/pgSQL; tested locally |

**Net schema change on dev Azure:**
- `operators` row shrinks to identity-only (slug, broker license, Tabadul user/account)
- New 1:1 table `operator_declaration_config` with every render default
- `zatca_declaration_defaults` and `operator_constants` tables disappear

---

## Recommended sequence

```bash
az account set --subscription 8b4ce84d-8f95-4d64-9740-2f565448b5d5

# Update image
az containerapp update \
  -g rg-infp-clearai-common-dev-gwc-01 \
  -n ca-infp-clearai-be-dev-gwc-01 \
  --image ghcr.io/asmadaheripl/clearai-backend:sha-ad798f1

# Backend agent's first attempt failed — the container app may live in a
# different RG than expected. If the above errors with "does not exist":
#   az containerapp list --query "[].{name:name, rg:resourceGroup}" -o table

# Watch migration log
az containerapp logs show \
  -g rg-infp-clearai-common-dev-gwc-01 \
  -n ca-infp-clearai-be-dev-gwc-01 \
  --type=console --follow --tail 100 \
  | grep -E "\[migrate\]|listening|ready|FAILED"
```

Look for `[migrate] applying from .../drizzle …` then `[migrate] up to date`. If `[migrate] FAILED`, capture the SQL error and ping me.

---

## Post-deploy manual step (admin)

Naqel's `zatca_submitter_carrier_id` ships null. Phase 2 fails with an operator-scoped error message until populated. Run after the deploy lands:

```sql
UPDATE operator_declaration_config
   SET zatca_submitter_carrier_id = '<value from Naqel ZATCA portal>'
 WHERE operator_id = (SELECT id FROM operators WHERE slug = 'naqel');
```

Backend agent doesn't have the value; Naqel needs to share it from their ZATCA registration.

---

## Verification queries (dev Azure)

```sql
-- 1. Migrations applied
SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 5;

-- 2. New table exists, old tables gone
SELECT to_regclass('operator_declaration_config') AS new_table,
       to_regclass('zatca_declaration_defaults')  AS dropped_1,
       to_regclass('operator_constants')          AS dropped_2;

-- 3. Naqel has a row backfilled
SELECT operator_id, zatca_submitter_carrier_id, default_reg_port_code, doc_ref_prefix,
       declaration_type, transport_type
  FROM operator_declaration_config
 WHERE operator_id = (SELECT id FROM operators WHERE slug = 'naqel');
```

---

## Done definition

Reply back with:
- New revision name
- Last 3 rows of `drizzle.__drizzle_migrations`
- Output of verification query #2 (should show `new_table` populated, `dropped_1` and `dropped_2` NULL)
- One smoke test: `curl ... POST /pipeline/dispatch` with the T-shirt body — expect PASS (the sanity prompt fix is included)
