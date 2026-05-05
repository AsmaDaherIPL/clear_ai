-- ============================================================================
-- 0046_zatca_tunables_setup_meta.sql
--
-- The HV/LV partitioning thresholds are ZATCA-spec, not per-tenant. They were
-- mistakenly added as columns on `tenants` in 0038. This migration:
--   1. inserts the canonical values into setup_meta as numeric tunables
--      (alongside MIN_SCORE_*, RRF_K, etc.);
--   2. drops the per-tenant columns (`bundle_size`, `hv_threshold_sar`).
--
-- Keys added:
--   ZATCA_HV_THRESHOLD_SAR  high-value cutoff in SAR (1000.00)
--   ZATCA_BUNDLE_SIZE       max items per LV consolidated declaration (99)
--
-- Why setup_meta (not env): consistent with how every other tunable is
-- expressed (MIN_SCORE_*, RETRIEVAL_TOP_K_*, BRANCH_PREFIX_LENGTH, etc.).
-- Operators tune via SQL UPDATE; the loader fail-closes on missing keys.
--
-- Per-tenant override: future bilateral agreements (e.g. a carrier with a
-- different threshold) belong in tenant_constants, not as a columns on
-- `tenants` — keep `tenants` narrow.
--
-- What's safe:
--   • Idempotent (ON CONFLICT, IF EXISTS).
--   • The bundle_size/hv_threshold_sar columns currently default to
--     99/1000.00 for every tenant; existing data is preserved as the
--     default only (no tenant-specific override exists).
-- ============================================================================

INSERT INTO setup_meta (key, value, description, value_kind, value_numeric)
VALUES
  ('ZATCA_HV_THRESHOLD_SAR', '1000', 'ZATCA HV/LV cutoff in SAR. Items with valueAmount-converted-to-SAR >= this go to standalone declarations.', 'number', 1000),
  ('ZATCA_BUNDLE_SIZE',      '99',   'Max items per LV consolidated ZATCA declaration. Naqel ships 99; ZATCA spec allows up to 99 per consolidated Pre-Bayan.', 'number', 99)
ON CONFLICT (key) DO UPDATE
  SET value         = EXCLUDED.value,
      description   = EXCLUDED.description,
      value_kind    = EXCLUDED.value_kind,
      value_numeric = EXCLUDED.value_numeric;
--> statement-breakpoint

ALTER TABLE tenants
  DROP COLUMN IF EXISTS bundle_size,
  DROP COLUMN IF EXISTS hv_threshold_sar;
--> statement-breakpoint

-- Drop the now-orphaned CHECKs from 0038 (they referenced the dropped
-- columns; ALTER TABLE DROP COLUMN auto-drops the CHECKs but be explicit
-- so a re-run doesn't surprise).
ALTER TABLE tenants
  DROP CONSTRAINT IF EXISTS tenants_bundle_size_range_chk,
  DROP CONSTRAINT IF EXISTS tenants_hv_threshold_nonneg_chk;
--> statement-breakpoint
