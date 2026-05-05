# ADR-0003 — Two-phase batch processing with mode default

Status: accepted, 2026-05-04
Scope: backend batches module
Owner: BatchPlumber

## Context

ClearAI's batch endpoint accepts a commercial-invoice CSV/XLSX from a tenant
and produces classified items + (usually) a ZATCA Declaration XML. Two
operating shapes emerged from the use-case discussion:

1. **End-to-end** — broker uploads → backend classifies every line item →
   backend builds + returns the ZATCA XML(s) to file with customs.
   This is the production path for Naqel.
2. **Classification only** — broker (or QA, or a frontend trace explorer)
   wants HS-code lookups for items without producing an XML. Useful for
   preview/validation workflows, eval harness runs, and debugging without
   accumulating throwaway XML artifacts.

The naïve approach is two endpoints. The cleaner approach is one endpoint
with a mode flag — same parsing, persistence, classification, observability,
just an optional second phase.

## Decision

Every batch carries a `mode` field on `batches` and on the upload request:

```ts
type BatchMode = 'classify_only' | 'classify_and_declare';
```

**Default is `classify_and_declare`**. `classify_only` is an explicit opt-out
chosen at upload time.

The processing pipeline is two phases:

**Phase 1 — Classification** (always runs)
- Owner: `src/modules/batches/classification/batch-classification.service.ts`
- For every pending item, calls `dispatch(canonicalLineItem)` from
  `modules/dispatch/`, persists `final_code` + `trace`, transitions item to
  one of `succeeded` / `flagged` / `blocked` / `failed`.
- Concurrency bounded by `BATCH_LLM_CONCURRENCY` via the in-process semaphore.
- Knows nothing about XML, ZATCA, or blob storage.

**Phase 2 — Declaration** (only when `mode === 'classify_and_declare'`)
- Owner: `src/modules/batches/declaration/batch-declaration.service.ts`
- Reads classified items with status ∈ {`succeeded`, `flagged`}
  (`blocked`/`failed` are excluded — they need human review before filing).
- Resolves tenant config (`bundleSize`, `hvThresholdSar`, constants).
- Calls `integrations/zatca/declaration/` for HV/LV bundling + XML rendering.
- Persists XML to blob, writes a row per bundle to `declarations`.
- Knows nothing about LLM calls or `dispatch()`.

The two phase services have **strict, non-overlapping responsibilities**.
Phase 1 never touches XML. Phase 2 never touches the LLM. The integration
layer (`integrations/zatca/declaration/`) never touches Postgres or blob —
it's pure functions that produce strings.

DB schema reflects the split:

```
batches.mode                   CHECK ('classify_only' | 'classify_and_declare')
batches.classification_status  CHECK ('pending'|'running'|'completed'|'failed')
batches.declaration_status     NULL when mode='classify_only';
                               otherwise CHECK ('pending'|'running'|'completed'|'failed'|'skipped')
batches.status                 derived overall lifecycle, materialised for cheap polling
```

A DB CHECK (`batches_mode_declaration_consistency_chk`) enforces:
`(mode = 'classify_only' AND declaration_status IS NULL) OR (mode = 'classify_and_declare' AND declaration_status IS NOT NULL)`.

## Consequences

**Frees up:**
- Frontend can show classification results as soon as Phase 1 completes,
  even when Phase 2 is still running.
- A QA/eval workflow can use the same batches infrastructure (status
  tracking, traces, item table, blob input storage) without producing
  XML — no special path, just `mode=classify_only`.
- If ZATCA goes down or the integration breaks, Phase 1 still works.
  Customers get classifications; declarations get re-run when the
  integration recovers.

**Locks in:**
- Two distinct status enums on `batches`. Polling clients have to
  understand both.
- `GET /batches/:id/declarations` returns 404 for `classify_only` and
  425 (Too Early) for `classify_and_declare` while Phase 2 is pending.

**Trade-offs:**
- A separate "declaration-only" endpoint that takes already-classified
  items as input would be more flexible (rerun Phase 2 against an old
  batch's results without rerunning Phase 1). We chose not to build that
  in v0 — it's the v1 idea below.

## What this rules out

- Implicit mode inference from request shape. Mode is always explicit on
  upload, even though it has a default.
- A "Phase 2 only" entry point. v0 always runs Phase 1 first.

## v1 idea (deferred)

Allow a PATCH to upgrade a finished `classify_only` batch to also produce
declarations: Phase 2 picks up from existing classified items without
re-running Phase 1. Adds modest state-machine complexity (`mode` becomes
mutable) for a real UX win (review classifications, then decide to file).

Trigger to revisit: real users ask for it.

## Memory pointer

`memory/project_zatca_two_step_flow.md`
