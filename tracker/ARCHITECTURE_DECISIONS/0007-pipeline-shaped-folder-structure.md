# ADR-0007 — Backend folder structure follows the classification pipeline stages

Status: accepted, 2026-05-05
Scope: `clearai-backend/src/`
Owner: backend platform
Depends on: ADR-0006 (Two-track classification with reconciliation)

## Context

The current `src/modules/` layout was shaped by an earlier design that
routed line items by **input shape** — separate paths for description-only
(`hs-classification/classify/`), partial-code-plus-description
(`hs-classification/expand/`), and full-12-digit (`hs-classification/verify/`).
A `dispatch/` module existed to orchestrate a future 5-stage pipeline that
hadn't been specified yet, and `declaration-sets/classification/` wrapped
Phase 1 of the batch flow.

ADR-0006 retires input-shape routing in favour of uniform two-track
scrutiny: every item goes through Stage 1 cleanup, Stage 2 verdict
(Track A description classifier + Track B code resolver, reconciled into
one final code), Stage 3 sanity, Stage 4 declaration. There are no
longer "verify" / "expand" / "classify" *paths* — those concepts collapse
into Track A and Track B branches inside one stage.

The folder structure has not caught up. Files that implement the new
stages are scattered across the old folders:

- Cleanup lives in `hs-classification/classify/preprocess/description-cleanup.ts`
  even though it's now Stage 1, before any track work.
- The picker (`llm-pick.ts`), threshold check (`evidence-gate.ts`), and
  researcher (`research.ts`) all sit under `hs-classification/classify/`
  but are now substages of Track A specifically.
- `hs-classification/expand/*` is what Track B's prefix-pick branch does.
- `hs-classification/verify/*` is a v1 stub for what is now Stage 2's
  reconciliation — but reconciliation isn't a verify path, it runs on
  every item.
- `dispatch/` was the planned orchestrator; ADR-0006's pipeline use-case
  fills that role and renders dispatch redundant.
- Reconciliation, sanity, and HITL — three first-class concepts in
  ADR-0006 — have no folders at all.

The mismatch is real cost: a new engineer reading `src/modules/` cannot
infer the pipeline shape from the layout, and existing files are filed
under labels that no longer describe what they do.

## Decision

Backend folder structure mirrors ADR-0006's pipeline stages. Classification
work consolidates under one new top-level module, `modules/pipeline/`,
with subfolders for each stage. Old input-shape folders retire.

```
src/
├── config/                     unchanged
├── server/                     unchanged
├── db/                         unchanged
├── common/                     unchanged
├── inference/                  unchanged (embeddings, llm, retrieval primitives)
├── integrations/               unchanged (zatca/)
├── storage/                    unchanged
│
└── modules/
    ├── reference-data/         unchanged
    ├── tenants/                unchanged
    │
    ├── pipeline/               NEW — the classification pipeline
    │   ├── pipeline.routes.ts
    │   ├── pipeline.controller.ts
    │   ├── pipeline.use-case.ts        orchestrates Stage 1 → 4
    │   ├── pipeline.types.ts
    │   ├── pipeline.errors.ts
    │   │
    │   ├── stage-1-cleanup/
    │   │   ├── parse.ts                deterministic
    │   │   ├── token-extract.ts        regex (ASIN/EAN/GTIN)
    │   │   ├── cleanup.ts              LLM, emits cleaned + clarity_verdict
    │   │   ├── routing.ts              deterministic switch on the verdict
    │   │   └── stage-1.types.ts
    │   │
    │   ├── stage-2-verdict/
    │   │   ├── stage-2.use-case.ts     A and B in parallel, then reconcile
    │   │   ├── stage-2.types.ts
    │   │   │
    │   │   ├── track-a-description/    Track A — was hs-classification/classify
    │   │   │   ├── track-a.service.ts
    │   │   │   ├── researcher.ts       was preprocess/research*.ts
    │   │   │   ├── retrieval.ts        thin wrapper around inference/retrieval
    │   │   │   ├── threshold-check.ts  was evidence-gate.ts
    │   │   │   ├── picker.ts           was llm-pick.ts (emits alternatives)
    │   │   │   └── track-a.types.ts
    │   │   │
    │   │   ├── track-b-code/           Track B — was expand/ + override + lookup
    │   │   │   ├── track-b.service.ts
    │   │   │   ├── codebook-lookup.ts
    │   │   │   ├── tenant-override.ts
    │   │   │   ├── pick-among-replacements.ts   deleted, N replacements
    │   │   │   ├── pick-under-prefix.ts          partial, valid prefix
    │   │   │   └── track-b.types.ts
    │   │   │
    │   │   └── reconciliation/         NEW
    │   │       ├── reconciliation.service.ts
    │   │       ├── agreement-level.ts  deterministic prefix-match
    │   │       ├── reconciliation.prompt.ts
    │   │       └── reconciliation.types.ts
    │   │
    │   ├── stage-3-sanity/             NEW (slot existed; impl is new)
    │   │   ├── sanity.service.ts
    │   │   ├── sanity.prompt.ts
    │   │   └── sanity.types.ts
    │   │
    │   ├── stage-4-declaration/        was declaration-sets/declaration/
    │   │   ├── declaration.service.ts
    │   │   ├── declaration.repository.ts
    │   │   ├── declaration.runner.ts
    │   │   └── declaration.types.ts
    │   │
    │   ├── hitl/                       NEW (queue contract; UI out of scope)
    │   │   ├── hitl.repository.ts
    │   │   ├── hitl.types.ts
    │   │   └── hitl.errors.ts
    │   │
    │   ├── trace/                      NEW (cross-stage trace persistence)
    │   │   ├── trace.types.ts
    │   │   └── trace.repository.ts
    │   │
    │   └── shared/                     was hs-classification/shared
    │       ├── language.ts
    │       ├── score.ts
    │       └── residual-heading.ts
    │
    └── declaration-sets/               narrows to batch-level concerns
        ├── declaration-set.routes.ts
        ├── declaration-set.controller.ts
        ├── declaration-set.use-case.ts          loops pipeline per item
        ├── declaration-set.repository.ts
        ├── declaration-set.types.ts
        └── parsers/
            ├── csv.parser.ts
            └── xlsx.parser.ts
```

## What retires

- `modules/hs-classification/` — entire folder. Its three subfolders
  (`classify/`, `expand/`, `verify/`) were entry-shape labels.
  - `classify/preprocess/description-cleanup.ts` →
    `pipeline/stage-1-cleanup/cleanup.ts` (with broader contract)
  - `classify/preprocess/research*.ts` →
    `pipeline/stage-2-verdict/track-a-description/researcher.ts`
  - `classify/evidence-gate.ts` →
    `pipeline/stage-2-verdict/track-a-description/threshold-check.ts`
  - `classify/llm-pick.ts` →
    `pipeline/stage-2-verdict/track-a-description/picker.ts`
  - `classify/branch-rank.ts`, `branch-enumerate.ts` → inline into
    picker or move to `inference/retrieval/` if cross-cutting
  - `classify/best-effort-fallback.ts`, `stages/best-effort.stage.ts` →
    retire (not needed under uniform scrutiny)
  - `classify/interpretation.ts`, `filter-alternatives.ts` → fold into
    picker, or retire if subsumed by the new picker contract
  - `classify/submission-description*.ts` → keep if a sibling endpoint;
    home depends on whether it's a pipeline entry point or its own feature
  - `classify/classification-trace.routes.ts` → `pipeline/trace/`
  - `expand/*` → split between `track-b-code/codebook-lookup.ts` and
    `track-b-code/pick-under-prefix.ts`
  - `verify/*` → retire entirely (reconciliation replaces it)
  - `shared/*` → `pipeline/shared/`

- `modules/dispatch/` — entire folder. `pipeline.use-case.ts` is the
  orchestrator now. Route surface (`dispatch.routes.ts`,
  `dispatch.controller.ts`) merges into `pipeline/`.

- `modules/declaration-sets/classification/` — entire subfolder. The
  per-item Phase 1 wrapper collapses into `declaration-set.use-case.ts`
  as a thin loop calling `pipeline.use-case.ts` with the existing
  concurrency semaphore.

## What stays put

- `inference/` — embeddings, llm client, retrieval. Cross-cutting
  primitives, not stage-specific.
- `integrations/zatca/` — protocol code. Stage 4 consumes it but does
  not own it.
- `db/`, `common/`, `config/`, `server/`, `storage/`, `scripts/` — unchanged.
- `modules/tenants/` — unchanged. The pipeline reads tenant config; it
  does not own tenant-config code.
- `modules/reference-data/` — unchanged.

## Why `pipeline/` and not something else

Alternatives considered and rejected:

- **`classification/`** — collides with the existing
  `declaration-sets/classification/` slot and overlaps semantically with
  the HS-classification existing folder name.
- **`adjudication/`** — accurate but jargon-heavy. A new engineer would
  not know what to look for.
- **`scrutiny/`** — captures the principle but does not match the
  vocabulary used in ADR-0006 ("the pipeline").
- **`assess/`** — too generic.

`pipeline/` reads cleanly without prior context. The pipeline is the
classification pipeline; subfolders make the stages obvious.

## Why each stage gets its own folder

The previous structure mixed substages of one stage with siblings of
another (cleanup under `classify/preprocess/`, evidence-gate under
`classify/`, expand as a peer of classify). The new structure makes
the stage boundaries authoritative:

- A reader looking at `pipeline/stage-2-verdict/` sees three children
  (`track-a-description/`, `track-b-code/`, `reconciliation/`) and
  immediately knows what Stage 2 does.
- A change to reconciliation cannot accidentally land in a track-A
  folder.
- New stages (a future Stage 5, a future pre-Stage-1 normaliser) get
  numbered folders without restructuring the existing ones.

The numeric prefix (`stage-1-cleanup`, `stage-2-verdict`, etc.) makes
the pipeline order visible in `ls`. Trade-off: renumbering is
disruptive if a stage is inserted later. Mitigated by the fact that
ADR-0006 commits to four stages; insertions would need their own ADR
anyway.

## Naming convention reaffirmed

`<noun>.<role>.ts` from the existing folder-structure note still applies.
New role tags this ADR introduces:

| Role | Meaning |
|---|---|
| `prompt` | LLM prompt template for one stage / substage |

Used for `reconciliation.prompt.ts`, `sanity.prompt.ts`, etc. The
prompt file is co-located with the service that owns the call, so
prompt and code stay synchronised.

## Migration path

The restructure is not a single big-bang rewrite. Each step ends with
`pnpm typecheck && pnpm test` green:

1. Create the new folder skeleton empty (`pipeline/` and subfolders).
   No file moves.
2. Move leaf substages with import updates: cleanup, picker, threshold
   check, researcher, expand pieces.
3. Build new folders' stubs: reconciliation, sanity, HITL, trace.
4. Move Stage 4 declaration from `declaration-sets/declaration/` to
   `pipeline/stage-4-declaration/`.
5. Cut the route surface to `pipeline/pipeline.routes.ts`. Old route
   files become re-exports during transition, then delete.
6. Delete `hs-classification/`, `dispatch/`, `declaration-sets/classification/`.

Each step is independently committable. A rollback never spans more
than one commit.

## Consequences

**Locks in:**
- Stage boundaries are authoritative at the folder level. A change
  that crosses stage boundaries is visible in the diff (touches
  multiple `stage-*/` folders).
- The pipeline orchestrator (`pipeline.use-case.ts`) is the single
  entry point. No back doors that bypass stages.
- A future pipeline change that adds, removes, or merges a stage is
  also a folder rename — making the architectural change physically
  visible.

**Frees up:**
- New engineers can read the pipeline by reading the folder tree.
- Each stage has a clean import surface (`pipeline/stage-N-X/`); cross-
  stage imports are visible and rare.
- Reconciliation, sanity, and HITL are first-class concepts with their
  own homes — no longer scattered across other folders.

**Trades away:**
- Renumbering cost if a stage is inserted later. Acceptable because
  ADR-0006 fixes the stage count.
- Some short-term churn for tools that have folder paths memorised
  (IDE bookmarks, grep aliases, CI path filters). One-time.

## What this rules out

- **Per-merchant-state subfolders inside the pipeline.** No
  `pipeline/single-signal/`, no `pipeline/with-code/`. Routing by
  signal count or input shape is a Stage 2 concern, expressed in
  code, not file structure.
- **Verify as a path.** It is replaced by reconciliation. Any future
  proposal to reintroduce a verify-shaped fast-path is a new ADR
  per ADR-0004.
- **Dispatch as a separate module.** Its orchestration role is filled
  by `pipeline.use-case.ts`. Reintroducing it would re-fragment the
  pipeline.

## Revisit triggers

- A second pipeline emerges (e.g. a separate "reclassify" or "audit"
  flow) that genuinely cannot share `pipeline/`. At that point,
  `pipeline/` becomes one of several siblings under `modules/`.
- Stage count grows beyond ~6. Numeric prefixes become unwieldy; consider
  flattening or grouping by phase.
- Track A or Track B grows independently complex enough to warrant
  promotion to its own top-level module.

## Memory pointer

(none — the decision IS the memory)
