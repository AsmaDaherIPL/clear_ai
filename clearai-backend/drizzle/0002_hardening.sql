-- 0002_hardening.sql
--
-- Pushes load-bearing invariants from TypeScript comments into Postgres-enforced
-- CHECK constraints and adds typed value columns + an updated_at trigger to
-- setup_meta. See ADR-0008 (HS4 dropped from hs_codes) and ADR-0009 (typed
-- setup_meta + fail-closed loader).
--
-- Idempotent: every constraint/column/trigger is wrapped in IF NOT EXISTS or
-- DROP IF EXISTS so re-runs are no-ops.

-- ============================================================================
-- hs_codes: enforce 12-digit invariants in the database, not just TS.
-- Pre-condition: ingest now drops HS4 rows (ADR-0008), so raw_length is always 12.
-- ============================================================================

-- Remove any pre-ADR-0008 HS4 padded rows that would violate the new constraints.
DELETE FROM hs_codes WHERE raw_length <> 12 OR code !~ '^[0-9]{12}$';
--> statement-breakpoint

ALTER TABLE hs_codes
  DROP CONSTRAINT IF EXISTS hs_codes_code_format_chk,
  DROP CONSTRAINT IF EXISTS hs_codes_raw_length_chk,
  DROP CONSTRAINT IF EXISTS hs_codes_leaf_chk,
  DROP CONSTRAINT IF EXISTS hs_codes_chapter_prefix_chk,
  DROP CONSTRAINT IF EXISTS hs_codes_heading_prefix_chk,
  DROP CONSTRAINT IF EXISTS hs_codes_hs6_prefix_chk,
  DROP CONSTRAINT IF EXISTS hs_codes_hs8_prefix_chk,
  DROP CONSTRAINT IF EXISTS hs_codes_hs10_prefix_chk,
  DROP CONSTRAINT IF EXISTS hs_codes_parent10_chk;
--> statement-breakpoint

ALTER TABLE hs_codes
  ADD CONSTRAINT hs_codes_code_format_chk      CHECK (code ~ '^[0-9]{12}$'),
  ADD CONSTRAINT hs_codes_raw_length_chk       CHECK (raw_length = 12),
  ADD CONSTRAINT hs_codes_leaf_chk             CHECK (is_leaf = true),
  ADD CONSTRAINT hs_codes_chapter_prefix_chk   CHECK (chapter  = substring(code, 1, 2)),
  ADD CONSTRAINT hs_codes_heading_prefix_chk   CHECK (heading  = substring(code, 1, 4)),
  ADD CONSTRAINT hs_codes_hs6_prefix_chk       CHECK (hs6      = substring(code, 1, 6)),
  ADD CONSTRAINT hs_codes_hs8_prefix_chk       CHECK (hs8      = substring(code, 1, 8)),
  ADD CONSTRAINT hs_codes_hs10_prefix_chk      CHECK (hs10     = substring(code, 1, 10)),
  ADD CONSTRAINT hs_codes_parent10_chk         CHECK (parent10 = substring(code, 1, 10));
--> statement-breakpoint

-- ============================================================================
-- classification_events: lock closed-enum columns to the values declared in
-- src/decision/types.ts. Mirrors must be kept in sync; if you add a value in
-- TS, write a new migration that ALTERs the CHECK.
-- ============================================================================

ALTER TABLE classification_events
  DROP CONSTRAINT IF EXISTS events_endpoint_chk,
  DROP CONSTRAINT IF EXISTS events_decision_status_chk,
  DROP CONSTRAINT IF EXISTS events_decision_reason_chk,
  DROP CONSTRAINT IF EXISTS events_confidence_band_chk,
  DROP CONSTRAINT IF EXISTS events_llm_status_chk,
  DROP CONSTRAINT IF EXISTS events_language_chk;
--> statement-breakpoint

ALTER TABLE classification_events
  ADD CONSTRAINT events_endpoint_chk
    CHECK (endpoint IN ('describe', 'expand', 'boost')),
  ADD CONSTRAINT events_decision_status_chk
    CHECK (decision_status IN ('accepted', 'needs_clarification', 'degraded')),
  ADD CONSTRAINT events_decision_reason_chk
    CHECK (decision_reason IN (
      'strong_match',
      'single_valid_descendant',
      'already_most_specific',
      'weak_retrieval',
      'ambiguous_top_candidates',
      'invalid_prefix',
      'guard_tripped',
      'llm_unavailable'
    )),
  ADD CONSTRAINT events_confidence_band_chk
    CHECK (confidence_band IS NULL OR confidence_band IN ('high', 'medium', 'low')),
  ADD CONSTRAINT events_llm_status_chk
    CHECK (llm_status IS NULL OR llm_status IN ('ok', 'error', 'timeout')),
  ADD CONSTRAINT events_language_chk
    CHECK (language_detected IS NULL OR language_detected IN ('en', 'ar', 'mixed', 'unk'));
--> statement-breakpoint

-- ============================================================================
-- setup_meta: typed value columns + auto-updated_at trigger (ADR-0009).
-- ============================================================================

ALTER TABLE setup_meta
  ADD COLUMN IF NOT EXISTS value_numeric double precision,
  ADD COLUMN IF NOT EXISTS value_kind   varchar(16) NOT NULL DEFAULT 'string';
--> statement-breakpoint

ALTER TABLE setup_meta
  DROP CONSTRAINT IF EXISTS setup_meta_value_kind_chk,
  DROP CONSTRAINT IF EXISTS setup_meta_value_numeric_consistency_chk;
--> statement-breakpoint

ALTER TABLE setup_meta
  ADD CONSTRAINT setup_meta_value_kind_chk
    CHECK (value_kind IN ('number', 'string')),
  ADD CONSTRAINT setup_meta_value_numeric_consistency_chk
    CHECK (
      (value_kind = 'number' AND value_numeric IS NOT NULL) OR
      (value_kind = 'string' AND value_numeric IS NULL)
    );
--> statement-breakpoint

-- Backfill the seeded numeric tunables from 0001 into the typed column.
UPDATE setup_meta
   SET value_numeric = value::double precision,
       value_kind    = 'number'
 WHERE key IN (
    'MIN_SCORE_describe', 'MIN_GAP_describe',
    'MIN_SCORE_expand',   'MIN_GAP_expand',
    'MIN_SCORE_boost',    'MIN_GAP_boost',
    'BOOST_MARGIN',       'RRF_K',
    'UNDERSTOOD_MAX_DISTINCT_CHAPTERS'
 )
   AND value_kind = 'string';
--> statement-breakpoint

-- BEFORE UPDATE trigger: bump updated_at on every change so config edits are
-- always traceable (the previous DEFAULT now() only fired on INSERT).
CREATE OR REPLACE FUNCTION setup_meta_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS setup_meta_touch_updated_at_trg ON setup_meta;
--> statement-breakpoint

CREATE TRIGGER setup_meta_touch_updated_at_trg
  BEFORE UPDATE ON setup_meta
  FOR EACH ROW EXECUTE FUNCTION setup_meta_touch_updated_at();
