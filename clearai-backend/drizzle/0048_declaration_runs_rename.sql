-- ============================================================================
-- 0048_declaration_runs_rename.sql
--
-- Renames the declaration-set surface to declaration-run. The artifact still
-- represents the same thing (one row per uploaded file = one run of the
-- pipeline producing N declarations); "run" reflects the verb-shape better
-- and matches the renamed HTTP surface (/declaration-runs).
--
-- Tables renamed:
--   declaration_sets        -> declaration_runs
--   declaration_set_items   -> declaration_run_items
--
-- Columns renamed:
--   declarations.declaration_set_id -> declaration_runs.declaration_run_id
--
-- All FK constraints, CHECK constraints, indexes, and triggers are renamed
-- in lockstep so a fresh `pg_dump` of the schema after this migration is
-- indistinguishable from "what we would have written if we'd called it
-- declaration_runs from the start."
--
-- Idempotent via IF EXISTS / IF NOT EXISTS where Postgres permits. ALTER
-- TABLE ... RENAME is not idempotent, so the migration uses guarded DO blocks.
-- ============================================================================

-- ---------- declaration_sets -> declaration_runs ----------

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'declaration_sets')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'declaration_runs') THEN
    ALTER TABLE declaration_sets RENAME TO declaration_runs;
  END IF;
END $$;

-- Indexes
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'declaration_sets_tenant_idx') THEN
    ALTER INDEX declaration_sets_tenant_idx RENAME TO declaration_runs_tenant_idx;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'declaration_sets_created_at_idx') THEN
    ALTER INDEX declaration_sets_created_at_idx RENAME TO declaration_runs_created_at_idx;
  END IF;
END $$;

-- Constraints (FK + CHECKs)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_sets_tenant_fk') THEN
    ALTER TABLE declaration_runs RENAME CONSTRAINT declaration_sets_tenant_fk TO declaration_runs_tenant_fk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_sets_tenant_format_chk') THEN
    ALTER TABLE declaration_runs RENAME CONSTRAINT declaration_sets_tenant_format_chk TO declaration_runs_tenant_format_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_sets_mode_chk') THEN
    ALTER TABLE declaration_runs RENAME CONSTRAINT declaration_sets_mode_chk TO declaration_runs_mode_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_sets_status_chk') THEN
    ALTER TABLE declaration_runs RENAME CONSTRAINT declaration_sets_status_chk TO declaration_runs_status_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_sets_classification_status_chk') THEN
    ALTER TABLE declaration_runs RENAME CONSTRAINT declaration_sets_classification_status_chk TO declaration_runs_classification_status_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_sets_declaration_status_chk') THEN
    ALTER TABLE declaration_runs RENAME CONSTRAINT declaration_sets_declaration_status_chk TO declaration_runs_declaration_status_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_sets_mode_declaration_consistency_chk') THEN
    ALTER TABLE declaration_runs RENAME CONSTRAINT declaration_sets_mode_declaration_consistency_chk TO declaration_runs_mode_declaration_consistency_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_sets_metadata_object_chk') THEN
    ALTER TABLE declaration_runs RENAME CONSTRAINT declaration_sets_metadata_object_chk TO declaration_runs_metadata_object_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_sets_row_count_nonneg_chk') THEN
    ALTER TABLE declaration_runs RENAME CONSTRAINT declaration_sets_row_count_nonneg_chk TO declaration_runs_row_count_nonneg_chk;
  END IF;
END $$;

-- Trigger on the renamed table. Reuses the batches_touch_updated_at()
-- function from 0038 — keeping that legacy function name avoids touching
-- every other table that already EXECUTEs it.
DROP TRIGGER IF EXISTS declaration_sets_touch_updated_at_trg ON declaration_runs;
DROP TRIGGER IF EXISTS declaration_runs_touch_updated_at_trg ON declaration_runs;
CREATE TRIGGER declaration_runs_touch_updated_at_trg
  BEFORE UPDATE ON declaration_runs
  FOR EACH ROW
  EXECUTE FUNCTION batches_touch_updated_at();

-- ---------- declaration_set_items -> declaration_run_items ----------

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'declaration_set_items')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'declaration_run_items') THEN
    ALTER TABLE declaration_set_items RENAME TO declaration_run_items;
  END IF;
END $$;

-- Rename the parent FK column
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'declaration_run_items' AND column_name = 'declaration_set_id'
  ) THEN
    ALTER TABLE declaration_run_items RENAME COLUMN declaration_set_id TO declaration_run_id;
  END IF;
END $$;

-- Indexes + constraints under the new table name
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'declaration_set_items_set_id_idx') THEN
    ALTER INDEX declaration_set_items_set_id_idx RENAME TO declaration_run_items_run_id_idx;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'declaration_set_items_status_idx') THEN
    ALTER INDEX declaration_set_items_status_idx RENAME TO declaration_run_items_status_idx;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_set_items_set_id_fk') THEN
    ALTER TABLE declaration_run_items RENAME CONSTRAINT declaration_set_items_set_id_fk TO declaration_run_items_run_id_fk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_set_items_status_chk') THEN
    ALTER TABLE declaration_run_items RENAME CONSTRAINT declaration_set_items_status_chk TO declaration_run_items_status_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_set_items_canonical_object_chk') THEN
    ALTER TABLE declaration_run_items RENAME CONSTRAINT declaration_set_items_canonical_object_chk TO declaration_run_items_canonical_object_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_set_items_raw_row_object_chk') THEN
    ALTER TABLE declaration_run_items RENAME CONSTRAINT declaration_set_items_raw_row_object_chk TO declaration_run_items_raw_row_object_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_set_items_classification_result_object_chk') THEN
    ALTER TABLE declaration_run_items RENAME CONSTRAINT declaration_set_items_classification_result_object_chk TO declaration_run_items_classification_result_object_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_set_items_trace_object_chk') THEN
    ALTER TABLE declaration_run_items RENAME CONSTRAINT declaration_set_items_trace_object_chk TO declaration_run_items_trace_object_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_set_items_goods_description_ar_status_consistency_chk') THEN
    ALTER TABLE declaration_run_items RENAME CONSTRAINT declaration_set_items_goods_description_ar_status_consistency_chk TO declaration_run_items_goods_description_ar_status_consistency_chk;
  END IF;
END $$;

-- ---------- declarations.declaration_set_id -> declaration_run_id ----------

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'declarations' AND column_name = 'declaration_set_id'
  ) THEN
    ALTER TABLE declarations RENAME COLUMN declaration_set_id TO declaration_run_id;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'declarations_declaration_set_id_idx') THEN
    ALTER INDEX declarations_declaration_set_id_idx RENAME TO declarations_declaration_run_id_idx;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declarations_declaration_set_id_fk') THEN
    ALTER TABLE declarations RENAME CONSTRAINT declarations_declaration_set_id_fk TO declarations_declaration_run_id_fk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declarations_declaration_set_id_bundle_index_uq') THEN
    ALTER TABLE declarations RENAME CONSTRAINT declarations_declaration_set_id_bundle_index_uq TO declarations_declaration_run_id_bundle_index_uq;
  END IF;
END $$;
