-- ============================================================================
-- 0094_relax_hv_item_count.sql
--
-- Allow multi-item HV declarations.
--
-- HV/LV is a per-SHIPMENT (AWB) decision: an AWB whose summed value exceeds
-- the threshold is HV, and ALL of that AWB's items belong in its single HV
-- declaration regardless of count. The bundler (bundleByAwb) already groups
-- every HV AWB's items into one HV_STANDALONE bundle.
--
-- The renderer's matching 1-item guard was removed in sha-bae5508
-- (declaration.template.ts). This migration removes the DB-level twin:
-- batch_filings_strategy_count_consistency_chk enforced
--   HV_STANDALONE => item_count = 1
-- which rejected the insert of any multi-item HV filing even after the
-- renderer produced a valid multi-item XML. Surfaced by the 2026-05-18 HV
-- pilot: NQM26051845960 AWB 407426862 (4 items) and 279312459 (2 items),
-- both > 1000 SAR shipment total. Naqel's own filings confirm multi-item HV
-- is valid (NQD26051967682 carries 2 items in one HV declaration).
--
-- New rule: both strategies require item_count >= 1. The dedicated
-- positivity constraint (batch_filings_item_count_pos_chk, item_count >= 1)
-- already exists, so the strategy-count consistency constraint becomes a
-- no-op once HV no longer pins to exactly 1 — we drop it outright rather
-- than re-issue a tautology.
-- ============================================================================

ALTER TABLE batch_filings
  DROP CONSTRAINT IF EXISTS batch_filings_strategy_count_consistency_chk;
