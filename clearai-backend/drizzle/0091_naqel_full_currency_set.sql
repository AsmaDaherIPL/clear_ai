-- ============================================================================
-- 0091_naqel_full_currency_set.sql
--
-- Supersedes the partial fix in 0090 (BHD only) with the full set of
-- currencies Naqel recognises per their master CurrencyMapping sheet.
--
-- Audit (2026-05-24):
--   Naqel master sheet lists 13 currencies. The existing fx_rates seed
--   (migration 0076) covered USD/AED/GBP/CNY/EUR (5 of the 13). Migration
--   0090 added BHD. This migration adds the remaining 6:
--
--     OMR (Omani Rial)        — USD pegged   ~9.7530 SAR
--     JOD (Jordanian Dinar)   — USD pegged   ~5.2860 SAR
--     LBP (Lebanese Pound)    — floating     ~0.000042 SAR (volatile)
--     EGP (Egyptian Pound)    — floating     ~0.077    SAR (volatile)
--     KWD (Kuwaiti Dinar)     — basket peg   ~12.17    SAR
--     QAR (Qatari Riyal)      — USD pegged   ~1.0300   SAR
--
--   Also re-asserts BHD (idempotent UPDATE if 0090 ran; otherwise insert).
--
-- Out-of-scope:
--   - SAR itself doesn't need an fx_rates row (passthrough, rate=1).
--   - JPY/INR/CAD/AUD/CHF are seeded in 0076 but not in Naqel's master
--     list. Left untouched — harmless extra rows.
--
-- Rates: pegged currencies use SAMA reference rates and are stable for
-- months at a time. Floating currencies (LBP/EGP) are marked 'indicative'
-- in the source column and SHOULD be refreshed weekly by ops; current
-- values are the most recent SAMA indicative rates as of 2026-05-24.
--
-- Idempotent (ON CONFLICT (quote_currency, as_of_date) DO UPDATE).
-- ============================================================================

INSERT INTO fx_rates (quote_currency, rate, as_of_date, source, note)
VALUES
  -- USD-pegged currencies (stable, derived from USD/SAR=3.75 peg)
  ('BHD', 9.94560000, CURRENT_DATE, 'manual_seed', 'USD-pegged (1 BHD = 2.659 USD); SAMA reference 9.9456 SAR/BHD'),
  ('OMR', 9.75300000, CURRENT_DATE, 'manual_seed', 'USD-pegged (1 OMR = 2.6008 USD); SAMA reference 9.7530 SAR/OMR'),
  ('JOD', 5.28900000, CURRENT_DATE, 'manual_seed', 'USD-pegged (1 JOD = 1.4104 USD); SAMA reference 5.2890 SAR/JOD'),
  ('QAR', 1.03000000, CURRENT_DATE, 'manual_seed', 'USD-pegged (1 QAR = 0.2747 USD); SAMA reference 1.0300 SAR/QAR'),
  -- Basket-pegged (slightly less stable than USD pegs but still tight)
  ('KWD', 12.17000000, CURRENT_DATE, 'manual_seed', 'Basket-pegged (1 KWD ~= 3.246 USD); SAMA indicative 12.17 SAR/KWD'),
  -- Free-floating currencies (volatile, refresh weekly)
  ('EGP', 0.07700000, CURRENT_DATE, 'manual_seed', 'indicative; floating, refresh weekly'),
  ('LBP', 0.00004200, CURRENT_DATE, 'manual_seed', 'indicative; floating, extreme volatility, refresh weekly')
ON CONFLICT (quote_currency, as_of_date) DO UPDATE
  SET rate   = EXCLUDED.rate,
      source = EXCLUDED.source,
      note   = EXCLUDED.note;
