-- ============================================================================
-- 0033_rename_zatca_prefix.sql
--
-- Renames the four ZATCA-derivative tables to carry the `zatca_` prefix,
-- and renames tenant_code_overrides.source_code_norm → source_code.
--
-- Why the prefix:
--   The catalog data and its derivative indexes all originate from the
--   ZATCA tariff xlsx. Naming makes the data lineage obvious — when a
--   future engineer sees `zatca_hs_codes` they immediately know the
--   source-of-truth + update cadence (quarterly ZATCA xlsx drops).
--   Tables that aren't ZATCA-derived (tenant_code_overrides, setup_meta,
--   classification_events, classification_feedback) keep their names.
--
-- Why source_code → source_code_norm rename:
--   "_norm" was redundant — every value in the column is normalised
--   (digit-only, no separators) by virtue of the ingest pipeline. The
--   suffix added noise without clarifying.
--
-- Knock-on renames (PG renames the auto-named PK/UNIQUE constraints
-- automatically when a table is renamed; we explicitly rename indexes,
-- the deletion-info function in catalog/deleted-codes, and the trigger
-- name to match the new table prefix).
-- ============================================================================

-- 1. Rename tables (PG renames their automatic PK/UNIQUE/FK constraints
--    along with them). Order matters only if there are FK dependencies,
--    but RENAME TABLE doesn't require DROP-FK first — the FK metadata
--    follows the table.
ALTER TABLE hs_codes          RENAME TO zatca_hs_codes;
--> statement-breakpoint
ALTER TABLE procedure_codes   RENAME TO zatca_procedure_codes;
--> statement-breakpoint
ALTER TABLE hs_code_display   RENAME TO zatca_hs_code_display;
--> statement-breakpoint
ALTER TABLE hs_code_search    RENAME TO zatca_hs_code_search;
--> statement-breakpoint

-- 2. Rename indexes that carried the old table name (cosmetic — they'd
--    keep working under their old names but the inconsistency would be
--    confusing in pg_indexes output).
ALTER INDEX hs_codes_chapter_idx              RENAME TO zatca_hs_codes_chapter_idx;
--> statement-breakpoint
ALTER INDEX hs_codes_heading_idx              RENAME TO zatca_hs_codes_heading_idx;
--> statement-breakpoint
ALTER INDEX hs_codes_hs6_idx                  RENAME TO zatca_hs_codes_hs6_idx;
--> statement-breakpoint
ALTER INDEX hs_codes_active_idx               RENAME TO zatca_hs_codes_active_idx;
--> statement-breakpoint
ALTER INDEX IF EXISTS hs_codes_procedures_gin RENAME TO zatca_hs_codes_procedures_gin;
--> statement-breakpoint
ALTER INDEX hs_code_display_path_codes_gin    RENAME TO zatca_hs_code_display_path_codes_gin;
--> statement-breakpoint
ALTER INDEX hs_code_search_embedding_hnsw     RENAME TO zatca_hs_code_search_embedding_hnsw;
--> statement-breakpoint
ALTER INDEX hs_code_search_tsv_en_idx         RENAME TO zatca_hs_code_search_tsv_en_idx;
--> statement-breakpoint
ALTER INDEX hs_code_search_tsv_ar_idx         RENAME TO zatca_hs_code_search_tsv_ar_idx;
--> statement-breakpoint
ALTER INDEX hs_code_search_tsv_input_en_trgm  RENAME TO zatca_hs_code_search_tsv_input_en_trgm;
--> statement-breakpoint
ALTER INDEX hs_code_search_tsv_input_ar_trgm  RENAME TO zatca_hs_code_search_tsv_input_ar_trgm;
--> statement-breakpoint
ALTER INDEX procedure_codes_repealed_idx      RENAME TO zatca_procedure_codes_repealed_idx;
--> statement-breakpoint

-- 3. Rename UNIQUE / CHECK constraints that carried the old table name.
ALTER TABLE zatca_hs_codes
  RENAME CONSTRAINT hs_codes_duty_consistency_chk
    TO zatca_hs_codes_duty_consistency_chk;
--> statement-breakpoint

-- 4. Rename the tsv refresh trigger function + recreate the trigger
--    pointing at the new table name. Triggers don't auto-rename when
--    the table renames, but the trigger keeps working — we drop+recreate
--    only for naming hygiene.
ALTER FUNCTION hs_code_search_tsv_refresh() RENAME TO zatca_hs_code_search_tsv_refresh;
--> statement-breakpoint

DROP TRIGGER IF EXISTS hs_code_search_tsv_trigger ON zatca_hs_code_search;
--> statement-breakpoint
CREATE TRIGGER zatca_hs_code_search_tsv_trigger
  BEFORE INSERT OR UPDATE OF tsv_input_en, tsv_input_ar
  ON zatca_hs_code_search
  FOR EACH ROW EXECUTE FUNCTION zatca_hs_code_search_tsv_refresh();
--> statement-breakpoint

-- 5. Column rename on tenant_code_overrides.
ALTER TABLE tenant_code_overrides
  RENAME COLUMN source_code_norm TO source_code;
--> statement-breakpoint

-- The CHECK and UNIQUE constraints reference the renamed column
-- automatically — PG follows column renames inside constraint definitions.
-- The constraint NAMES still carry "_source_" or are auto-generated;
-- rename the obvious ones for readability.
ALTER TABLE tenant_code_overrides
  RENAME CONSTRAINT tenant_code_overrides_source_digits_chk
    TO tenant_code_overrides_source_code_digits_chk;
--> statement-breakpoint
-- (tenant_code_overrides_no_padded_self_map_chk keeps its name —
--  its column reference still resolves correctly post-rename.)

