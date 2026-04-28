-- ============================================================================
-- 0008_branch_rank.sql
--
-- Phase 3 of the v3 alternatives redesign: Sonnet reranks the enumerated
-- branch leaves with per-row reasoning, optionally overriding the picker's
-- chosen code. Feature-flagged off by default — see ADR-0014 and
-- src/decision/branch-rank.ts for the full rationale.
--
-- Two new tunables, idempotent INSERT.
-- ============================================================================

INSERT INTO setup_meta (key, value, description) VALUES
  ('BRANCH_RANK_ENABLED',     '0',   'Feature flag: 1 = run Sonnet rerank of the branch leaves with per-row reasoning; 0 = skip (the picker''s pick stands and alternatives come back unranked from branch enumeration). Default 0 — flip to 1 after measuring quality. Adds ~3-5s wall-clock to the accepted path when enabled. Boolean encoded as 0/1.'),
  ('BRANCH_RANK_MAX_TOKENS',  '800', 'Cap on tokens the branch-rank LLM may emit. Per-row reasoning adds up — 800 is comfortable for an HS-8 branch with up to ~15 leaves at ~30 words each. Increase if BRANCH_PREFIX_LENGTH is flipped to HS-6 (denser branches).')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint

UPDATE setup_meta
   SET value_numeric = (value)::double precision,
       value_kind    = 'number'
 WHERE key IN ('BRANCH_RANK_ENABLED', 'BRANCH_RANK_MAX_TOKENS')
   AND value_numeric IS NULL;
--> statement-breakpoint

-- BRANCH_RANK_ENABLED must be 0 or 1 (boolean-as-number convention).
ALTER TABLE setup_meta
  DROP CONSTRAINT IF EXISTS setup_meta_branch_rank_enabled_chk;
--> statement-breakpoint

ALTER TABLE setup_meta
  ADD CONSTRAINT setup_meta_branch_rank_enabled_chk
    CHECK (
      key <> 'BRANCH_RANK_ENABLED'
      OR value_numeric IN (0, 1)
    );
--> statement-breakpoint
