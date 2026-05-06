-- ============================================================================
-- 0049_tenant_to_operator_filings_rename.sql
--
-- Renames:
--   tenants                  -> operators
--   tenant_field_mappings    -> operator_field_mappings
--   tenant_constants         -> operator_constants
--   tenant_lookups           -> operator_lookups
--   tenant_code_overrides    -> operator_code_overrides
--   declarations             -> declaration_run_filings
--
-- Plus every per-table:
--   * `tenant` (or `tenant_slug`) column -> `operator_slug`
--   * FK / CHECK / UNIQUE / PRIMARY KEY constraint name
--   * index name
--   * trigger name
--   * `declaration_set_id` column on declarations -> `declaration_run_id`
--
-- And on declaration_runs / declaration_run_items:
--   * `tenant` column -> `operator_slug`
--   * tenant_format_chk -> operator_slug_format_chk (constraint name)
--   * tenant_idx -> operator_slug_idx (index)
--   * tenant_fk -> operator_slug_fk (FK to operators(slug))
--
-- All idempotent via guarded DO $$ BEGIN ... END $$ blocks. Safe to re-run.
-- ============================================================================

-- ---------- tenants -> operators ----------

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tenants')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'operators') THEN
    ALTER TABLE tenants RENAME TO operators;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_slug_uniq') THEN
    ALTER TABLE operators RENAME CONSTRAINT tenants_slug_uniq TO operators_slug_uniq;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_slug_format_chk') THEN
    ALTER TABLE operators RENAME CONSTRAINT tenants_slug_format_chk TO operators_slug_format_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_bundle_size_range_chk') THEN
    ALTER TABLE operators RENAME CONSTRAINT tenants_bundle_size_range_chk TO operators_bundle_size_range_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_hv_threshold_nonneg_chk') THEN
    ALTER TABLE operators RENAME CONSTRAINT tenants_hv_threshold_nonneg_chk TO operators_hv_threshold_nonneg_chk;
  END IF;
END $$;

DROP TRIGGER IF EXISTS tenants_touch_updated_at_trg ON operators;
DROP TRIGGER IF EXISTS operators_touch_updated_at_trg ON operators;
CREATE TRIGGER operators_touch_updated_at_trg
  BEFORE UPDATE ON operators
  FOR EACH ROW
  EXECUTE FUNCTION batches_touch_updated_at();

-- ---------- tenant_field_mappings -> operator_field_mappings ----------

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tenant_field_mappings')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'operator_field_mappings') THEN
    ALTER TABLE tenant_field_mappings RENAME TO operator_field_mappings;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'operator_field_mappings' AND column_name = 'tenant') THEN
    ALTER TABLE operator_field_mappings RENAME COLUMN tenant TO operator_slug;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_field_mappings_tenant_fk') THEN
    ALTER TABLE operator_field_mappings RENAME CONSTRAINT tenant_field_mappings_tenant_fk TO operator_field_mappings_operator_slug_fk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_field_mappings_tenant_format_chk') THEN
    ALTER TABLE operator_field_mappings RENAME CONSTRAINT tenant_field_mappings_tenant_format_chk TO operator_field_mappings_operator_slug_format_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_field_mappings_transform_chk') THEN
    ALTER TABLE operator_field_mappings RENAME CONSTRAINT tenant_field_mappings_transform_chk TO operator_field_mappings_transform_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_field_mappings_canonical_field_format_chk') THEN
    ALTER TABLE operator_field_mappings RENAME CONSTRAINT tenant_field_mappings_canonical_field_format_chk TO operator_field_mappings_canonical_field_format_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_field_mappings_tenant_canonical_uniq') THEN
    ALTER TABLE operator_field_mappings RENAME CONSTRAINT tenant_field_mappings_tenant_canonical_uniq TO operator_field_mappings_operator_slug_canonical_uniq;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'tenant_field_mappings_tenant_idx') THEN
    ALTER INDEX tenant_field_mappings_tenant_idx RENAME TO operator_field_mappings_operator_slug_idx;
  END IF;
END $$;

-- ---------- tenant_constants -> operator_constants ----------

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tenant_constants')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'operator_constants') THEN
    ALTER TABLE tenant_constants RENAME TO operator_constants;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'operator_constants' AND column_name = 'tenant') THEN
    ALTER TABLE operator_constants RENAME COLUMN tenant TO operator_slug;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_constants_tenant_fk') THEN
    ALTER TABLE operator_constants RENAME CONSTRAINT tenant_constants_tenant_fk TO operator_constants_operator_slug_fk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_constants_tenant_format_chk') THEN
    ALTER TABLE operator_constants RENAME CONSTRAINT tenant_constants_tenant_format_chk TO operator_constants_operator_slug_format_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_constants_key_format_chk') THEN
    ALTER TABLE operator_constants RENAME CONSTRAINT tenant_constants_key_format_chk TO operator_constants_key_format_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_constants_tenant_key_uniq') THEN
    ALTER TABLE operator_constants RENAME CONSTRAINT tenant_constants_tenant_key_uniq TO operator_constants_operator_slug_key_uniq;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'tenant_constants_tenant_idx') THEN
    ALTER INDEX tenant_constants_tenant_idx RENAME TO operator_constants_operator_slug_idx;
  END IF;
END $$;

-- ---------- tenant_lookups -> operator_lookups ----------

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tenant_lookups')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'operator_lookups') THEN
    ALTER TABLE tenant_lookups RENAME TO operator_lookups;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'operator_lookups' AND column_name = 'tenant') THEN
    ALTER TABLE operator_lookups RENAME COLUMN tenant TO operator_slug;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_lookups_tenant_fk') THEN
    ALTER TABLE operator_lookups RENAME CONSTRAINT tenant_lookups_tenant_fk TO operator_lookups_operator_slug_fk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_lookups_tenant_format_chk') THEN
    ALTER TABLE operator_lookups RENAME CONSTRAINT tenant_lookups_tenant_format_chk TO operator_lookups_operator_slug_format_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_lookups_type_format_chk') THEN
    ALTER TABLE operator_lookups RENAME CONSTRAINT tenant_lookups_type_format_chk TO operator_lookups_type_format_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_lookups_metadata_object_chk') THEN
    ALTER TABLE operator_lookups RENAME CONSTRAINT tenant_lookups_metadata_object_chk TO operator_lookups_metadata_object_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_lookups_natural_uniq') THEN
    ALTER TABLE operator_lookups RENAME CONSTRAINT tenant_lookups_natural_uniq TO operator_lookups_natural_uniq;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'tenant_lookups_tenant_type_idx') THEN
    ALTER INDEX tenant_lookups_tenant_type_idx RENAME TO operator_lookups_operator_slug_type_idx;
  END IF;
END $$;

-- ---------- tenant_code_overrides -> operator_code_overrides ----------

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tenant_code_overrides')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'operator_code_overrides') THEN
    ALTER TABLE tenant_code_overrides RENAME TO operator_code_overrides;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'operator_code_overrides' AND column_name = 'tenant') THEN
    ALTER TABLE operator_code_overrides RENAME COLUMN tenant TO operator_slug;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_code_overrides_target_fk') THEN
    ALTER TABLE operator_code_overrides RENAME CONSTRAINT tenant_code_overrides_target_fk TO operator_code_overrides_target_fk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_code_overrides_source_digits_chk') THEN
    ALTER TABLE operator_code_overrides RENAME CONSTRAINT tenant_code_overrides_source_digits_chk TO operator_code_overrides_source_digits_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_code_overrides_no_padded_self_map_chk') THEN
    ALTER TABLE operator_code_overrides RENAME CONSTRAINT tenant_code_overrides_no_padded_self_map_chk TO operator_code_overrides_no_padded_self_map_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_code_overrides_tenant_format_chk') THEN
    ALTER TABLE operator_code_overrides RENAME CONSTRAINT tenant_code_overrides_tenant_format_chk TO operator_code_overrides_operator_slug_format_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'tenant_code_overrides_target_idx') THEN
    ALTER INDEX tenant_code_overrides_target_idx RENAME TO operator_code_overrides_target_idx;
  END IF;
END $$;

-- ---------- declaration_runs.tenant -> declaration_runs.operator_slug ----------

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'declaration_runs' AND column_name = 'tenant') THEN
    ALTER TABLE declaration_runs RENAME COLUMN tenant TO operator_slug;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_runs_tenant_fk') THEN
    ALTER TABLE declaration_runs RENAME CONSTRAINT declaration_runs_tenant_fk TO declaration_runs_operator_slug_fk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declaration_runs_tenant_format_chk') THEN
    ALTER TABLE declaration_runs RENAME CONSTRAINT declaration_runs_tenant_format_chk TO declaration_runs_operator_slug_format_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'declaration_runs_tenant_idx') THEN
    ALTER INDEX declaration_runs_tenant_idx RENAME TO declaration_runs_operator_slug_idx;
  END IF;
END $$;

-- ---------- declarations -> declaration_run_filings ----------

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'declarations')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'declaration_run_filings') THEN
    ALTER TABLE declarations RENAME TO declaration_run_filings;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declarations_set_fk') THEN
    ALTER TABLE declaration_run_filings RENAME CONSTRAINT declarations_set_fk TO declaration_run_filings_run_fk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declarations_bundle_strategy_chk') THEN
    ALTER TABLE declaration_run_filings RENAME CONSTRAINT declarations_bundle_strategy_chk TO declaration_run_filings_bundle_strategy_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declarations_bundle_index_nonneg_chk') THEN
    ALTER TABLE declaration_run_filings RENAME CONSTRAINT declarations_bundle_index_nonneg_chk TO declaration_run_filings_bundle_index_nonneg_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declarations_item_count_pos_chk') THEN
    ALTER TABLE declaration_run_filings RENAME CONSTRAINT declarations_item_count_pos_chk TO declaration_run_filings_item_count_pos_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declarations_strategy_count_consistency_chk') THEN
    ALTER TABLE declaration_run_filings RENAME CONSTRAINT declarations_strategy_count_consistency_chk TO declaration_run_filings_strategy_count_consistency_chk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declarations_set_bundle_uniq') THEN
    ALTER TABLE declaration_run_filings RENAME CONSTRAINT declarations_set_bundle_uniq TO declaration_run_filings_run_bundle_uniq;
  END IF;
  -- Older 0048-rename name (declaration_runs_*) — also try in case 0048 ran.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declarations_declaration_run_id_fk') THEN
    ALTER TABLE declaration_run_filings RENAME CONSTRAINT declarations_declaration_run_id_fk TO declaration_run_filings_run_fk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'declarations_declaration_run_id_bundle_index_uq') THEN
    ALTER TABLE declaration_run_filings RENAME CONSTRAINT declarations_declaration_run_id_bundle_index_uq TO declaration_run_filings_run_bundle_uniq;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'declarations_set_idx') THEN
    ALTER INDEX declarations_set_idx RENAME TO declaration_run_filings_run_idx;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'declarations_declaration_run_id_idx') THEN
    ALTER INDEX declarations_declaration_run_id_idx RENAME TO declaration_run_filings_run_idx;
  END IF;
END $$;
