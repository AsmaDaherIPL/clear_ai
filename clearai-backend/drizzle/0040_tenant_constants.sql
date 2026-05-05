-- ============================================================================
-- 0040_tenant_constants.sql
--
-- Per-tenant key/value constants used by the ZATCA Declaration template
-- renderer (and any other tenant-driven config that doesn't belong in the
-- column-mapping table). Examples for Naqel:
--   submitter_carrier_id   "<naqel-static-carrier-id>"
--   submitter_name         "Naqel"
--   default_port_code      "..."
--
-- Why a key/value table instead of strict columns:
--   • The set of constants is open-ended per tenant — adding a new ZATCA
--     envelope field for a new carrier shouldn't require a migration. Adding
--     a row does.
--   • For ClearAI's own infra constants (submitter id, namespace) we still
--     fail-fast at env-load. This table is per-tenant *content*, not infra.
--
-- What's safe:
--   • Idempotent (CREATE TABLE IF NOT EXISTS).
--   • No data migration; fresh table.
--
-- What's intentionally not done:
--   • No CHECK on `key` content (open-ended). Format CHECK enforces snake_case.
--   • No typing of `value` (text). Numeric tunables that need typed access
--     belong on tenants.* columns or in a typed table later — see
--     setup_meta's value_kind/value_numeric pattern (0002) for prior art.
-- ============================================================================

CREATE TABLE IF NOT EXISTS tenant_constants (
  id          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Owning tenant slug. FK to tenants(slug); ON DELETE RESTRICT.
  tenant      varchar(32)  NOT NULL,

  -- Constant key. snake_case enforced by format CHECK so admin-written keys
  -- can't drift across cases ("Submitter_ID" vs "submitter_id").
  key         varchar(64)  NOT NULL,

  -- Free-form text value. The renderer is responsible for any parsing.
  value       text         NOT NULL,

  CONSTRAINT tenant_constants_tenant_fk
    FOREIGN KEY (tenant) REFERENCES tenants(slug) ON DELETE RESTRICT,

  CONSTRAINT tenant_constants_tenant_format_chk
    CHECK (tenant ~ '^[a-z][a-z0-9_]{2,31}$'),

  CONSTRAINT tenant_constants_key_format_chk
    CHECK (key ~ '^[a-z][a-z0-9_]{0,63}$'),

  -- One value per (tenant, key).
  CONSTRAINT tenant_constants_tenant_key_uniq
    UNIQUE (tenant, key)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS tenant_constants_tenant_idx
  ON tenant_constants (tenant);
--> statement-breakpoint
