# ClearAI backend — handover for a parallel agent

You're picking up backend / core-engine work on the ClearAI HS-classification
service. This document is your starting context. **Read it end to end before
touching code.**

## What ClearAI is

A TypeScript / Fastify / Postgres + pgvector service that classifies free-text
product descriptions into 12-digit ZATCA (Saudi customs) HS codes. The pipeline:

1. **Cleanup** (Haiku) — strips brand / SKU / marketing noise from raw merchant input
2. **Retrieval** — hybrid pgvector + BM25 + trigram, fused via RRF
3. **Understanding check** — chapter-coherence + noun-alignment over top-N
4. **Researcher** (Sonnet) — re-writes the input when retrieval doesn't understand;
   optionally with Anthropic web-search
5. **Evidence gate** — fail-closed on weak score / ambiguous / thin-input
6. **Picker** (Sonnet) — chooses among top-K candidates with rationale
7. **Branch-rank** (Sonnet) — optional rerank of all leaves under the picked HS-8
8. **Best-effort fallback** — if nothing accepted, returns 4-digit heading

Worst case: 3 LLM calls. Common path: 1.

## Repo layout (you're in /Users/asma/Desktop/Customs AI/clear_ai)

```
clearai-backend/
├── data/                     CSVs ingested into the DB (source-of-truth catalogs)
├── drizzle/                  SQL migrations (numbered, append-only)
│   ├── 0000-0017_*.sql       schema + backfills + seeds
│   └── meta/_journal.json    Drizzle journal — must list every migration
├── infra/                    Bicep + deploy.sh (Azure Container Apps + APIM)
├── src/
│   ├── catalog/              ZATCA reference data (duty-info, setup-meta, procedure-codes)
│   ├── classification/       Pipeline algorithms (gate, picker, branch-rank, resolve)
│   │   └── stages/           Per-stage extracted handlers (cleanup, best-effort)
│   ├── config/               Env loader
│   ├── db/                   Pool, schema definitions (Drizzle for types only)
│   ├── embeddings/           e5 multilingual via @xenova/transformers (ONNX, in-process)
│   ├── llm/                  Anthropic client + structured-call wrapper
│   ├── observability/        log-event.ts (writes classification_events row)
│   ├── preprocess/           merchant-cleanup, check-understanding, research(+web)
│   ├── retrieval/            digit-normalize, known-prefixes, retrieve (RRF)
│   ├── routes/               Fastify route files (one per HTTP endpoint)
│   ├── scripts/              CLI entrypoints (migrate, ingest, bench)
│   ├── server/               Fastify app + global error handler
│   ├── types/                domain.ts — single home for cross-cutting unions
│   └── util/                 lang detection, score rounding
└── tests/                    Mirror tree — tests/classification/foo.test.ts → src/classification/foo.ts
```

## Conventions you MUST follow

1. **TypeScript strict.** `noUncheckedIndexedAccess`, `noUnusedLocals`,
   `noUnusedParameters`. Run `pnpm typecheck` before committing.

2. **Append-only migrations.** Never edit a numbered SQL file once it's been
   applied (locally or in prod). Drizzle hashes them — editing breaks every
   environment that already ran the file. To change schema, add `0018_*`,
   `0019_*`, etc. Update `drizzle/meta/_journal.json` to register the new file.

3. **Test colocation by mirror tree.** Tests live in `tests/<domain>/<file>.test.ts`,
   not next to source. Imports inside tests use `../../src/<domain>/<file>.js`.
   `vitest.config.ts` includes only `tests/**/*.test.ts`.

4. **Domain types live in one place.** `src/types/domain.ts` exports every
   cross-cutting string-literal union (LangTag, DecisionStatus, MerchantCleanupKind,
   etc.). Origin files re-export from there. Don't define new union types in
   feature code without checking domain.ts first.

5. **Persisted enums stay stable across renames.** The `endpoint` column on
   `classification_events` writes `'describe' | 'expand'` even though the URLs
   are now `/classifications` and `/classifications/expand`. Internal observability,
   not an API contract. Don't change it without a backfill plan.

6. **Fail-closed setup_meta.** Every threshold the code references MUST exist
   in the `setup_meta` table. The loader in `src/catalog/setup-meta.ts` throws
   if any required key is missing or has the wrong `value_kind`. To add a new
   threshold: add the key to `Thresholds` interface, add a new migration that
   `INSERT … ON CONFLICT DO NOTHING` seeds the row.

7. **No editorialising in prod logs.** Console output is fine in scripts; route
   handlers use `req.log` (pino, structured). Errors get logged with structured
   context, not stringified blobs.

8. **Comments explain *why*, not *what*.** The codebase is heavily commented
   with rationale (ADR refs, failure modes that motivated the design). Match
   the existing tone — terse, concrete, no fluff. If a function exists because
   of a specific bug, the comment names the bug. See `evidence-gate.ts` for
   examples of the expected level.

9. **ADRs.** Architectural decisions are tracked in `clearai-backend/tracker/ARCHITECTURE_DECISIONS.md`.
   When you make a non-trivial decision, add an ADR or extend an existing one.
   Don't ship without one.

## API surface (current, post-2026-04-30 refactor)

All `/classifications/*` paths are subscription-key-required behind APIM.
`/health` is anonymous. `/ready` is private to Container Apps probes.

| Method | Path | What it does |
|---|---|---|
| POST | `/classifications` | Free-text → 12-digit HS code (full pipeline) |
| POST | `/classifications/expand` | Narrow a 4–10 digit prefix to a 12-digit leaf |
| GET | `/classifications/{id}` | Fetch a persisted classification + feedback rows |
| POST | `/classifications/{id}/submission-description` | Generate ZATCA-grade Arabic submission text (Haiku) |
| POST | `/classifications/{id}/feedback` | Record human feedback (confirm/reject/prefer_alternative) |
| GET | `/health` | Liveness probe |
| GET | `/ready` | Readiness probe (Container Apps gates traffic on this) |

**Don't add new routes lightly.** Each one is an APIM operation, a frontend
client method, and a piece of public surface area. Talk to the user first.

## How deploy works

1. Push to `main` on a path under `clearai-backend/**` → GitHub Actions builds
   a Docker image, tags `:latest` + `:sha-<7char>`, pushes to GHCR
2. Container Apps does NOT auto-pull. You trigger a new revision manually:
   ```bash
   az containerapp update \
     --name ca-infp-clearai-be-dev-gwc-01 \
     --resource-group rg-infp-clearai-common-dev-gwc-01 \
     --image ghcr.io/asmadaheripl/clearai-backend:latest \
     --revision-suffix "<short-name>-$(git rev-parse --short HEAD)"
   ```
3. The new revision boots. `migrate-and-start.ts` applies pending migrations
   atomically before the Fastify server starts. If migrations fail, the
   revision exits non-zero and Container Apps keeps the previous revision
   serving — failsafe by design.
4. Verify: `curl https://apim-infp-clearai-be-dev-gwc-01.azure-api.net/health`
5. APIM operations are deployed via `az rest PUT` for speed; see
   `infra/modules/apim.bicep` for the persisted definitions. **Always update
   Bicep when you change an APIM operation** so the next full `infra/deploy.sh`
   doesn't drop your changes.

Local dev:
```bash
cd clearai-backend
pnpm db:up         # docker compose Postgres
pnpm db:migrate    # apply pending Drizzle migrations
pnpm db:seed       # ingest ZATCA tariff codes (one-time)
pnpm db:seed:procedures  # ingest procedure-codes lookup (one-time)
pnpm dev           # tsx watch src/server/app.ts
```

Tests + typecheck:
```bash
pnpm test          # all 135 tests
pnpm typecheck     # strict TypeScript across src/ + tests/
```

## Recent work (last week's commits — context for what's stable)

```
c3ffd22  refactor(api): regroup HTTP surface under /classifications, drop /boost
979856d  fix(infra): register /trace operations on APIM gateway
1e0ed8a  feat(backend): seed procedure_codes inline so deploys self-bootstrap
07d8aa5  feat(backend): enrich /classify/describe with structured procedures-codes
14a6e3f  refactor(backend): regroup src/ by domain, mirror tests/ tree, consolidate enum types
0a62c75  fix(backend): thin-input gate, dash trimming, X4-style cleanup heuristic
```

The API just got renamed (commit `c3ffd22`). Frontend `lib/api.ts` will be
updated separately by the user. **Don't take that on** — it's a different
repo and different agent.

## What's safe to pick up

In rough order of value-per-effort:

### A. Wire procedures + duty into `/classifications/expand` response

Today only `/classifications` (the main classify route) ships `result.procedures`
and `result.duty`. The expand route hits a 12-digit leaf in its `after` block but
doesn't enrich. Easy parity fix: same `lookupProcedures()` + `parseDutyInfo()`
helpers, attach to `after`. Also omit when empty (frontend already handles
both shapes). About 30 mins. Files: `src/routes/expand.ts`, the `after` block
near line 245.

### B. Sourcing English text for procedure_codes

Today `procedure_codes.description_en` is null — we only have Arabic from the
official ZATCA guide. Brokers who don't read Arabic see nothing useful. Two
paths:

  1. **Manual translation pass** by the user (low scope, high quality)
  2. **One-time Haiku translation** at ingest time, gated behind a manual
     review of the output. Add `description_en text` (already present),
     write a script that reads the AR text and produces EN, store both,
     ship. Cost: 108 codes × ~50 tokens out × Haiku rate = trivial.

Don't ship machine translations without the user reviewing them — these are
regulatory texts.

### C. Backfill plan for old `endpoint='boost'` rows

Old `classification_events` rows have `endpoint='boost'`. The route is gone
but the data is fine. Decide: leave forever (cosmetic), or backfill to
something else (probably 'expand', since boost was structurally similar)?
Talk to the user before doing the backfill.

### D. ADR for the API surface refactor

Commit `c3ffd22` reshuffled the entire API. There's no ADR for it yet. Add
one to `clearai-backend/tracker/ARCHITECTURE_DECISIONS.md` covering: why
`/classifications/*`, why POST for submission-description, why /boost is
gone, why the persisted endpoint enum stays as 'describe'/'expand'. The
commit message has the substance — re-cast it as an ADR.

### E. setup_meta consolidation

Several thresholds got added piecemeal across migrations 0001 / 0003 / 0004 /
0007 / 0011 / 0014. Some are actively used, some may be stale. Audit:
which keys does the code currently read (`grep -rE "t\\.[A-Z_]+" src/`),
which keys exist in setup_meta (`SELECT key FROM setup_meta`), which are
orphans. Don't drop orphan keys without checking — they may be used by
not-yet-shipped features. Just produce the inventory.

### F. Health-check the test data

`tests/classification/broker-mapping.test.ts` hits the real DB (it imports
`closeDb` from `db/client.js`). That's fine for local dev but a CI without
a Postgres skips this test silently. If you set up CI, this test needs
either a Postgres service container or an explicit skip flag.

## What's currently in flight (do NOT touch unless you know the state)

- **Frontend `lib/api.ts`** — being updated by the user / another agent to
  match the new API paths. Don't push backend changes that break the new
  frontend contract until that's confirmed shipped.

- **The procedures-codes feature** is live in production (commit `1e0ed8a`).
  Frontend renders it on the result card. If you change `ProcedureInfo`
  shape, you break the frontend.

## Things you should NOT do without asking

1. **Don't add new endpoints.** API surface is locked at 7 endpoints. New
   functionality goes on existing routes (e.g. richer response fields) or
   needs an explicit user discussion first.

2. **Don't change response shapes silently.** `result.procedures`, `result.duty`,
   `result.code`, `decision_status`, `decision_reason` etc. are all consumed
   by the frontend. Adding new fields is fine; renaming or removing isn't.

3. **Don't touch `setup_meta` defaults at runtime.** Always via migration.
   The cache is process-lifetime; runtime mutations would silently desync
   replicas.

4. **Don't bypass the evidence gate** to "fix" a low-confidence case. If
   the gate is wrong, fix the gate (with a test). The gate's whole job is
   refusing to ship hallucinations on weak evidence.

5. **Don't add a 4th LLM call to the common path** without an ADR. The 1-call
   common path is a hard latency budget.

## Questions to ask the user before substantive work

- "Which of A-F should I take?" (reference the section letters above)
- "Is the frontend update done?" (gates anything that touches the API contract)
- "Are there outstanding production issues I should know about?"
- "Do you want this as one commit or split?"

## Files you'll touch most often

- Routes: `src/routes/classify.ts` (the main pipeline orchestrator), `src/routes/expand.ts`
- Pipeline: `src/classification/{evidence-gate,llm-pick,resolve,branch-rank}.ts`
- Persistence: `src/observability/log-event.ts`, `src/db/schemas/*.ts`
- Setup: `src/catalog/setup-meta.ts`, `src/scripts/migrate-and-start.ts`

## Final check before any commit

```bash
pnpm typecheck && pnpm test && git diff --stat
```

Read the diff. Make sure you understand every line. Then commit with a
message that explains the *why*, not just the *what*.

---

Good luck. The code is well-commented; lean on the existing comments before
guessing. If something looks wrong, it probably has a reason — read the
nearby comment, the ADR, or the test before "fixing" it.
