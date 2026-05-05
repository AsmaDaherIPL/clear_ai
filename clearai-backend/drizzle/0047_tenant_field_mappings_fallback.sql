-- ============================================================================
-- 0047_tenant_field_mappings_fallback.sql
--
-- Adds `fallback_columns text[]` to tenant_field_mappings.
--
-- Background: a single tenant can ship multiple commercial-invoice xlsx
-- variants where the same canonical field arrives in different headers.
-- Naqel's two known sets:
--   set A (light-example):  ConsigneeName, Mobile
--   set B (alt sample):     Consignee,     MobileNo
--
-- Today the mapper reads `source_column` and throws on missing required
-- fields. With `fallback_columns`, the mapper takes the first non-empty
-- cell in [source_column, ...fallback_columns]. Naqel rule for
-- consigneeName becomes:
--   sourceColumn = 'ConsigneeName', fallbackColumns = ['Consignee']
--
-- This generalises beyond Naqel — any tenant that renames a column over
-- time, or whose upstream system inconsistently spells a header, can ship
-- a fallback chain without code changes.
--
-- What's safe:
--   • ADD COLUMN with NOT NULL DEFAULT '{}'::text[] — every existing row
--     gets an empty array, no breakage.
--   • Idempotent (IF NOT EXISTS).
--
-- What's intentionally not done:
--   • No CHECK constraint on the array contents. Headers are free-form
--     strings on the tenant's xlsx; Postgres can't validate against a
--     dynamic catalogue.
--   • No index. Reads happen at registry-warm time only (per-tenant
--     fan-out under the existing tenant_field_mappings_tenant_idx).
-- ============================================================================

ALTER TABLE tenant_field_mappings
  ADD COLUMN IF NOT EXISTS fallback_columns text[] NOT NULL DEFAULT '{}'::text[];
--> statement-breakpoint

-- Update the analytics-role grant to include the new column. Defensive:
-- only granted at table-level today (no per-column gating on this table),
-- so this is a no-op when role doesn't exist; left here for parity with
-- 0043 / 0045 patterns.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clearai_readonly') THEN
    GRANT SELECT (fallback_columns) ON tenant_field_mappings TO clearai_readonly;
  END IF;
END
$$;
--> statement-breakpoint
