# ClearAI Backend (v1)

ZATCA-bound, batch-oriented HS classification. TypeScript + Fastify v5 + Drizzle + Postgres 16 + pgvector + Transformers.js + Anthropic via Azure AI Foundry.

> Architecture, decisions, and rationale are tracked in [`tracker/V1_PLAN.md`](tracker/V1_PLAN.md), [`tracker/ARCHITECTURE_DECISIONS.md`](tracker/ARCHITECTURE_DECISIONS.md), and [`tracker/LESSONS_LEARNED.md`](tracker/LESSONS_LEARNED.md). Test inventory in [`tracker/TEST_CASES.md`](tracker/TEST_CASES.md).

## What it does

Three endpoints, all returning the **shared decision contract** envelope (status-driven; no uncalibrated confidence numbers):

| Endpoint | Purpose | LLM model |
|---|---|---|
| `POST /classify/describe` | Free-text → 12-digit ZATCA code | Claude Sonnet (Foundry) |
| `POST /classify/expand`   | Declared HS prefix + free-text → 12-digit leaf under that prefix | Claude Haiku (Foundry) |
| `POST /boost`             | Declared 12-digit code → most-specific sibling under same `parent10` | (none — mechanical) |

Every response carries `decision_status ∈ {accepted, needs_clarification, degraded}` plus a closed-enum `decision_reason` (e.g. `strong_match`, `weak_retrieval`, `guard_tripped`). Optional `confidence_band` will be populated post-launch from eval-set calibration.

## Pre-requisites

- **Node 22+** (we use ES2022 targets, ESM)
- **pnpm 10+** (`brew install pnpm`)
- **Docker** (Postgres 16 + pgvector ships in `pgvector/pgvector:pg16`)
- **Azure AI Foundry** keys for Claude Sonnet + Haiku deployments — Target URI + key go in `.env` (see `.env.example`)

## Quick start (local dev)

```bash
# 1. Install deps and start Postgres
pnpm install
pnpm db:up                 # spins up pgvector/pg16 on localhost:5432

# 2. Apply schema + extensions + seed thresholds
pnpm db:migrate

# 3. Ingest the ZATCA tariff Excel into hs_codes (~5-10 min, embeds 19k rows)
pnpm db:seed

# 4. Copy env + drop in your Foundry creds
cp .env.example .env
# edit .env: ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL (full Target URI), LLM_MODEL

# 5. Run
pnpm dev                   # Fastify on :3000
```

Smoke test:

```bash
curl -s localhost:3000/health
# {"status":"ok","db":true}

curl -s -XPOST localhost:3000/classify/describe \
  -H 'content-type: application/json' \
  -d '{"description":"cotton t-shirt for men"}' | jq
```

## Project layout

```
src/
  config/env.ts          Zod-validated env loader
  db/                    Drizzle schema + pg client
  embeddings/            Multilingual e5-small via @xenova/transformers
  retrieval/             Hybrid retrieval (pgvector + BM25 + pg_trgm + RRF)
                         + digit normalization + known-prefix cache
  decision/              Evidence Gate, LLM picker, hallucination guard,
                         decision resolution, classification_events logger
  llm/                   Foundry adapter (direct fetch to Target URI)
  routes/                /classify/describe, /classify/expand, /boost
  scripts/               migrate.ts, ingest.ts
  util/                  language detection
prompts/
  gir-system.md          Distilled WCO General Interpretation Rules
                         (~400 tokens; injected into every /describe & /expand)
  picker-describe.md     /describe picker contract
  picker-expand.md       /expand picker contract
drizzle/                 0000_*.sql (tables + extensions), 0001_*.sql (indexes, triggers,
                         seed thresholds), 0002_*.sql (CHECK constraints + typed setup_meta);
                         meta/_journal.json registers them with Drizzle's migrator (ADR-0010)
tracker/                 V1 plan + ADRs + lessons + test cases
docker-compose.yml       Postgres 16 + pgvector
```

## Architectural primitives (load-bearing rules)

1. **LLM never rescues weak retrieval.** Every endpoint runs an Evidence Gate against `top_retrieval_score` and `top2_gap` before any LLM call. Gate fails → `needs_clarification` with no LLM cost. (ADR-0002)
2. **Status-driven decisions, no uncalibrated confidence numbers.** Closed-enum `decision_status` + `decision_reason`. (ADR-0001)
3. **Hallucination guard is hard.** If the LLM returns a code not in the candidate set, we force `needs_clarification` with reason `guard_tripped`. We never silently substitute. (ADR-0001)
4. **GIRs are injected as a distilled system prompt** (~400 tokens) for `/describe` and `/expand`. Not for `/boost`. (ADR-0007)
5. **Digit normalization, not endpoint routing.** Free-text digit runs are stripped/biased deterministically per length. No silent routing surprises in batch. (ADR-0003)
6. **Hierarchy derived from 12-digit prefix.** Excel is the sole source of truth. (ADR-0005)
7. **Foundry via direct `fetch`, not SDK baseURL.** `ANTHROPIC_BASE_URL` is the full Target URI including `/v1/messages`. (ADR-0006)
8. **Migrations run through Drizzle's built-in `migrate()`,** not a custom runner. Hand-authored SQL files (extensions, triggers, CHECK constraints) are registered in `drizzle/meta/_journal.json` and tracked by hash in `drizzle.__drizzle_migrations`. Editing an applied file changes its hash and the migrator refuses to proceed — always add a new migration. (ADR-0010)
9. **HS4 heading rows are dropped at ingest;** every `hs_codes` row is a 12-digit leaf, enforced by DB CHECK constraints. (ADR-0008)
10. **`setup_meta` loader is fail-closed.** Numeric tunables come from a typed `value_numeric` column; a missing or malformed key throws at startup. No silent defaults. (ADR-0009)

## Configuration

All env vars validated by Zod at startup. See `src/config/env.ts`.

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `ANTHROPIC_API_KEY` | Foundry deployment key |
| `ANTHROPIC_BASE_URL` | **Full** Foundry Target URI (includes `/v1/messages`) |
| `LLM_MODEL` | Default deployment name (Haiku) |
| `LLM_MODEL_STRONG` | Stronger deployment name (Sonnet) used by `/describe` |
| `LLM_TIMEOUT_MS` | Per-call timeout (default 15000) |
| `EMBEDDER_MODEL` | Default `Xenova/multilingual-e5-small` |
| `EMBEDDER_DIM` | Default 384 |

## Tunable thresholds (Evidence Gate, RRF, Boost margin)

Stored in the `setup_meta` table. Initial placeholders are written by migration `0001`. Tune via the eval set per `tracker/V1_PLAN.md` §A.9.

| Key | Default | Used by |
|---|---|---|
| `MIN_SCORE_describe` / `MIN_GAP_describe` | 0.30 / 0.04 | `/classify/describe` Evidence Gate |
| `MIN_SCORE_expand`   / `MIN_GAP_expand`   | 0.20 / 0.03 | `/classify/expand` Evidence Gate |
| `MIN_SCORE_boost`    / `MIN_GAP_boost`    | 0.20 / 0.03 | `/boost` (currently informational) |
| `BOOST_MARGIN`       | 0.05 | `/boost` short-circuit threshold |
| `RRF_K`              | 60 | RRF fusion constant |

## Tests

Unit tests cover the deterministic primitives (digit normalization, Evidence Gate, decision resolution, language detection). Endpoint integration tests rely on a running Postgres + ingested data.

```bash
pnpm test
```

## Deployment

Phase 2 — not in this repo's current scope. The deploy target is **Azure Container App** + **Azure Database for PostgreSQL Flexible Server**, both in resource group `rg-infp-clearai-dev-gwc-01`. The schema migrations and code in this repo are environment-agnostic; only `DATABASE_URL` and Foundry creds change.

## License

Proprietary, internal.
