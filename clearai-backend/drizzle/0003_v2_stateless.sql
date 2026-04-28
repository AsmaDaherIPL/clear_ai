-- ============================================================================
-- 0003_v2_stateless.sql
--
-- v2 stateless control flow + best-effort fallback (ADR-0011).
--
-- 1. Seed new setup_meta rows so loadThresholds() (fail-closed per ADR-0009)
--    doesn't throw on startup. These rows make every previously hard-coded
--    constant (top-K retrieval, picker candidate count, alternatives shown,
--    researcher token cap, best-effort feature flag, best-effort max digit
--    specificity) tunable from the DB.
--
-- 2. Extend events_decision_status_chk to allow 'best_effort' — a third-class
--    status that is *neither* accepted nor needs_clarification. The frontend
--    must visually gate it (verify-toggle) so users don't mistake it for an
--    accepted code.
--
-- 3. Extend events_decision_reason_chk to allow:
--      - 'brand_not_recognised'  — researcher saw the input and declined.
--      - 'best_effort_heading'   — fallback returned a 4-digit chapter heading
--                                   with confidence_band='low'.
--
-- Booleans are stored as 0/1 numbers because setup_meta_value_kind_chk only
-- permits ('number', 'string'). See setup-meta.ts for the helper convention.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Seed new setup_meta rows. ON CONFLICT DO NOTHING so re-running the
--    migration is safe and operator overrides via UPDATE are preserved.
-- ---------------------------------------------------------------------------
INSERT INTO setup_meta (key, value, description) VALUES
  ('UNDERSTOOD_TOP_K_describe',     '5',   'Window size (top-N retrieval candidates) inspected by the chapter-coherence understanding check on /classify/describe'),
  ('RETRIEVAL_TOP_K_describe',      '12',  'Number of candidates pulled from pgvector + lexical RRF for /classify/describe'),
  ('PICKER_CANDIDATES_describe',    '8',   'Number of candidates fed to the LLM picker for /classify/describe'),
  ('ALTERNATIVES_SHOWN_describe',   '5',   'Number of alternatives surfaced to the user for /classify/describe'),
  ('RESEARCHER_MAX_TOKENS',         '250', 'Token cap on the Sonnet researcher (JSON output, not prose)'),
  ('BEST_EFFORT_MAX_TOKENS',        '200', 'Token cap on the best-effort fallback LLM call'),
  ('BEST_EFFORT_ENABLED',           '1',   'Feature flag: 0 = disabled (route returns needs_clarification on hard cases); 1 = enabled (route attempts a 4-digit best-effort heading with confidence_band=low). Boolean encoded as 0/1 because setup_meta only allows number|string'),
  ('BEST_EFFORT_MAX_DIGITS',        '4',   'Maximum specificity (digit count) for best-effort fallback codes. Must be one of {2, 4, 6, 8, 10}. Default 4 — chapter-heading granularity, the least-harmful fallback')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint

-- Backfill value_numeric / value_kind for the new rows (mirrors 0002_hardening's
-- pattern). Existing rows are left untouched if an operator already set them.
UPDATE setup_meta
   SET value_numeric = (value)::double precision,
       value_kind    = 'number'
 WHERE key IN (
    'UNDERSTOOD_TOP_K_describe',
    'RETRIEVAL_TOP_K_describe',
    'PICKER_CANDIDATES_describe',
    'ALTERNATIVES_SHOWN_describe',
    'RESEARCHER_MAX_TOKENS',
    'BEST_EFFORT_MAX_TOKENS',
    'BEST_EFFORT_ENABLED',
    'BEST_EFFORT_MAX_DIGITS'
   )
   AND value_numeric IS NULL;
--> statement-breakpoint

-- Defensive: BEST_EFFORT_MAX_DIGITS must be one of the canonical HS levels.
-- The TS loader also enforces this, but a DB-level CHECK catches direct UPDATEs
-- that bypass the application.
ALTER TABLE setup_meta
  DROP CONSTRAINT IF EXISTS setup_meta_best_effort_max_digits_chk;
--> statement-breakpoint

ALTER TABLE setup_meta
  ADD CONSTRAINT setup_meta_best_effort_max_digits_chk
    CHECK (
      key <> 'BEST_EFFORT_MAX_DIGITS'
      OR value_numeric IN (2, 4, 6, 8, 10)
    );
--> statement-breakpoint

-- BEST_EFFORT_ENABLED must be 0 or 1 (boolean-as-number convention).
ALTER TABLE setup_meta
  DROP CONSTRAINT IF EXISTS setup_meta_best_effort_enabled_chk;
--> statement-breakpoint

ALTER TABLE setup_meta
  ADD CONSTRAINT setup_meta_best_effort_enabled_chk
    CHECK (
      key <> 'BEST_EFFORT_ENABLED'
      OR value_numeric IN (0, 1)
    );
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2 + 3. Re-issue the closed-enum CHECKs on classification_events to add the
--        new status + reasons. Drop-then-add (rather than ALTER) because
--        Postgres doesn't support in-place CHECK modification.
-- ---------------------------------------------------------------------------
ALTER TABLE classification_events
  DROP CONSTRAINT IF EXISTS events_decision_status_chk,
  DROP CONSTRAINT IF EXISTS events_decision_reason_chk;
--> statement-breakpoint

ALTER TABLE classification_events
  ADD CONSTRAINT events_decision_status_chk
    CHECK (decision_status IN (
      'accepted',
      'needs_clarification',
      'degraded',
      'best_effort'
    )),
  ADD CONSTRAINT events_decision_reason_chk
    CHECK (decision_reason IN (
      'strong_match',
      'single_valid_descendant',
      'already_most_specific',
      'weak_retrieval',
      'ambiguous_top_candidates',
      'invalid_prefix',
      'guard_tripped',
      'llm_unavailable',
      'brand_not_recognised',
      'best_effort_heading'
    ));
--> statement-breakpoint
