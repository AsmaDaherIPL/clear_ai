-- ============================================================================
-- 0084_rename_declaration_runs_to_batches.sql
--
-- Renames the declaration-run surface to batch. The artifact is unchanged
-- (one row per uploaded source file or API submission). The previous name
-- collides with the new ZATCA "declaration" entity (NQD per AWB) introduced
-- under PR2; "batch" matches what the HTTP routes, SPA, and operators
-- already call it. After this migration:
--
--   declaration_runs        -> batches
--   declaration_run_items   -> batch_items
--   declaration_run_filings -> batch_filings
--
-- FK columns and the hitl_queue cross-table FK reference are renamed in
-- lockstep. All CHECK constraints, indexes, triggers, and the UNIQUE on
-- (run_id, row_index) are renamed so a fresh pg_dump matches what we'd
-- have written if the tables had always been called this.
--
-- Idempotent via IF EXISTS / IF NOT EXISTS guards. ALTER TABLE RENAME is
-- not natively idempotent so the migration uses DO blocks. Re-running this
-- file against a freshly migrated DB is a no-op.
-- ============================================================================

-- ---------- declaration_runs -> batches ----------

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'declaration_runs')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'batches') THEN
    ALTER TABLE declaration_runs RENAME TO batches;
  END IF;
END $$;

-- Indexes
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'declaration_runs_operator_id_idx') THEN
    ALTER INDEX declaration_runs_operator_id_idx RENAME TO batches_operator_id_idx;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'declaration_runs_created_at_idx') THEN
    ALTER INDEX declaration_runs_created_at_idx RENAME TO batches_created_at_idx;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'declaration_runs_operator_slug_idx') THEN
    ALTER INDEX declaration_runs_operator_slug_idx RENAME TO batches_operator_slug_idx;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'declaration_runs_tenant_idx') THEN
    ALTER INDEX declaration_runs_tenant_idx RENAME TO batches_tenant_idx;
  END IF;
END $$;

-- Constraints (FK + CHECK)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_runs_operator_id_fk') THEN
    ALTER TABLE batches RENAME CONSTRAINT declaration_runs_operator_id_fk TO batches_operator_id_fk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_runs_operator_slug_fk') THEN
    ALTER TABLE batches RENAME CONSTRAINT declaration_runs_operator_slug_fk TO batches_operator_slug_fk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_runs_operator_slug_format_chk') THEN
    ALTER TABLE batches RENAME CONSTRAINT declaration_runs_operator_slug_format_chk TO batches_operator_slug_format_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_runs_tenant_fk') THEN
    ALTER TABLE batches RENAME CONSTRAINT declaration_runs_tenant_fk TO batches_tenant_fk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_runs_tenant_format_chk') THEN
    ALTER TABLE batches RENAME CONSTRAINT declaration_runs_tenant_format_chk TO batches_tenant_format_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_runs_mode_chk') THEN
    ALTER TABLE batches RENAME CONSTRAINT declaration_runs_mode_chk TO batches_mode_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_runs_status_chk') THEN
    ALTER TABLE batches RENAME CONSTRAINT declaration_runs_status_chk TO batches_status_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_runs_classification_status_chk') THEN
    ALTER TABLE batches RENAME CONSTRAINT declaration_runs_classification_status_chk TO batches_classification_status_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_runs_declaration_status_chk') THEN
    ALTER TABLE batches RENAME CONSTRAINT declaration_runs_declaration_status_chk TO batches_declaration_status_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_runs_mode_declaration_consistency_chk') THEN
    ALTER TABLE batches RENAME CONSTRAINT declaration_runs_mode_declaration_consistency_chk TO batches_mode_declaration_consistency_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_runs_metadata_object_chk') THEN
    ALTER TABLE batches RENAME CONSTRAINT declaration_runs_metadata_object_chk TO batches_metadata_object_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_runs_row_count_nonneg_chk') THEN
    ALTER TABLE batches RENAME CONSTRAINT declaration_runs_row_count_nonneg_chk TO batches_row_count_nonneg_chk;
  END IF;
END $$;

-- Trigger. The underlying batches_touch_updated_at() function from
-- migration 0038 is reused as-is — its name happens to already match the
-- new entity name.
DROP TRIGGER IF EXISTS declaration_runs_touch_updated_at_trg ON batches;
DROP TRIGGER IF EXISTS batches_touch_updated_at_trg ON batches;
CREATE TRIGGER batches_touch_updated_at_trg
  BEFORE UPDATE ON batches
  FOR EACH ROW
  EXECUTE FUNCTION batches_touch_updated_at();

-- ---------- declaration_run_items -> batch_items ----------

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'declaration_run_items')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'batch_items') THEN
    ALTER TABLE declaration_run_items RENAME TO batch_items;
  END IF;
END $$;

-- Rename parent FK column
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'batch_items' AND column_name = 'declaration_run_id'
  ) THEN
    ALTER TABLE batch_items RENAME COLUMN declaration_run_id TO batch_id;
  END IF;
END $$;

-- Indexes
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'declaration_run_items_run_id_idx') THEN
    ALTER INDEX declaration_run_items_run_id_idx RENAME TO batch_items_batch_id_idx;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'declaration_run_items_set_row_idx') THEN
    ALTER INDEX declaration_run_items_set_row_idx RENAME TO batch_items_batch_row_idx;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'declaration_run_items_status_idx') THEN
    ALTER INDEX declaration_run_items_status_idx RENAME TO batch_items_status_idx;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'declaration_run_items_excluded_idx') THEN
    ALTER INDEX declaration_run_items_excluded_idx RENAME TO batch_items_excluded_idx;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'declaration_run_items_set_row_uniq') THEN
    ALTER INDEX declaration_run_items_set_row_uniq RENAME TO batch_items_batch_row_uniq;
  END IF;
END $$;

-- Constraints
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_run_items_run_id_fk') THEN
    ALTER TABLE batch_items RENAME CONSTRAINT declaration_run_items_run_id_fk TO batch_items_batch_id_fk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_run_items_set_fk') THEN
    ALTER TABLE batch_items RENAME CONSTRAINT declaration_run_items_set_fk TO batch_items_batch_id_fk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_run_items_set_row_uniq') THEN
    ALTER TABLE batch_items RENAME CONSTRAINT declaration_run_items_set_row_uniq TO batch_items_batch_row_uniq;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_run_items_final_code_fk') THEN
    ALTER TABLE batch_items RENAME CONSTRAINT declaration_run_items_final_code_fk TO batch_items_final_code_fk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_run_items_status_chk') THEN
    ALTER TABLE batch_items RENAME CONSTRAINT declaration_run_items_status_chk TO batch_items_status_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_run_items_canonical_object_chk') THEN
    ALTER TABLE batch_items RENAME CONSTRAINT declaration_run_items_canonical_object_chk TO batch_items_canonical_object_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_run_items_raw_row_object_chk') THEN
    ALTER TABLE batch_items RENAME CONSTRAINT declaration_run_items_raw_row_object_chk TO batch_items_raw_row_object_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_run_items_classification_result_object_chk') THEN
    ALTER TABLE batch_items RENAME CONSTRAINT declaration_run_items_classification_result_object_chk TO batch_items_classification_result_object_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_run_items_trace_object_chk') THEN
    ALTER TABLE batch_items RENAME CONSTRAINT declaration_run_items_trace_object_chk TO batch_items_trace_object_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_run_items_final_code_status_consistency_chk') THEN
    ALTER TABLE batch_items RENAME CONSTRAINT declaration_run_items_final_code_status_consistency_chk TO batch_items_final_code_status_consistency_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_run_items_goods_description_ar_status_consistency_chk') THEN
    ALTER TABLE batch_items RENAME CONSTRAINT declaration_run_items_goods_description_ar_status_consistency_chk TO batch_items_goods_description_ar_status_consistency_chk;
  END IF;
END $$;

-- Trigger
DROP TRIGGER IF EXISTS declaration_run_items_touch_updated_at_trg ON batch_items;
DROP TRIGGER IF EXISTS batch_items_touch_updated_at_trg ON batch_items;
CREATE TRIGGER batch_items_touch_updated_at_trg
  BEFORE UPDATE ON batch_items
  FOR EACH ROW
  EXECUTE FUNCTION batches_touch_updated_at();

-- ---------- declaration_run_filings -> batch_filings ----------

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'declaration_run_filings')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'batch_filings') THEN
    ALTER TABLE declaration_run_filings RENAME TO batch_filings;
  END IF;
END $$;

-- Rename parent FK column
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'batch_filings' AND column_name = 'declaration_run_id'
  ) THEN
    ALTER TABLE batch_filings RENAME COLUMN declaration_run_id TO batch_id;
  END IF;
END $$;

-- Indexes
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'declaration_run_filings_run_idx') THEN
    ALTER INDEX declaration_run_filings_run_idx RENAME TO batch_filings_batch_idx;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'declaration_run_filings_status_idx') THEN
    ALTER INDEX declaration_run_filings_status_idx RENAME TO batch_filings_status_idx;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'declaration_run_filings_zatca_status_idx') THEN
    ALTER INDEX declaration_run_filings_zatca_status_idx RENAME TO batch_filings_zatca_status_idx;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'declaration_run_filings_run_bundle_uniq') THEN
    ALTER INDEX declaration_run_filings_run_bundle_uniq RENAME TO batch_filings_batch_bundle_uniq;
  END IF;
END $$;

-- Constraints
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_run_filings_run_fk') THEN
    ALTER TABLE batch_filings RENAME CONSTRAINT declaration_run_filings_run_fk TO batch_filings_batch_id_fk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_run_filings_run_bundle_uniq') THEN
    ALTER TABLE batch_filings RENAME CONSTRAINT declaration_run_filings_run_bundle_uniq TO batch_filings_batch_bundle_uniq;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_run_filings_status_chk') THEN
    ALTER TABLE batch_filings RENAME CONSTRAINT declaration_run_filings_status_chk TO batch_filings_status_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_run_filings_zatca_status_chk') THEN
    ALTER TABLE batch_filings RENAME CONSTRAINT declaration_run_filings_zatca_status_chk TO batch_filings_zatca_status_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_run_filings_bundle_strategy_chk') THEN
    ALTER TABLE batch_filings RENAME CONSTRAINT declaration_run_filings_bundle_strategy_chk TO batch_filings_bundle_strategy_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_run_filings_bundle_index_nonneg_chk') THEN
    ALTER TABLE batch_filings RENAME CONSTRAINT declaration_run_filings_bundle_index_nonneg_chk TO batch_filings_bundle_index_nonneg_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_run_filings_item_count_pos_chk') THEN
    ALTER TABLE batch_filings RENAME CONSTRAINT declaration_run_filings_item_count_pos_chk TO batch_filings_item_count_pos_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_run_filings_strategy_count_consistency_chk') THEN
    ALTER TABLE batch_filings RENAME CONSTRAINT declaration_run_filings_strategy_count_consistency_chk TO batch_filings_strategy_count_consistency_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_run_filings_zatca_consistency_chk') THEN
    ALTER TABLE batch_filings RENAME CONSTRAINT declaration_run_filings_zatca_consistency_chk TO batch_filings_zatca_consistency_chk;
  END IF;
END $$;

-- ---------- hitl_queue.batch_id FK constraint already points at the
-- ---------- renamed table; the FK target is resolved by OID, not name,
-- ---------- so no action needed there. The constraint name
-- ---------- hitl_queue_batch_id_fkey was already batch-themed.
