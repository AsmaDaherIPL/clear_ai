# SPA Migration — PR1 declaration_run → batch rename

**Backend commit/revision**: TBD (will fill in after deploy)
**Backend deploy date**: 2026-05-18
**Status**: backend in flight; SPA must follow before pilot resumes

This document is the lockstep change list the frontend agent needs to apply
in `clearai-frontend/` to recover from PR1. The backend has done a **hard
cutover** — there is no dual-emit period. Endpoints and response shapes
have changed; the SPA will throw on first paint until this list is applied.

The semantic model is unchanged. Only names change. No new fields, no new
endpoints, no removed functionality.

---

## Vocabulary change

| Old name | New name |
|---|---|
| declaration_run | batch |
| declaration run id | batch id |
| declaration_run_id (snake) | batch_id (snake) |
| declarationRunId (camel) | batchId (camel) |
| DeclarationRun (Pascal type) | Batch (Pascal type) |

UI copy stays as "batch" / "batches" — that's already what the SPA shows
to users. The change is purely the wire field names.

---

## HTTP endpoints

The route paths were already `/batches/...` — no path changes. Only response
bodies and request bodies change.

### Endpoints whose response bodies change

| Method + Path | Field that renamed | Old | New |
|---|---|---|---|
| `POST   /batches` | response.id | unchanged | unchanged |
| `GET    /batches` | each row's `id` field | unchanged | unchanged |
| `GET    /batches/:id` | response body shape | unchanged | unchanged |
| `GET    /batches/:id/items` | each item's parent id | `declaration_run_id` | `batch_id` |
| `GET    /batches/:id/items/:itemId` | item's parent id | `declaration_run_id` | `batch_id` |
| `GET    /batches/:id/filings` | each filing's parent id | `declaration_run_id` | `batch_id` |
| `PATCH  /batches/:id` | response body | `DeclarationRunRow` shape | `BatchRow` shape (same fields) |
| `DELETE /batches/:id` | response body | unchanged | unchanged |

### Endpoints whose request bodies change

None. POST /batches takes the same input shape today; the rename is internal
to the row representation.

---

## Response field renames (the actual list)

Wherever the SPA reads any of these fields, rename:

| Old field (wire) | New field (wire) |
|---|---|
| `declaration_run_id` | `batch_id` |
| `declaration_run` (object key in nested responses) | `batch` |
| `declaration_run_status` | `batch_status` |
| `declarationRunId` (camelCase if any) | `batchId` |

Search-and-replace targets in the SPA codebase:
- Type files: any `DeclarationRun*` TypeScript types map to `Batch*` (see
  the type-rename table below).
- Network layer: any `data.declaration_run_id` → `data.batch_id`.
- Component props: anywhere a prop is named `declarationRunId` →
  `batchId`. (UI copy showing "batch" stays — only the JS identifier
  changes.)

---

## TypeScript type renames (if the SPA mirrors backend types)

If the frontend imports or duplicates these type names, rename in lockstep:

| Old type | New type |
|---|---|
| `DeclarationRunRow` | `BatchRow` |
| `NewDeclarationRunRow` | `NewBatchRow` |
| `DeclarationRunItemRecord` | `BatchItemRecord` |
| `DeclarationRunItemRow` | `BatchItemRow` |
| `DeclarationRunItemInput` | `BatchItemInput` |
| `DeclarationRunFilingRow` | `BatchFilingRow` |
| `CreateDeclarationRunInput` | `CreateBatchInput` |
| `CreateDeclarationRunResult` | `CreateBatchResult` |
| `PatchDeclarationRunBody` | `PatchBatchBody` |
| `DeclarationRunError` | `BatchError` |
| `DeclarationRunModeSchema` | `BatchModeSchema` |
| `DeclarationRunMode` (if exported) | `BatchMode` |
| `DeclarationRunStatus` (if exported) | `BatchStatus` |

The shape of each type is unchanged. Only the name changes.

---

## URL params and query strings

Route params already use the path segment `:id`. If anything in the SPA
constructs query strings like `?declaration_run_id=...`, rename to
`?batch_id=...`. Audit the entire SPA for the string `declaration_run`
(snake) and `declarationRun` (camel) and rename each occurrence per the
table above.

---

## Trace JSON inside item responses

The `trace` field on items contains pipeline output. Inside `trace.summary`,
no key is named `declaration_run_*` today — the trace was already entity-
agnostic. **No change needed inside trace.**

---

## Blob paths (NOT changing)

The blob storage paths still use `declaration-runs/<id>/...`. If the SPA
constructs blob URLs directly (it shouldn't — these are server-signed),
this path stays as-is. We are not moving existing blobs.

---

## Error envelopes

Backend errors that mention the entity in the human-readable `message`
field will read "batch ..." instead of "declaration_run ...". If the SPA
parses error messages by string-matching, that breaks. Recommendation:
read `err.code` (machine-readable enum) instead. The codes are unchanged.

Old codes that referenced declaration_run by name:
- (none — all codes were already entity-neutral, e.g. `not_found`,
  `validation_failed`, `state_transition_invalid`)

---

## SPA testing checklist after pulling the rename

1. **Load /batches list page** — must render without throwing.
2. **Open a batch detail** — items table must populate.
3. **Open an item** — trace renderer must show pipeline stages.
4. **HITL queue** — review rows must link back to their batch.
5. **Upload a new batch** — POST must succeed (no request-shape change,
   but worth verifying end-to-end).
6. **Cancel a batch** — PATCH endpoint still works.

If any of these throw, search the SPA codebase for the string
`declaration_run` or `declarationRun` to find a missed reference.

---

## Rollback plan if the SPA cannot ship in time

The backend can revert to revision `0000136` (sha-063dc4b) with one
command:

```bash
az containerapp update --name ca-infp-clearai-be-dev-gwc-01 \
  --resource-group rg-infp-clearai-common-dev-gwc-01 \
  --image ghcr.io/asmadaheripl/clearai-backend:sha-063dc4b
```

DB rollback requires a manual `ALTER TABLE RENAME` in the reverse
direction. Migration 0084 is reversible by hand but does not ship a
down-migration. If revert is needed, contact the backend agent and we
will generate the inverse migration.

---

## Confirmed wire-field state after backend cutover

Verified by grepping the backend after the rename completed:

- `openapi.yaml` — all `declaration_run_id` occurrences replaced with `batch_id`. No old-name fields remain in any request or response schema.
- Backend route handlers (`src/modules/batches/*.ts`) — every response envelope uses `batch_id` as the JSON key. Drizzle row serialisation naturally produces `batch_id` because the DB column is now `batch_id`.
- HITL queue rows — the `batch_id` column was already named `batch_id` pre-migration; no SPA change needed for that field name. The FK constraint just now points at `batches.id` instead of `declaration_runs.id`. Wire shape unchanged.

The only "code-side" comments still mentioning the old name are historical migration provenance notes — they describe what was renamed in PR1 and stay as audit context.

## Confirmed unchanged surfaces

- Route paths: `/batches`, `/batches/:id`, `/batches/:id/items`, `/batches/:id/filings` — all unchanged.
- Request body shapes for `POST /batches` and `PATCH /batches/:id` — unchanged.
- Trace JSON content inside item responses — unchanged. The trace was already entity-neutral; no `declaration_run_*` keys existed inside `trace.*` anyway.
- Blob path strings (`declaration-runs/<id>/...`) — kept as-is by design. The SPA should never construct these directly; if it does, no change needed.
- Error envelope `code` enums — entity-neutral, unchanged.
- HITL queue API — `batch_id` field was already named this way.

## Final SPA action items

1. **Search-and-replace in the SPA codebase**:
   - `declaration_run_id` → `batch_id` (snake_case, JSON keys)
   - `declarationRunId` → `batchId` (camelCase, JS identifiers and props)
   - Any TypeScript types named `DeclarationRun*` → `Batch*` (see table above)
2. **Verify after replace**: search for `declaration_run` and `declarationRun` to ensure no occurrences remain. If anything remains in UI copy strings, leave it (UI labels reading "Batch" are unchanged).
3. **Test the six flows** in the testing checklist section above.

## Backend deploy details

- Commit: `10fdf3e`
- Image: `ghcr.io/asmadaheripl/clearai-backend:sha-10fdf3e`
- Revision: `ca-infp-clearai-be-dev-gwc-01--0000137`
- Previous revision (for revert): `0000136` (sha-063dc4b)
- Migration applied: `0084_rename_declaration_runs_to_batches.sql`
- Health check: HTTP 200, deploy verified
- Status: **Live on dev**. SPA must apply matching field renames before pilot resumes.

## Changelog

- 2026-05-18 (morning) — doc created at start of PR1 work.
- 2026-05-18 (afternoon) — backend rename complete. tsc clean, pipeline-v2 tests 190/190.
- 2026-05-18 (evening) — deployed to dev as revision 0000137. Doc finalised. Hand off to frontend agent.
