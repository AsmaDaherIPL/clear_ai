-- ============================================================================
-- 0082_zatca_lv_invoice_cap.sql
--
-- Two changes to LV bundling tunables, both motivated by the actual ZATCA /
-- Tabadul rule:
--
--   1. Raise ZATCA_BUNDLE_SIZE from 99 -> 9999. The historical 99 was
--      Naqel-side practice carried into the seed, but the spec only caps
--      the *invoice total*, not the item count. Allowing more items per
--      bundle reduces the number of declarations Naqel submits per batch.
--
--   2. Add ZATCA_LV_INVOICE_CAP_SAR (1000). The real LV/HV partition is
--      the per-bundle invoice total: an LV consolidated declaration must
--      have sum(itemCost) strictly less than 1000 SAR. Today the bundler
--      only enforces a per-item HV threshold; once two LV items sum past
--      1000, the rendered invoiceCost violates the spec. The bundler will
--      pack greedily until the running total would reach the cap, then
--      open a new bundle. Cap is exclusive: a bundle of 999.99 is allowed,
--      1000.00 is not (mirror of HV's >= 1000).
--
-- Idempotent (ON CONFLICT). No schema changes; only setup_meta inserts.
-- ============================================================================

INSERT INTO setup_meta (key, value, description, value_kind, value_numeric)
VALUES
  ('ZATCA_BUNDLE_SIZE',         '9999', 'Max items per LV consolidated ZATCA declaration. Raised from 99 (Naqel practice) to 9999 (spec ceiling). Real binding constraint is ZATCA_LV_INVOICE_CAP_SAR.', 'number', 9999),
  ('ZATCA_LV_INVOICE_CAP_SAR',  '1000', 'Per-bundle invoiceCost cap in SAR for LV consolidated declarations. Bundler packs LV items greedily until adding the next item would bring sum(itemCost) to >= this value, then opens a new bundle. Exclusive (mirror of HV threshold''s >= 1000).', 'number', 1000)
ON CONFLICT (key) DO UPDATE
  SET value         = EXCLUDED.value,
      description   = EXCLUDED.description,
      value_kind    = EXCLUDED.value_kind,
      value_numeric = EXCLUDED.value_numeric;
--> statement-breakpoint
