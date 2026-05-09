-- 0065_zatca_hs_code_display_drop_legacy_cols.sql
--
-- Drop 5 dead columns from zatca_hs_code_display. They're left over from
-- when submission descriptions lived on this table before migration 0058
-- gave them their own per-input-keyed table (submission_descriptions).
-- Nothing in the running code reads these columns; they were never
-- backfilled at scale. Safe to drop.

BEGIN;

ALTER TABLE zatca_hs_code_display
  DROP COLUMN IF EXISTS submission_description_en,
  DROP COLUMN IF EXISTS submission_description_ar,
  DROP COLUMN IF EXISTS submission_desc_model,
  DROP COLUMN IF EXISTS submission_desc_generated_at,
  DROP COLUMN IF EXISTS derived_at;

COMMIT;
