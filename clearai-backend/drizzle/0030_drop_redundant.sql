-- ============================================================================
-- 0030_drop_redundant.sql
--
-- Drops single-source-of-truth violators identified during ADR-0025 review:
--
--   1. hs_codes.parent10  — bit-for-bit identical to hs_codes.hs10 (verified
--      against live data: 0 rows differ). Pure duplication.
--
--   2. hs_codes.hs8 / hs_codes.hs10 — only ever read by digit-normalize
--      via loadKnownPrefixes(), which now derives both sets in TS from
--      `code` (commit-5 rewrite). Columns are dead.
--
--   3. hs_code_display.is_declarable — was always `true` for every row;
--      "replaces is_leaf" but is_leaf was also always true. If we ever
--      need to flag heading-padded rows as not-declarable we can derive
--      it from `code LIKE '%00000000'` at read time.
--
--   4. hs_code_display.is_generic_label — pure function of label_en
--      ("Other") and label_ar ("غيرها"); derive at read time, no need to
--      store. Eliminates a sync hazard if labels ever change.
--
--   5. hs_code_search.is_deleted + hs_codes_propagate_deletion trigger —
--      was a denormalised mirror of hs_codes.is_deleted with a sync
--      trigger. Source-of-truth violation. Retrieval queries already JOIN
--      hs_codes via PK so we just filter `WHERE h.is_deleted = false` on
--      the existing JOIN. Microseconds difference, zero sync risk.
-- ============================================================================

-- 1–2. Drop hs_codes redundant prefix columns + their indexes.
DROP INDEX IF EXISTS hs_codes_parent10_idx;
--> statement-breakpoint
DROP INDEX IF EXISTS hs_codes_hs8_idx;
--> statement-breakpoint
DROP INDEX IF EXISTS hs_codes_hs10_idx;
--> statement-breakpoint

ALTER TABLE hs_codes
  DROP COLUMN IF EXISTS parent10,
  DROP COLUMN IF EXISTS hs8,
  DROP COLUMN IF EXISTS hs10;
--> statement-breakpoint

-- 3–4. Drop hs_code_display flag columns + the generic-label index.
DROP INDEX IF EXISTS hs_code_display_generic_idx;
--> statement-breakpoint
DROP INDEX IF EXISTS hs_code_display_declarable_idx;
--> statement-breakpoint

ALTER TABLE hs_code_display
  DROP COLUMN IF EXISTS is_declarable,
  DROP COLUMN IF EXISTS is_generic_label;
--> statement-breakpoint

-- 5. Drop hs_code_search.is_deleted + the propagation trigger.
DROP TRIGGER IF EXISTS hs_codes_propagate_deletion_trigger ON hs_codes;
--> statement-breakpoint
DROP FUNCTION IF EXISTS hs_codes_propagate_deletion();
--> statement-breakpoint

DROP INDEX IF EXISTS hs_code_search_active_idx;
--> statement-breakpoint

ALTER TABLE hs_code_search
  DROP COLUMN IF EXISTS is_deleted;
--> statement-breakpoint
