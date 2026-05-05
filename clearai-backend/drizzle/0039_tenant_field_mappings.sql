-- ============================================================================
-- 0039_tenant_field_mappings.sql
--
-- Per-tenant column-mapping rules consumed by the generic mapper at
-- src/modules/tenants/tenant-line-item.mapper.ts. One row per
-- (tenant, canonical_field) — defines which source column in the tenant's
-- commercial-invoice file feeds which field of CanonicalLineItem, plus the
-- optional transform and default to apply.
--
-- Why data, not code:
--   • Onboarding a new carrier is N rows here, not a TypeScript edit.
--   • The single mapper in src/modules/tenants/tenant-line-item.mapper.ts
--     iterates these rows at runtime — there is no per-tenant TS branch.
--   • The set of canonical_field values is closed (it matches the
--     CanonicalLineItem TS type). We enforce that closure at app load via
--     the tenant-config.registry validation, NOT a CHECK constraint, because
--     extending the canonical shape would otherwise force a migration on
--     every new field. Format invariants (regex, transform enum) DO get
--     CHECKs — those are stable.
--
-- What's safe:
--   • Idempotent (CREATE TABLE IF NOT EXISTS).
--   • No data migration; fresh table.
--
-- What's intentionally not done:
--   • No CHECK on canonical_field (open-ended TS type — see above).
--   • No FK from canonical_field to anywhere (it's a TS-side enum).
-- ============================================================================

CREATE TABLE IF NOT EXISTS tenant_field_mappings (
  id                uuid         PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Owning tenant slug. FK to tenants(slug); ON DELETE RESTRICT — never
  -- silently nuke a tenant's mapping rules.
  tenant            varchar(32)  NOT NULL,

  -- Verbatim header from the tenant's source file (case-sensitive — exactly
  -- what arrives in the CSV/XLSX). The mapper looks up source_column in the
  -- parsed-row dictionary; mismatches fail fast.
  source_column     text         NOT NULL,

  -- Field name on CanonicalLineItem that this column feeds, e.g. 'description',
  -- 'valueAmount', 'currencyCode'. Validated TS-side at registry load.
  canonical_field   varchar(64)  NOT NULL,

  -- Whether the row must be populated; missing required fields raise
  -- RequiredFieldMissingError in the mapper (no silent default fallback).
  required          boolean      NOT NULL DEFAULT false,

  -- Optional transform applied after lookup, before default substitution.
  -- Closed enum — must mirror TransformKind in TS.
  transform         varchar(16),

  -- Default substituted when the source cell is empty AND required=false.
  -- NULL means "no default; downstream sees null".
  default_value     text,

  CONSTRAINT tenant_field_mappings_tenant_fk
    FOREIGN KEY (tenant) REFERENCES tenants(slug) ON DELETE RESTRICT,

  CONSTRAINT tenant_field_mappings_tenant_format_chk
    CHECK (tenant ~ '^[a-z][a-z0-9_]{2,31}$'),

  CONSTRAINT tenant_field_mappings_transform_chk
    CHECK (transform IS NULL OR transform IN ('trim', 'uppercase', 'lowercase')),

  CONSTRAINT tenant_field_mappings_canonical_field_format_chk
    CHECK (canonical_field ~ '^[a-zA-Z][a-zA-Z0-9_]*$'),

  -- One mapping per (tenant, canonical_field) — a tenant can't have two
  -- source columns both feeding `description`. If they need to merge,
  -- that's transform/concatenation logic, not a duplicate row.
  CONSTRAINT tenant_field_mappings_tenant_canonical_uniq
    UNIQUE (tenant, canonical_field)
);
--> statement-breakpoint

-- B-tree on the FK column for cascade-aware deletes / per-tenant fetches.
CREATE INDEX IF NOT EXISTS tenant_field_mappings_tenant_idx
  ON tenant_field_mappings (tenant);
--> statement-breakpoint
