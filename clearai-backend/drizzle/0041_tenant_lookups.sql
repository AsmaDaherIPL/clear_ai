-- ============================================================================
-- 0041_tenant_lookups.sql
--
-- Per-tenant value-translation tables in one wide table:
--   lookup_type         what kind of value this row maps
--                       e.g. 'city', 'currency', 'country_of_origin', 'port',
--                            'source_company_port', 'tabadul_country_code'
--   source_value        the verbatim value as it arrives in the tenant's file
--   canonical_value     the value the rest of ClearAI uses
--                       (ISO-3166 alpha-2, ISO-4217, ZATCA port code, etc.)
--   metadata            jsonb — optional extras (e.g. original Arabic spelling)
--
-- One table over many narrow tables because:
--   • The set of lookup_types is open-ended (Naqel today: 6 mapping sheets;
--     Aramex / DHL will add more). A new sheet means rows here, not a new table.
--   • The hot-path read is "given (tenant, lookup_type, source_value), what
--     is canonical_value?" — covered by the natural-key UNIQUE / PK index.
--
-- What's safe:
--   • Idempotent (CREATE TABLE IF NOT EXISTS).
--   • No data migration. Seed lives in src/scripts/seed-tenant-lookups.ts
--     which reads the Naqel xlsx and bulk-inserts.
--
-- What's intentionally not done:
--   • No CHECK on lookup_type values (open-ended on purpose). Format CHECK
--     enforces snake_case so we don't get 'City' / 'city' / 'CITY' splits.
--   • No FK from canonical_value to anywhere — different lookup_types map
--     to different downstream domains, no single FK target makes sense.
-- ============================================================================

CREATE TABLE IF NOT EXISTS tenant_lookups (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Owning tenant slug. FK to tenants(slug); ON DELETE RESTRICT.
  tenant          varchar(32)  NOT NULL,

  -- snake_case lookup category, e.g. 'city', 'currency', 'country_of_origin'.
  lookup_type     varchar(64)  NOT NULL,

  -- Verbatim source value as it arrives in the tenant's invoice file.
  -- Trimmed but otherwise unmodified — we want to match exactly what the
  -- mapper sees post-trim, no case folding.
  source_value    text         NOT NULL,

  -- Canonical value the rest of ClearAI consumes.
  canonical_value text         NOT NULL,

  -- Optional extras (e.g. original Arabic spelling, alternate codes).
  metadata        jsonb        NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT tenant_lookups_tenant_fk
    FOREIGN KEY (tenant) REFERENCES tenants(slug) ON DELETE RESTRICT,

  CONSTRAINT tenant_lookups_tenant_format_chk
    CHECK (tenant ~ '^[a-z][a-z0-9_]{2,31}$'),

  CONSTRAINT tenant_lookups_type_format_chk
    CHECK (lookup_type ~ '^[a-z][a-z0-9_]{0,63}$'),

  -- metadata must be a JSON object, never an array or scalar — same shape
  -- assumption the readers rely on.
  CONSTRAINT tenant_lookups_metadata_object_chk
    CHECK (jsonb_typeof(metadata) = 'object'),

  -- One canonical_value per (tenant, lookup_type, source_value).
  CONSTRAINT tenant_lookups_natural_uniq
    UNIQUE (tenant, lookup_type, source_value)
);
--> statement-breakpoint

-- Hot-path read index: the natural-key UNIQUE already creates a btree on
-- (tenant, lookup_type, source_value), so no extra index needed there.
-- Per-tenant fan-out queries ("all city mappings for naqel") use the FK col.
CREATE INDEX IF NOT EXISTS tenant_lookups_tenant_type_idx
  ON tenant_lookups (tenant, lookup_type);
--> statement-breakpoint
