# ADR — Backend folder structure (modules + inference + integrations)

Status: accepted, 2026-05-05
Scope: `clearai-backend/src/`

## The structure

```
src/
├── config/                          environment + app-level constants
│   ├── env.ts
│   └── app-config.ts
│
├── server/                          Fastify bootstrap, middleware, error envelope
│   ├── app.ts
│   └── error-handler.ts
│
├── db/                              persistence layer
│   ├── client.ts
│   ├── schema.ts                    barrel re-export
│   ├── types.ts
│   └── schema/                      one file per table
│       ├── classification-events.ts
│       ├── zatca-hs-codes.ts
│       ├── zatca-hs-code-display.ts
│       ├── zatca-hs-code-search.ts
│       ├── zatca-procedure-codes.ts
│       ├── tenant-code-overrides.ts
│       ├── setup-meta.ts
│       ├── batches.ts               (stub; BatchPlumber)
│       ├── batch-items.ts           (stub; BatchPlumber)
│       ├── tenants.ts               (stub; BatchPlumber)
│       ├── tenant-field-mappings.ts (stub; BatchPlumber)
│       ├── tenant-constants.ts     (stub; BatchPlumber)
│       └── tenant-lookups.ts       (stub; BatchPlumber)
│
├── common/                          cross-cutting helpers, no business logic
│   ├── errors/
│   ├── http/                        route-helpers.ts
│   ├── validation/                  api-schemas.ts
│   ├── logging/                     log-event.ts, redact.ts
│   ├── concurrency/                 semaphore.ts (stub)
│   └── utils/                       sanitize.ts, uuid.ts
│
├── inference/                       runtime model + retrieval primitives
│   ├── llm/                         client.ts, structured-call.ts, parse-json.ts
│   ├── embeddings/                  embedder.ts
│   └── retrieval/                   retrieve.ts, digit-normalize.ts, known-prefixes.ts
│
├── integrations/                    external-system protocol code
│   └── zatca/
│       ├── declaration/             ACTIVE — ClearAI's output
│       │   ├── declaration.template.ts (stub)
│       │   ├── declaration.bundler.ts  (stub)
│       │   └── declaration.types.ts    (stub)
│       ├── manifest/                STUB — out of scope (Naqel files it)
│       │   └── README.md
│       ├── zatca.namespaces.ts      (stub)
│       ├── zatca.types.ts           (stub)
│       └── zatca.errors.ts          (stub)
│
└── modules/                         feature verticals — each is self-contained
    ├── reference-data/              read-only catalog repos
    │   ├── hs-codes.repository.ts    (TODO: extracted, currently inlined elsewhere)
    │   ├── deleted-codes.repository.ts
    │   ├── procedure-codes.repository.ts
    │   ├── duty-info.service.ts
    │   └── setup-meta.repository.ts
    │
    ├── tenants/                     DB-backed tenant config — NO per-tenant subfolders
    │   ├── tenants.routes.ts
    │   ├── tenant-config.registry.ts
    │   ├── tenant.repository.ts
    │   ├── tenant-line-item.mapper.ts
    │   ├── tenant-lookups.repository.ts
    │   ├── tenant-constants.repository.ts
    │   ├── tenant-config.types.ts
    │   └── tenant.errors.ts
    │
    ├── dispatch/                    v2 5-stage pipeline orchestrator
    │   ├── dispatch.routes.ts
    │   ├── dispatch.controller.ts
    │   ├── dispatch.use-case.ts
    │   ├── dispatch-input-normalizer.ts
    │   ├── dispatch.validation.ts
    │   ├── dispatch.types.ts
    │   └── dispatch.errors.ts
    │
    ├── hs-classification/           Stage 2A blind classify + expand + verify
    │   ├── classify/
    │   ├── expand/
    │   ├── verify/                  v1 stub
    │   └── shared/
    │
    └── batches/                     bulk ingest + 2-phase processing
        ├── batches.routes.ts
        ├── batch.controller.ts
        ├── batch.use-case.ts        thin orchestrator: parse → persist → phase1 → branch on mode → phase2
        ├── batch.repository.ts
        ├── batch.validation.ts      includes the BatchMode field on upload
        ├── batch.types.ts           BatchMode = 'classify_only' | 'classify_and_declare'
        ├── batch.errors.ts
        ├── parsers/                 csv.parser.ts, xlsx.parser.ts
        ├── classification/          PHASE 1 — runs always
        │   ├── batch-classification.service.ts
        │   ├── batch-classification.repository.ts
        │   └── batch-classification.types.ts
        └── declaration/             PHASE 2 — runs only when mode === 'classify_and_declare'
            ├── batch-declaration.service.ts
            ├── batch-declaration.repository.ts
            └── batch-declaration.types.ts
```

## Two-phase batch processing

A batch is parameterized by `mode`:

| Mode | Phase 1 (classification) | Phase 2 (declaration) |
|---|---|---|
| `classify_and_declare` (default) | runs | runs |
| `classify_only` | runs | skipped |

The default is `classify_and_declare` because most batches are filed as ZATCA Declarations.
`classify_only` is an explicit opt-out for QA / preview workflows where the user wants HS-code
results without producing XML.

**Phase 1 — `modules/batches/classification/`**
- Drives `dispatch.use-case` over every pending item with a p-limit semaphore.
- Writes per-item `classification_result` + `trace` + status into `batch_items`.
- Updates `batches.classification_status`.
- Knows nothing about XML, ZATCA, or blob storage.

**Phase 2 — `modules/batches/declaration/`**
- Reads classified items (status ∈ {`succeeded`, `flagged`}; `blocked`/`failed` excluded).
- Resolves tenant config (`bundleSize`, `hvThresholdSar`, `tenant_constants`).
- Calls `integrations/zatca/declaration/` for HV/LV bundling + XML rendering.
- Persists XML to blob and rows to a `declarations` table.
- Updates `batches.declaration_status`.
- Knows nothing about LLM calls or `dispatch()`.

`v1 idea (deferred):` allow a PATCH to upgrade a finished `classify_only` batch to also
produce declarations — phase 2 would pick up from existing classified items without re-running
phase 1. State-machine complexity vs. UX win — revisit if real users ask for it.

## Why each grouping

- **`config/`** — env validation + frozen constants live in one obvious place; everything else imports from here.
- **`db/`** — pure persistence. `db/schema/` holds Drizzle tables one file each; `db/schema.ts` re-exports them.
- **`common/`** — cross-cutting helpers shared by every module (logging, errors, validation, http, utils). Strict rule: nothing domain-specific lands here.
- **`inference/`** — runtime model + retrieval primitives. Separated from feature modules because they're shared between classify, expand, dispatch, and any future bulk endpoint.
- **`integrations/`** — wire-format / protocol code for external systems. ZATCA is the only one today; future external integrations land as siblings (e.g. `integrations/saber/`).
- **`modules/`** — feature verticals. Each vertical is internally consistent: `routes` + `controller` + `use-case` + `repository` + `validation` + `types` + `errors`. Verticals depend on `db/`, `inference/`, `integrations/`, and `common/` — never on each other except through explicit, public-surface use-cases.

## File-naming convention

`<noun>.<role>.ts`

| Role | Meaning |
|---|---|
| `routes` | Fastify route registration; thin |
| `controller` | request/response mapping; thin |
| `use-case` | business orchestration; calls repos + integrations |
| `repository` | Drizzle queries only |
| `service` | application service that wraps several repos / integrations |
| `mapper` | input/output transformation |
| `validation` | zod schemas |
| `types` | shared TypeScript types |
| `errors` | custom error classes |
| `template` | string-template-based renderer (XML, etc.) |
| `bundler` | grouping/partitioning logic |
| `registry` | in-memory cache of DB-backed config |
| `client` | wrapper around an external SDK |
| `stage` | one step in a multi-stage pipeline |

## Why no per-tenant subfolders under `tenants/`

Tenant configuration is **data**, not code. A new tenant is rows in:
- `tenants` (one row)
- `tenant_field_mappings` (N rows — column mapping rules)
- `tenant_constants` (M rows — fixed XML envelope values)
- `tenant_lookups` (cities, currencies, countries, ports, etc.)

Adding a new tenant requires zero TypeScript edits and zero deploys.
The single generic mapper in `modules/tenants/tenant-line-item.mapper.ts` consumes
those rows and produces a `CanonicalLineItem`.

## Module ownership

- `modules/batches/` (incl. `classification/` and `declaration/` subfolders) + `modules/tenants/` + `integrations/zatca/` + `db/schema/{batches,batch-items,tenants,tenant-*}.ts` + `common/concurrency/` + `src/storage/` →
  **BatchPlumber** agent. See `tracker/AGENT_BRIEFS/batch-plumber.md`.

- `modules/dispatch/` →
  **dispatch-flow** agent (v2 5-stage pipeline). To be briefed after triage flow finalized.

- `modules/hs-classification/` (existing classify + expand + future verify) →
  the classification work that's already in flight; will own the `verify/` v1 build out
  once dispatch flow is locked.

## What we deliberately did NOT do

1. **Did not split `routes/classify.ts` into route + controller + use-case** during this scaffold. The existing monolithic route handler still works; the split is a follow-up for the hs-classification owner.
2. **Did not move test files** to mirror the new structure. Existing test paths (`tests/classification/...`, `tests/util/...`) keep working with updated imports. Test-tree reorganization is a follow-up.
3. **Did not extract route-registration into `server/register-routes.ts`**. Currently `server/app.ts` imports + registers routes inline. Extract when route count grows.
4. **Did not create `db/schema/index.ts` barrel** — kept `db/schema.ts` as the barrel (which already existed and re-exports from `schema/*`).

## Verification

- `pnpm typecheck` — passes after the move
- `pnpm test` — 211/211 passing after the move
- `pnpm dev` — boots; all existing endpoints (`/health`, `/ready`, `POST /classify`, `POST /classify/expand`, `GET /classification-trace/:id`, `POST /submission-description`) work unchanged
