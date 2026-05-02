-- ============================================================================
-- 0026_tenant_code_overrides.sql
--
-- Renames broker_code_mapping → tenant_code_overrides as part of the
-- ADR-0025 split-catalog refactor (commit #2).
--
-- Why rename + restructure rather than ALTER in place:
--   • The semantics changed. The old table was framed as "broker tribal
--     knowledge", but the cross-check (see ADR-0025 evidence) showed that
--     ~56% of mappings translate merchant-supplied INVALID codes (codes that
--     don't exist in ZATCA at all) into valid ZATCA targets. The renamed
--     table reflects this: it is per-tenant rewrite rules from messy input
--     to canonical ZATCA codes.
--   • Multi-tenant from day 1 — a `tenant` column with NO DEFAULT forces
--     every ingest script to explicitly state which tenant's xlsx it
--     parsed. Today only 'naqel'; tomorrow 'aramex', 'dhl', etc.
--   • The slim schema drops 7 noise columns (id, created_at, target_description_ar,
--     unit_per_price, source_row_ref) that nothing reads.
--   • The new self-map check uses rpad(source, 12, '0') <> target so the 42
--     zero-padding self-maps that slipped through the old CHECK in
--     0012 (e.g. "61082100" → "610821000000") are blocked at INSERT time.
--   • source_code_norm is INTENTIONALLY not foreign-keyed to hs_codes —
--     the whole reason the table exists is to handle inputs that do NOT
--     appear in the ZATCA catalog.
--   • target_code IS foreign-keyed to hs_codes — broker overrides must
--     point at codes that exist. ON DELETE RESTRICT means a SABER deletion
--     of a code that is used as an override target fails loudly so the
--     tenant has to re-curate before the deletion lands.
-- ============================================================================

-- 1. Create the new table.
CREATE TABLE IF NOT EXISTS tenant_code_overrides (
  -- Which tenant's rule. NO DEFAULT — every ingest must specify.
  tenant            varchar(32) NOT NULL,

  -- Merchant-supplied code as it arrived in the invoice (digit-only).
  -- NOT FK to hs_codes — ~56% of source codes are not in the catalog.
  source_code_norm  varchar(14) NOT NULL,

  -- Tenant's canonical 12-digit ZATCA target. MUST exist.
  target_code       char(12) NOT NULL,

  PRIMARY KEY (tenant, source_code_norm),

  CONSTRAINT tenant_code_overrides_target_fk
    FOREIGN KEY (target_code) REFERENCES hs_codes(code) ON DELETE RESTRICT,

  CONSTRAINT tenant_code_overrides_source_digits_chk
    CHECK (source_code_norm ~ '^[0-9]+$' AND length(source_code_norm) BETWEEN 4 AND 14),

  -- Reject zero-padding self-maps (e.g. "61082100" → "610821000000").
  -- Catches 42 bugs in the existing Naqel data; the old CHECK only blocked
  -- exact-string matches.
  CONSTRAINT tenant_code_overrides_no_padded_self_map_chk
    CHECK (rpad(source_code_norm::text, 12, '0') <> target_code::text),

  -- Lowercase ASCII tenant names — avoid "Naqel" / "naqel" / "NAQEL"
  -- accidentally splitting one tenant across three logical groups.
  CONSTRAINT tenant_code_overrides_tenant_format_chk
    CHECK (tenant ~ '^[a-z][a-z0-9_]{2,31}$')
);
--> statement-breakpoint

-- Reverse-lookup index ("which inputs route to this target?") for analysis.
CREATE INDEX IF NOT EXISTS tenant_code_overrides_target_idx
  ON tenant_code_overrides(target_code);
--> statement-breakpoint

-- 2. Backfill from the old table under tenant='naqel' (explicit, not via DEFAULT).
--    Skip the 42 zero-padding self-maps that the new CHECK would reject.
INSERT INTO tenant_code_overrides (tenant, source_code_norm, target_code)
SELECT
  'naqel'                 AS tenant,
  client_code_norm        AS source_code_norm,
  target_code
FROM broker_code_mapping
WHERE rpad(client_code_norm::text, 12, '0') <> target_code::text
  -- Defensive: the new FK requires target exists in hs_codes. Old rows
  -- where the broker pointed at a since-deleted/never-existed code get
  -- dropped at backfill rather than failing the migration mid-flight.
  AND EXISTS (SELECT 1 FROM hs_codes h WHERE h.code = broker_code_mapping.target_code)
ON CONFLICT (tenant, source_code_norm) DO NOTHING;
--> statement-breakpoint

-- 3. Drop the old table. All readers were rewritten in the same commit
--    to query tenant_code_overrides; the DROP runs after the application
--    code is updated, so there is no in-flight read against the gone table.
DROP TABLE IF EXISTS broker_code_mapping;
--> statement-breakpoint
