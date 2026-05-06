# Handover note for the batch-plumber agent — 2026-05-06 (part 2)

A second large rename landed today on top of the morning's `declaration-runs` rename. Read this **before resuming any in-flight branch.** Same drill as last time: rebase against `main`, run the new migration, sweep your code for the old names.

## What was renamed

### Domain term: tenant → operator

| Concept | Old | New |
|---|---|---|
| Folder | `clearai-backend/src/modules/tenants/` | `clearai-backend/src/modules/operators/` |
| Folder (tests) | `clearai-backend/tests/tenants/` | `clearai-backend/tests/operators/` |
| File | `tenant-config.types.ts` | `operator-config.types.ts` |
| File | `tenant-config.registry.ts` | `operator-config.registry.ts` |
| File | `tenant.repository.ts` | `operator.repository.ts` |
| File | `tenant.errors.ts` | `operator.errors.ts` |
| File | `tenant-line-item.mapper.ts` | `operator-line-item.mapper.ts` |
| File | `tenant-constants.repository.ts` | `operator-constants.repository.ts` |
| File | `tenant-lookups.repository.ts` | `operator-lookups.repository.ts` |
| File | `scripts/seed-tenants.ts` | `scripts/seed-operators.ts` |
| File | `scripts/seed-tenant-lookups.ts` | `scripts/seed-operator-lookups.ts` |

### DB tables (renamed by migration 0049)

| Old | New |
|---|---|
| `tenants` | `operators` |
| `tenant_field_mappings` | `operator_field_mappings` |
| `tenant_constants` | `operator_constants` |
| `tenant_lookups` | `operator_lookups` |
| `tenant_code_overrides` | `operator_code_overrides` |
| `declarations` | `declaration_run_filings` |

Plus, on every table that had a `tenant` column (or `tenant` as the FK to `tenants.slug`):
- Column renamed to `operator_slug`
- FK renamed (e.g. `*_tenant_fk` → `*_operator_slug_fk`)
- Index renamed (e.g. `*_tenant_idx` → `*_operator_slug_idx`)
- CHECK constraints renamed in the same pattern
- Trigger renamed (`tenants_touch_updated_at_trg` → `operators_touch_updated_at_trg`)

The `declarations.declaration_set_id` column had already been renamed to `declaration_run_id` by migration 0048; today's 0049 also catches the new constraint names if 0048 has run.

### TypeScript symbols

| Old | New |
|---|---|
| `TenantConfig` | `OperatorConfig` |
| `TenantRow`, `NewTenantRow` | `OperatorRow`, `NewOperatorRow` |
| `TenantFieldMappingRow`, `NewTenantFieldMappingRow` | `OperatorFieldMappingRow`, `NewOperatorFieldMappingRow` |
| `TenantConstantRow`, `NewTenantConstantRow` | `OperatorConstantRow`, `NewOperatorConstantRow` |
| `TenantLookupRow`, `NewTenantLookupRow` | `OperatorLookupRow`, `NewOperatorLookupRow` |
| `TenantCodeOverrideRow` | `OperatorCodeOverrideRow` |
| `TenantNotFoundError` | `OperatorNotFoundError` |
| `tenants` (Drizzle const) | `operators` |
| `tenantFieldMappings` | `operatorFieldMappings` |
| `tenantConstants` | `operatorConstants` |
| `tenantLookups` | `operatorLookups` |
| `tenantCodeOverrides` | `operatorCodeOverrides` |
| `declarations` (Drizzle const) | `declarationRunFilings` |
| `declarationSetId` / `tenantSlug` (params, fields) | `declarationRunId` / `operatorSlug` |
| `getTenantBySlug`, `listTenants`, `upsertTenant`, `resolveTenant` | `getOperatorBySlug`, `listOperators`, `upsertOperator`, `resolveOperator` |
| `RenderInput.tenant` | `RenderInput.operator` |

### HTTP / route changes from the morning rename (recap)

Already on `main` from the earlier rename; mentioned for completeness:
- `/declaration-sets/*` → `/declaration-runs/*`
- `:declId` → `:id`
- `POST /submission-description` → `POST /pipeline/submission-description`
- `GET /tenants`, `/tenants/:slug`, `POST /tenants/refresh` HTTP routes deleted (registry stays internal)

### Other changes today

- Multipart upload limit: 50 MB → **25 MB** ([declaration-run.controller.ts:221](clearai-backend/src/modules/declaration-runs/declaration-run.controller.ts:221))
- `modules/declaration-runs/declaration/` → `modules/declaration-runs/filings/` (Phase 2 runner folder)
- ADR-0002 file renamed: `0002-tenants-as-data-not-code.md` → `0002-operators-as-data-not-code.md`. ADRs 0003, 0004, 0006, 0007 had their prose swept (`tenant` → `operator`).

## What you need to do

1. **Rebase against `origin/main`** (the rename commit is on top of `c4db1fc`):
   ```bash
   git fetch origin
   git rebase origin/main
   ```
   Conflicts will hit anywhere your branch touched anything in `modules/tenants/`, `modules/declaration-runs/`, the schema files, or controllers/repositories. Accept the renamed paths; reapply your logic on top.

2. **Run the migration locally**:
   ```bash
   cd clearai-backend && pnpm db:migrate
   ```
   This applies `0049_tenant_to_operator_filings_rename.sql`.

3. **Sweep your unmerged work** for any of the old names. A useful one-liner:
   ```bash
   grep -rE "\btenant|Tenant|tenants?\b|declaration_set_id|declarationSetId|TenantConfig|tenantSlug|RenderInput\.tenant|\bdeclarations\b" src tests
   ```
   Should return nothing after your update.

4. **Storage paths.** Anything writing to `storage/declaration-runs/<runId>/declarations/...` continues to work because the *path prefix* didn't change — only the DB **table** for tracking those XMLs changed. If you've added new code that paths against `tenants/` or `declarations/` segments, switch to `operators/` or `filings/` accordingly.

## What didn't change

- `dispatch.contract.ts` — `DispatchFn`, `DispatchResult`, `ItemTrace`, `SanityVerdict` are unchanged.
- `CanonicalLineItem` shape — unchanged.
- The two-phase model (`mode = 'classify_only' | 'classify_and_declare'`) — unchanged.
- The `xlsx → CanonicalLineItem` mapping logic — unchanged.
- Storage path layout under `BATCH_BLOB_CONTAINER` — unchanged.

## What's still open for you

The route file [declaration-runs.routes.ts](clearai-backend/src/modules/declaration-runs/declaration-runs.routes.ts) still has Phase 5 (filings) endpoints unimplemented:
- `GET /declaration-runs/:id/filings` (list)  ← rename from earlier-planned `/declarations`
- `GET /declaration-runs/:id/filings/:id` (one)

When you ship those, use `:id` (not `:declId`) for the inner filing ID, and use `declarationRunFilings` from `db/schema/declaration-run-filings.ts`.

## Verification before your next push

```bash
cd clearai-backend
pnpm db:migrate
pnpm tsc --noEmit
pnpm test --run
```

All three should pass. As of this rename commit, **278 tests pass** on `main`.

## Questions

If anything is ambiguous, ping back — especially around:
- In-flight code paths against `operator_lookups` (the lookup_type filter signature didn't change but the column did)
- Any code that destructures `{ tenant }` from a row return — that field is now `operatorSlug`
