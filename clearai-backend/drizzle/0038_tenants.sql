-- ============================================================================
-- 0038_tenants.sql
--
-- Adds the `tenants` registry table — the single source of truth for which
-- tenants exist, their display names, and the per-tenant tunables that drive
-- ZATCA bundling (bundle_size, hv_threshold_sar) for batch declaration.
--
-- Why a registry table now:
--   • The existing tenant_code_overrides table (0026) carries `tenant
--     varchar(32)` strings with no central registry. Onboarding a new tenant
--     today is "insert rows under a new slug and hope nobody typos it."
--   • BatchPlumber needs per-tenant tunables (bundle_size, hv_threshold_sar)
--     and FK targets so tenant_field_mappings / tenant_constants /
--     tenant_lookups / batches can RESTRICT-cascade on tenant deletion.
--   • Tenants are config, not entities the app spawns at runtime — but rule 1
--     of the schema-rules contract mandates uuid PKs on every table. So:
--       id   uuid PRIMARY KEY (synthetic identity)
--       slug varchar(32) UNIQUE NOT NULL  (FK target for the rest of the
--                                          tenant-scoped tables)
--
-- What's safe:
--   • Idempotent (CREATE TABLE IF NOT EXISTS, CREATE TRIGGER drop-then-create).
--   • No data migration — fresh table, no backfill from anywhere.
--   • Existing tenant_code_overrides rows are NOT FK'd to this table in this
--     migration; the convention `tenant varchar(32)` was free-form before
--     this point. A follow-up migration can FK it once we audit values.
--
-- What's intentionally not done:
--   • No FK from tenant_code_overrides(tenant) -> tenants(slug). That table
--     pre-dates this registry and adding the FK would either fail (orphan
--     rows) or silently insert a 'naqel' parent. We pick "explicit follow-up"
--     over "implicit insert", per the no-silent-fallbacks rule.
--   • No seed of the 'naqel' tenant row here. Seeds live in
--     src/scripts/seed-tenants.ts (Phase 2) — kept out of migrations so
--     migration replay never depends on application logic.
-- ============================================================================

CREATE TABLE IF NOT EXISTS tenants (
  id                uuid         PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Lowercase ASCII slug, FK target for every tenant-scoped table.
  -- Matches the convention frozen by tenant_code_overrides (0026).
  slug              varchar(32)  NOT NULL,

  -- Human-readable display name shown in admin UIs / audit logs.
  display_name      text         NOT NULL,

  -- ZATCA Declaration LV chunk size. Naqel ships at 99 by their integration
  -- guide; other carriers will differ. Bounded 1..999 because anything outside
  -- that range is almost certainly a config error (a 0 would produce empty
  -- bundles, > 999 violates ZATCA's per-declaration item ceiling).
  bundle_size       int          NOT NULL DEFAULT 99,

  -- HV partition threshold in SAR. Items whose value_amount >= this threshold
  -- get one declaration per item; everything below gets bundled into chunks
  -- of bundle_size. numeric(12,2) — never doublePrecision for money.
  hv_threshold_sar  numeric(12,2) NOT NULL DEFAULT 1000.00,

  -- Whether the tenant is currently allowed to submit batches. Defaults to
  -- false so a freshly-inserted row can't accidentally accept production
  -- traffic before its mappings + constants + lookups are in place.
  active            boolean      NOT NULL DEFAULT false,

  created_at        timestamptz  NOT NULL DEFAULT now(),
  updated_at        timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT tenants_slug_uniq UNIQUE (slug),

  CONSTRAINT tenants_slug_format_chk
    CHECK (slug ~ '^[a-z][a-z0-9_]{2,31}$'),

  CONSTRAINT tenants_bundle_size_range_chk
    CHECK (bundle_size BETWEEN 1 AND 999),

  CONSTRAINT tenants_hv_threshold_nonneg_chk
    CHECK (hv_threshold_sar >= 0)
);
--> statement-breakpoint

-- Generic updated_at touch function. Reused by every batch-domain table that
-- carries an updated_at column (tenants, batches, batch_items). We add a
-- separate function (not setup_meta_touch_updated_at from 0002) because the
-- existing one is named for a single table; a generic name lets later
-- migrations attach it to new tables without ambiguity.
CREATE OR REPLACE FUNCTION batches_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS tenants_touch_updated_at_trg ON tenants;
--> statement-breakpoint

CREATE TRIGGER tenants_touch_updated_at_trg
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION batches_touch_updated_at();
--> statement-breakpoint
