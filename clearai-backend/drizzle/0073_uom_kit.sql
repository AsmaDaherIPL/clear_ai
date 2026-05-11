-- ============================================================================
-- 0073_uom_kit.sql
--
-- Add 'KIT' to the UOM lookup. Headlight restoration kits, makeup kits,
-- starter kits etc. ship as a single multi-component product the merchant
-- describes as a kit. Tabadul has no native "kit" code — map to '11' (set),
-- which is the closest semantic match (a kit IS a set of related items
-- sold together).
-- ============================================================================

INSERT INTO tabadul_codes (code_type, source_value, canonical_value, metadata) VALUES
  ('uom', 'KIT', '11', '{"label": "kit (treated as set)"}'::jsonb)
ON CONFLICT (code_type, source_value) DO NOTHING;
