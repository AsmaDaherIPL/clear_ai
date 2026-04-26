# Lessons Learned — ClearAI v1

A running log of mistakes, surprises, and reversals during the build. Append-only. The point is to capture **what we got wrong and what corrected it** so we don't re-run the same loop later.

Format per entry:

```
## YYYY-MM-DD — short title
- What we initially thought / did
- Why it was wrong
- What we changed
- Cost (time, tokens, code, decisions reversed)
```

---

## 2026-04-26 — Confidence numbers were the wrong primitive

- **Initially:** API responses returned a numeric `confidence` field. Drafts even proposed a per-alternative `llm_confidence`.
- **Wrong because:** the number conflated three orthogonal signals (retrieval strength, LLM self-report, operational state); LLM self-reported confidence is uncalibrated by definition; batch consumers had no defensible threshold to apply.
- **Changed to:** status-driven contract — `decision_status` (closed enum) + `decision_reason` (closed enum) + optional **calibrated** `confidence_band` (high/medium/low) populated only from eval data.
- **Cost:** rewrote V1_PLAN end-to-end, reshaped `classification_events` schema, removed all numeric-confidence references in API design. ~1 day of plan-document rework before any code was written.

---

## 2026-04-26 — Hint logic and silent endpoint routing don't fit batch

- **Initially:** considered emitting a hint to the caller when a digit run was detected in `/describe`, or silently routing to `/expand`/`/boost`.
- **Wrong because:** the consumer is a batch ZATCA XML pipeline. There is no human to read a hint, and silent routing breaks reproducibility (same input → different endpoint → different log shape).
- **Changed to:** deterministic digit normalization. Strip / soft-bias / TBD per length. Same endpoint, same response shape. (See ADR-0003.)
- **Cost:** small — caught before implementation.

---

## 2026-04-26 — Foundry Target URI is the full path, including /v1/messages

- **Initially:** treated `ANTHROPIC_BASE_URL` as a base, expected the SDK to append `/v1/messages`.
- **Wrong because:** Foundry's Anthropic-compatible deployment exposes the **full path** as the Target URI. The SDK would have hit `/v1/messages/v1/messages` and 404'd.
- **Changed to:** direct `fetch` POST to the Target URI; bypass SDK URL handling. (ADR-0006.)
- **Cost:** would have been an hour of debugging on first call had we not caught it from the Foundry screenshot.

---

## 2026-04-26 — Excel only has HS4 + HS12, no intermediate levels

- **Initially:** assumed `Zatca Tariff codes.xlsx` contained the full hierarchy (HS6/8/10/12).
- **Wrong because:** inspection showed 33 HS4 rows + 19 105 HS12 rows, no intermediates.
- **Changed to:** derive `chapter/heading/hs6/hs8/hs10/parent10` from the 12-digit prefix at ingestion. Excel stays the single source of truth. (ADR-0005.)
- **Cost:** none — caught at first inspection. Saved us from importing a fictitious "hierarchy file."

---

## 2026-04-26 — API key landed in chat history before .gitignore was in place

- **Initially:** user shared `foundryllm.env` path before the project was scaffolded.
- **Wrong because:** the value travelled through chat. Even though `.gitignore` excludes the file from git, the secret has already been seen by the assistant runtime.
- **Changed to:** explicit ask to **rotate the Foundry API key** once end-to-end is verified. `.gitignore` now excludes `foundryllm.env`, `.env`, and `.env.*` (except `.env.example`).
- **Cost:** one rotation. Process lesson: secrets pattern for future MCP tools and shared-state edits — never paste, always reference by path + use a secret-loading pattern.

---

## 2026-04-26 — Silent fallbacks and silent ON CONFLICT both hide real bugs

- **Initially:** two convenience patterns landed during scaffolding:
  1. `loadThresholds()` substituted hard-coded defaults when a `setup_meta` row was missing or non-numeric.
  2. `ingest.ts` padded HS4 codes to 12 digits and used `ON CONFLICT (code) DO NOTHING` to absorb the resulting collisions with real HS12 leaves.
- **Wrong because:** both behaviours **hide configuration drift and data loss in a batch pipeline with no human in the loop.** A typo in a threshold key would let the Evidence Gate run with stale assumptions; the HS4 padding silently dropped one of every collision pair and could even shadow a real leaf row. In each case, the fast-path "make it work" instinct produced a primitive that fails opaquely.
- **Changed to:**
  - Fail-closed threshold loader (ADR-0009): typed `value_numeric` column + `value_kind` CHECK + loader throws on missing/malformed.
  - Drop HS4 rows entirely at ingest (ADR-0008); no padding, no `ON CONFLICT`. DB-level CHECK constraints (`raw_length=12`, `is_leaf=true`, prefix-substring equalities) lock the invariant.
  - Closed-enum CHECK constraints on `classification_events` (endpoint, decision_status, decision_reason, confidence_band, llm_status, language_detected) so a TS typo can't land an invalid log row.
  - `setup_meta` `BEFORE UPDATE` trigger so config edits are always traceable (the previous `DEFAULT now()` only fired on INSERT).
- **Cost:** one extra migration (`0002_hardening.sql`), a loader rewrite, an ingest rewrite, two ADRs. Caught in code review before it ever shipped.
- **Pattern to keep:** for any batch-pipeline primitive — never silently substitute, never silently absorb. Fail loud, log structured, push invariants into the database where the type system can't reach.

---

## 2026-04-26 — Reinventing the migrator was a self-inflicted wound

- **Initially:** wrote a custom raw-SQL migrator in `src/scripts/migrate.ts` (~70 lines: filename ledger in `_migrations`, manual statement-breakpoint splitting, transaction-per-file). Justified at the time as "explicit control over extensions and triggers."
- **Wrong because:** Drizzle's built-in node-postgres migrator already runs raw `*.sql` files unchanged (extensions/triggers included), already handles `--> statement-breakpoint`, already wraps each migration in a transaction, and tracks **content hashes** rather than filenames — so it detects drift from edited applied files. We were duplicating library functionality and getting strictly less safety in return.
- **Changed to:** ADR-0010. Ten-line wrapper around `migrate()` from `drizzle-orm/node-postgres/migrator`. Hand-authored SQL files unchanged. Backfilled `drizzle.__drizzle_migrations` with hashes of the three existing files; dropped legacy `_migrations` table.
- **Cost:** ~30 minutes to swap the runner, write the journal, hash and seed the ledger, verify migrate/test/smoke. Could have been zero if I'd reached for the library on day one.
- **Rule reinforced (project-wide):** **never write custom code instead of available/known existing code or library.** If a library ships the primitive, use it — and understand its edges before assuming you need to replace it. The instinct to "just write a small one" was wrong here, and would be wrong elsewhere.

---

<!-- New entries append below. Append-only. -->
