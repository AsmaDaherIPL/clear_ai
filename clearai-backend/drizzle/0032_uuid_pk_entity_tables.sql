-- ============================================================================
-- 0032_uuid_pk_entity_tables.sql
--
-- Adds a UUID primary key (per-row opaque identity) to the three entity
-- tables that today key on natural columns. The natural keys stay as
-- UNIQUE NOT NULL so existing FKs and lookups are unaffected.
--
-- Tables in scope:
--   • hs_code_display       (was code char(12) PK)
--   • hs_code_search        (was code char(12) PK)
--   • tenant_code_overrides (was composite (tenant, source_code_norm) PK)
--
-- Lookup / config tables intentionally NOT touched:
--   • setup_meta             (key text PK — config map; key IS the identity)
--   • procedure_codes        (code varchar(8) PK — small lookup table)
--
-- The UUIDv7 application-side default (newId() from src/util/uuid.ts) is
-- preferred for new INSERTs; the DB default gen_random_uuid() (UUIDv4)
-- fills the existing rows during this backfill — both are valid 16-byte
-- UUIDs so the mix is harmless. Once PG 18 lands we can swap the DB
-- default to native uuidv7().
-- ============================================================================

-- ─── hs_code_display ─────────────────────────────────────────────────────────

ALTER TABLE hs_code_display
  ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
--> statement-breakpoint

ALTER TABLE hs_code_display
  DROP CONSTRAINT hs_code_display_pkey;
--> statement-breakpoint

ALTER TABLE hs_code_display
  ADD PRIMARY KEY (id);
--> statement-breakpoint

-- code stays as the FK target back to hs_codes(code); enforce uniqueness
-- so existing 1:1 invariant holds.
ALTER TABLE hs_code_display
  ADD CONSTRAINT hs_code_display_code_uniq UNIQUE (code);
--> statement-breakpoint

-- ─── hs_code_search ──────────────────────────────────────────────────────────

ALTER TABLE hs_code_search
  ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
--> statement-breakpoint

ALTER TABLE hs_code_search
  DROP CONSTRAINT hs_code_search_pkey;
--> statement-breakpoint

ALTER TABLE hs_code_search
  ADD PRIMARY KEY (id);
--> statement-breakpoint

ALTER TABLE hs_code_search
  ADD CONSTRAINT hs_code_search_code_uniq UNIQUE (code);
--> statement-breakpoint

-- ─── tenant_code_overrides ──────────────────────────────────────────────────

ALTER TABLE tenant_code_overrides
  ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
--> statement-breakpoint

ALTER TABLE tenant_code_overrides
  DROP CONSTRAINT tenant_code_overrides_pkey;
--> statement-breakpoint

ALTER TABLE tenant_code_overrides
  ADD PRIMARY KEY (id);
--> statement-breakpoint

-- The composite (tenant, source_code_norm) IS the natural identity for
-- this row — preserve as UNIQUE so two tenants can both have the same
-- source_code (different rows) but a single tenant cannot have duplicate
-- sources. This is what the old composite PK enforced.
ALTER TABLE tenant_code_overrides
  ADD CONSTRAINT tenant_code_overrides_tenant_source_uniq
    UNIQUE (tenant, source_code_norm);
--> statement-breakpoint
