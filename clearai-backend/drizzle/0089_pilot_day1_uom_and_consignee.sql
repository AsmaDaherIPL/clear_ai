-- ============================================================================
-- 0089_pilot_day1_uom_and_consignee.sql
--
-- Two pilot blockers surfaced by 2026-05-17 day-1 data:
--
-- 1) UoM lookups — Naqel's actual feed uses values our `tabadul_codes.uom`
--    rows don't cover. Audit of all 288,742 day-1 line items found 8
--    missing source values:
--      PCE              x 276,154  (95.6% of the day's rows)
--      EACH             x   1,210
--      PIECESPIECES     x   1,002  (Naqel feed concat artefact)
--      UNITS            x     153
--      BAG              x       9
--      PACKAGE          x       3
--      BAGS             x       3
--      BOX - BAG        x       3
--
--    Cross-referenced with Naqel's own decl XMLs: Naqel maps every UoM
--    (including KG, BOX) to Tabadul code '7' (piece) inside its LV catch-all
--    declarations. We don't bit-mirror that here — Tabadul codes are an
--    operator-agnostic universal table; the right place to flatten-to-piece
--    is the LV-catch-all renderer policy (separate concern, not in this
--    migration). Instead we add semantically-correct entries:
--      piece variants -> '7'
--      bag/package    -> '2' (closest semantic match in the existing seed)
--
-- 2) consigneeNationalId requirement — the Naqel feed has ~10k rows
--    (~3.5%) with null ConsigneeNationalID. Naqel's own LV declarations
--    carry zero consignee fields at all (no name, no national ID, no
--    address) — they're aggregated catch-all decls. Our backend's
--    "required" enforcement is over-strict for reproducing this format.
--    Drop required=true on the field-mapping universally.
-- ============================================================================

-- 1) UoM lookups
INSERT INTO tabadul_codes (code_type, source_value, canonical_value, metadata) VALUES
  ('uom', 'PCE',          '7', '{"label": "piece (Naqel feed shorthand)"}'::jsonb),
  ('uom', 'EACH',         '7', '{"label": "each (piece variant)"}'::jsonb),
  ('uom', 'PIECESPIECES', '7', '{"label": "Naqel feed concat artefact, treated as piece"}'::jsonb),
  ('uom', 'UNITS',        '7', '{"label": "units (treated as piece)"}'::jsonb),
  ('uom', 'BAG',          '2', '{"label": "bag (treated as box)"}'::jsonb),
  ('uom', 'BAGS',         '2', '{"label": "bags (treated as box)"}'::jsonb),
  ('uom', 'PACKAGE',      '2', '{"label": "package (treated as box)"}'::jsonb),
  ('uom', 'BOX - BAG',    '2', '{"label": "box-bag (treated as box)"}'::jsonb)
ON CONFLICT (code_type, source_value) DO NOTHING;

-- 2) consigneeNationalId — drop required across all operators.
-- Naqel's LV catch-all decls don't carry consignee fields. Other operators
-- can re-enable later if their data shape needs it.
UPDATE operator_field_mappings
   SET required = false
 WHERE canonical_field = 'consigneeNationalId';
