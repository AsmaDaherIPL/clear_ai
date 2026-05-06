# Handover note for the batch-plumber agent — 2026-05-06

The naming of the batch-processing module changed today. This note tells you what to update on your side and where the surface now lives. Read this before resuming any in-flight branch — your old branch will conflict with `main`.

## What was renamed

| Concept | Old | New |
|---|---|---|
| Folder | `clearai-backend/src/modules/declaration-sets/` | `clearai-backend/src/modules/declaration-runs/` |
| Folder (tests) | `clearai-backend/tests/declaration-sets/` | `clearai-backend/tests/declaration-runs/` |
| HTTP route prefix | `/declaration-sets/*` | `/declaration-runs/*` |
| HTTP param (single declaration in run) | `:declId` | `:id` |
| File: routes | `declaration-sets.routes.ts` | `declaration-runs.routes.ts` |
| File: controller | `declaration-set.controller.ts` | `declaration-run.controller.ts` |
| File: use-case / errors / repository / types / validation / use-case | `declaration-set.*` | `declaration-run.*` |
| DB table | `declaration_sets` | `declaration_runs` |
| DB table | `declaration_set_items` | `declaration_run_items` |
| DB column | `declarations.declaration_set_id` | `declarations.declaration_run_id` |
| Drizzle schema files | `db/schema/declaration-sets.ts`, `declaration-set-items.ts` | `db/schema/declaration-runs.ts`, `declaration-run-items.ts` |
| TS symbol | `DeclarationSet*` (types, interfaces, classes) | `DeclarationRun*` |
| TS symbol | `declarationSet*` (variables, functions) | `declarationRun*` |
| TS symbol | `declarationSetId` | `declarationRunId` |
| Storage path prefix | `declaration-sets/...` | `declaration-runs/...` |
| Drizzle migration | (added) `drizzle/0048_declaration_runs_rename.sql` | renames tables + columns + indexes + constraints + trigger |

The migration is idempotent (guarded `DO $$ BEGIN ... END $$` blocks for every rename) and applies cleanly on a fresh DB or one that already had the old names.

## What was deleted

`clearai-backend/src/modules/tenants/tenants.routes.ts` is gone. The HTTP surface for tenants (`GET /tenants`, `GET /tenants/:slug`, `POST /tenants/refresh`) is no longer exposed. The internal `tenant-config.registry.ts` is unchanged — your code can still call `resolve(slug)` and `warmAll()` exactly as before. Only the public HTTP surface was retired.

## What you need to do

1. **Stop work on your current branch if it's based on `main` from before this commit** — you'll need to rebase. Run:
   ```bash
   git fetch origin
   git rebase origin/main
   ```
   Conflicts will land in any file you modified that I also touched (likely `declaration-sets.routes.ts` ↔ `declaration-runs.routes.ts`, the schema files, and the use-case). Resolve by accepting the renamed paths from `main` and re-applying your logic on top.

2. **Run the migration locally**:
   ```bash
   cd clearai-backend && pnpm db:migrate
   ```
   This applies `0048_declaration_runs_rename.sql`. Your local DB will end up matching CI.

3. **Update any new code you've added** that still references the old names. `grep -rn "declaration-set\|declaration_set\|DeclarationSet\|declarationSet" src tests` should return nothing after your update.

4. **Storage paths**: anything you write to `storage/` under the old `declaration-sets/...` prefix needs to move to `declaration-runs/...`. The constant lives at [src/storage/blob.paths.ts](clearai-backend/src/storage/blob.paths.ts).

## What you don't need to do

- Don't write a fresh migration for the rename; mine (0048) already covers it.
- Don't touch the frontend — that's a separate task owned elsewhere.
- Don't restore the `/tenants` HTTP routes — they're gone deliberately.

## Endpoints that are still drafted but not implemented

The route file [declaration-runs.routes.ts](clearai-backend/src/modules/declaration-runs/declaration-runs.routes.ts) reserves `GET /declaration-runs/:id/declarations` (list) and implies `GET /declaration-runs/:id/declarations/:id` (one). Those return 404 today. When you ship Phase 5, use `:id` (not `:declId`) for the inner declaration ID — we standardised on `:id` for every resource in the path.

## What didn't change

- `dispatch.contract.ts` — `DispatchFn`, `DispatchResult`, `ItemTrace`, `SanityVerdict` are unchanged.
- `CanonicalLineItem` shape — unchanged.
- The two-phase model — unchanged: classification phase always runs, declaration phase runs only when `mode === 'classify_and_declare'`.
- Per-tenant config flow — unchanged.

## Verification before you push your next PR

```bash
cd clearai-backend
pnpm db:migrate
pnpm tsc --noEmit
pnpm test --run
```

All three should pass. As of the rename commit, 278 tests pass on `main`.

## Questions

If anything is ambiguous (especially around storage path migration for in-flight blobs) ping back before guessing — the rename should be invisible to ZATCA submissions and to existing rows because of the guarded migration, but if you've staged uploads under the old path locally they may need re-pathing.
