-- ============================================================================
-- 0035_observability_columns_and_cleanup_rename.sql
--
-- Combined migration — two unrelated changes amortising the migration cost
-- (single rebuild, single Drizzle journal entry, single network round trip):
--
--   A. Observability columns on classification_events (chapter_hint,
--      cleanup_noun_grounded, retrieval_stage1_count). Lets the trace
--      page render the new-pipeline signals via typed columns instead of
--      fishing them out of the request jsonb on every read.
--
--   B. setup_meta key rename: MERCHANT_CLEANUP_* → DESCRIPTION_CLEANUP_*.
--      Aligns with the description-cleanup module rename from
--      new-pipeline commit #1 (b88444f). Kept the keys' original names
--      until now to avoid migration churn during the pipeline rollout.
-- ============================================================================

-- ─── A. classification_events observability columns ─────────────────────────
--
-- All three are NULLable. Existing rows can't be backfilled (the signals
-- weren't captured at insert time). New writes from log-event.ts will
-- populate them. Frontend should treat NULL as "wasn't recorded for this
-- event" — same shape as the existing branch_size column.

ALTER TABLE classification_events
  ADD COLUMN chapter_hint              jsonb,
  ADD COLUMN cleanup_noun_grounded     boolean,
  ADD COLUMN retrieval_stage1_count    integer;
--> statement-breakpoint

-- chapter_hint shape stored as jsonb (LLM output) for forward flexibility:
--   { "likely_chapters": ["64"], "confidence": 0.95, "rationale": "..." }
-- A GIN index would help if we ever want to filter "show all events that
-- predicted chapter 64" — defer adding it until that query pattern shows up.

-- cleanup_noun_grounded boolean — NULL when cleanup didn't run (e.g.
-- skipped_clean fast path doesn't set the field). true/false otherwise.

-- retrieval_stage1_count: raw count of candidates the vector recall
-- arm pulled (before BM25/trigram rerank shaved them). Useful for
-- diagnosing "high heels" → 0 candidates vs 0 in chapter 64 vs 0 anywhere.

-- ─── B. MERCHANT_CLEANUP_* → DESCRIPTION_CLEANUP_* setup_meta rename ───────
--
-- UPDATE-then-CHECK pattern (mirrors 0025's BROKER_MAPPING_ENABLED rename).
-- Values preserved across the rename — environments with cleanup disabled
-- stay disabled.

UPDATE setup_meta
   SET key = 'DESCRIPTION_CLEANUP_ENABLED',
       description = 'Feature flag: 1 = run the description-cleanup pre-step (Haiku strips brand/SKU/marketing on noisy inputs, applies typo corrections, flags merchant_shorthand for Researcher routing); 0 = bypass entirely, raw input goes straight to retrieval. Boolean encoded as 0/1.'
 WHERE key = 'MERCHANT_CLEANUP_ENABLED';
--> statement-breakpoint

UPDATE setup_meta
   SET key = 'DESCRIPTION_CLEANUP_MAX_TOKENS',
       description = 'Cap on tokens the description-cleanup LLM may emit. The cleanup output is structured JSON, not prose — 200 is comfortable headroom for even pathological inputs with long stripped-token lists.'
 WHERE key = 'MERCHANT_CLEANUP_MAX_TOKENS';
--> statement-breakpoint

-- Swap the CHECK constraint to gate the renamed key (was added in
-- 0007_merchant_cleanup.sql under the old name).
ALTER TABLE setup_meta
  DROP CONSTRAINT IF EXISTS setup_meta_merchant_cleanup_enabled_chk;
--> statement-breakpoint

ALTER TABLE setup_meta
  ADD CONSTRAINT setup_meta_description_cleanup_enabled_chk
    CHECK (
      key <> 'DESCRIPTION_CLEANUP_ENABLED'
      OR value_numeric IN (0, 1)
    );
--> statement-breakpoint
