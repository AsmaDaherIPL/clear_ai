-- ============================================================================
-- 0055_uom_lookup.sql
--
-- Replace the "every item is uom 7" hardcoded constants with a real
-- per-row lookup. Each canonical line item carries its own `uom` value
-- (PIECE / KG / BOX / etc.) — the renderer should translate that through
-- a Tabadul code lookup, not emit a flat 7.
--
-- Seed `uom` rows in tabadul_codes for the values we've seen so far. More
-- can be added as Naqel ships rows with new uoms; the renderer fails loud
-- (lookupOrThrow) on a missing translation, which is correct.
--
-- Then drop the now-dead constants from operator_constants.
-- ============================================================================

INSERT INTO tabadul_codes (code_type, source_value, canonical_value, metadata) VALUES
  ('uom', 'PIECE', '7',  '{"label": "piece"}'::jsonb),
  ('uom', 'PCS',   '7',  '{"label": "piece (alt spelling)"}'::jsonb),
  ('uom', 'EA',    '7',  '{"label": "each (treated as piece)"}'::jsonb),
  ('uom', 'KG',    '1',  '{"label": "kilogram"}'::jsonb),
  ('uom', 'BOX',   '2',  '{"label": "box"}'::jsonb),
  ('uom', 'CTN',   '2',  '{"label": "carton (treated as box)"}'::jsonb),
  ('uom', 'SET',   '11', '{"label": "set"}'::jsonb),
  ('uom', 'PAIR',  '12', '{"label": "pair"}'::jsonb)
ON CONFLICT (code_type, source_value) DO NOTHING;

-- These are no longer needed — the renderer reads c.uom and translates via tabadul_codes.
DELETE FROM operator_constants
 WHERE key IN ('item_invoice_measurement_unit', 'item_international_measurement_unit');
