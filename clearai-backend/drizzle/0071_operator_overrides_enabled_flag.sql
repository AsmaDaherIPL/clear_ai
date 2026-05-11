-- Adds per-operator switch for the override mechanism. When false, Track B
-- skips lookupTenantOverride() and merchant code flows straight into the
-- codebook walk. Defaults to true so existing behaviour is preserved for
-- every current operator; flip to false per-operator when the override
-- list is operationally untrusted (e.g. ZATCA-pass workarounds rather
-- than true codebook corrections).
--
-- Companion to min_confidence_band (0067); same table, same shape.

ALTER TABLE operator_declaration_config
  ADD COLUMN IF NOT EXISTS overrides_enabled boolean NOT NULL DEFAULT true;
