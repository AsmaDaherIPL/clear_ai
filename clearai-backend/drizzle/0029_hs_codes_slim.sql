-- ============================================================================
-- 0029_hs_codes_slim.sql
--
-- Slims down hs_codes to just the verbatim source-of-truth catalog data,
-- now that hs_code_display (commit #3) holds the derived display data and
-- hs_code_search (commit #4) holds the search index.
--
-- Drops:
--   • searchable_description_en, searchable_description_ar  (ADR-0024 cols
--     superseded by hs_code_search.tsv_input_en/ar)
--   • tsv_en, tsv_ar          (moved to hs_code_search)
--   • embedding               (moved to hs_code_search)
--   • is_leaf                 (every catalog row is HS-12 leaf since
--                              ADR-0008 — the column was always `true`,
--                              the readers' WHERE clauses are no-ops)
--   • raw_length              (always 12 since ADR-0008 — column was
--                              defensive scaffolding for the never-used
--                              "ingest mixed-precision codes" path)
--   • Old indexes that referenced these columns.
--   • Old triggers/functions that maintained tsv_en/ar on hs_codes
--     (hs_code_search has its own trigger now).
--
-- Keeps (for now — touching them would break too many other consumers):
--   • id (uuid PK)            — could be dropped in favour of code-as-PK
--                              in a future commit; not in scope here.
--   • chapter, heading, hs6,
--     hs8, hs10, parent10     — used by digit-normalize, branch-enumerate,
--                              expand. Could be reduced to chapter/heading/hs6
--                              with the rest derived from code in TS, but
--                              that's a separate refactor.
--
-- After this migration hs_codes contains:
--   id, code, chapter, heading, hs6, hs8, hs10, parent10,
--   description_en, description_ar, duty_en, duty_ar, procedures,
--   is_deleted, deletion_effective_date, replacement_codes, created_at
-- ============================================================================

-- 1. Drop triggers that touched hs_codes.tsv_*.
DROP TRIGGER IF EXISTS hs_codes_tsv_trigger ON hs_codes;
--> statement-breakpoint

-- 2. Drop the trigger function. hs_code_search has its own equivalent.
DROP FUNCTION IF EXISTS hs_codes_tsv_refresh();
--> statement-breakpoint

-- 3. Drop indexes that reference soon-to-be-dropped columns.
DROP INDEX IF EXISTS hs_codes_embedding_hnsw;
--> statement-breakpoint
DROP INDEX IF EXISTS hs_codes_tsv_en_idx;
--> statement-breakpoint
DROP INDEX IF EXISTS hs_codes_tsv_ar_idx;
--> statement-breakpoint
DROP INDEX IF EXISTS hs_codes_search_en_trgm;
--> statement-breakpoint
DROP INDEX IF EXISTS hs_codes_search_ar_trgm;
--> statement-breakpoint
DROP INDEX IF EXISTS hs_codes_leaf_idx;
--> statement-breakpoint

-- 4. Drop the columns.
ALTER TABLE hs_codes
  DROP COLUMN IF EXISTS searchable_description_en,
  DROP COLUMN IF EXISTS searchable_description_ar,
  DROP COLUMN IF EXISTS tsv_en,
  DROP COLUMN IF EXISTS tsv_ar,
  DROP COLUMN IF EXISTS embedding,
  DROP COLUMN IF EXISTS is_leaf,
  DROP COLUMN IF EXISTS raw_length;
--> statement-breakpoint
