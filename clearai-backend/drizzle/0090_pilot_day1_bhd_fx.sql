-- ============================================================================
-- 0090_pilot_day1_bhd_fx.sql
--
-- Day-1 pilot (2026-05-17) surfaced a third unblocker: BHD shipments.
-- Audit of all 288,742 day-1 line items found 4 currencies in use:
--   SAR : 285,215
--   AED :   3,225
--   USD :     264
--   BHD :      38
--
-- The fx_rates seed in migration 0076 covered USD/AED/EUR/GBP/CNY/JPY/INR/
-- CAD/AUD but not BHD. ClearAI's HV/LV partition uses SAR-converted
-- valueAmountSar against the 1000 SAR threshold, so any non-SAR currency
-- without an fx_rate row fails upload with code='fx_rate_missing'.
--
-- BHD is pegged to USD (1 BHD ≈ 2.659 USD), giving a stable SAR rate of
-- approximately 9.9456 SAR per BHD. SAMA reference rate is 9.95 SAR/BHD;
-- using 9.9456 for daily precision.
--
-- Idempotent (ON CONFLICT (quote_currency, as_of_date) DO UPDATE).
-- ============================================================================

INSERT INTO fx_rates (quote_currency, rate, as_of_date, source, note)
VALUES
  ('BHD', 9.94560000, CURRENT_DATE, 'manual_seed', 'BHD pegged to USD (1 BHD = 2.659 USD); 9.9456 SAR per BHD per SAMA reference')
ON CONFLICT (quote_currency, as_of_date) DO UPDATE
  SET rate   = EXCLUDED.rate,
      source = EXCLUDED.source,
      note   = EXCLUDED.note;
