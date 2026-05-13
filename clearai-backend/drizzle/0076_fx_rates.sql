-- 0076_fx_rates.sql
--
-- Currency conversion to SAR for ZATCA declarations.
--
-- ZATCA accepts only SAR-denominated invoices (invoiceCurrency=100). Merchant
-- uploads carry value_amount in their commercial currency (USD, AED, EUR, ...).
-- We convert at parse time using a manually-seeded rate table so every
-- conversion is auditable and replay-stable.
--
-- Manual-seed approach:
--   - Ops runs a CLI / inserts rows to set the current rate per (currency, date).
--   - One row per (quote_currency, as_of_date). The parse stage picks the
--     most recent row at-or-before the batch upload date.
--   - SAR itself is implicit (rate = 1, no row needed).
--
-- Audit:
--   - Every classification row (declaration_run_items.canonical jsonb) carries
--     `valueAmountSar`, `fxRate`, `fxRateAsOf`, `fxRateId` so a replay can
--     reconstruct the exact conversion used.

CREATE TABLE fx_rates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Always 'SAR' in V1. Future-proofed for multi-base if regulator changes.
  base_currency varchar(3)  NOT NULL DEFAULT 'SAR' CHECK (base_currency = 'SAR'),
  -- ISO 4217 3-letter code, uppercase.
  quote_currency varchar(3) NOT NULL CHECK (quote_currency ~ '^[A-Z]{3}$'),
  -- Units of base per 1 quote. e.g. SAR per USD = 3.75 means 1 USD -> 3.75 SAR.
  -- Precision (18,8): enough for 10 trillion units at 8 decimal places.
  rate          numeric(18, 8) NOT NULL CHECK (rate > 0),
  -- The calendar date this rate is valid for (Asia/Riyadh).
  as_of_date    date NOT NULL,
  -- Provenance — 'manual_seed' for V1; future 'sama_daily' / 'ecb' / 'frozen_batch'.
  source        varchar(32) NOT NULL DEFAULT 'manual_seed',
  -- Free-form note for ops (e.g. "SAMA mid-market 14:00 GMT", "frozen for batch X").
  note          text,
  created_at    timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT fx_rates_natural_uniq UNIQUE (quote_currency, as_of_date)
);

CREATE INDEX fx_rates_quote_date_idx ON fx_rates (quote_currency, as_of_date DESC);

-- Seed common currencies at indicative SAMA mid-market rates (2026-05-13).
-- Operations should refresh these weekly via the same INSERT statement with
-- ON CONFLICT (quote_currency, as_of_date) DO UPDATE.
INSERT INTO fx_rates (quote_currency, rate, as_of_date, source, note) VALUES
  ('USD', 3.75000000, CURRENT_DATE, 'manual_seed', 'SAR pegged to USD at ~3.75'),
  ('AED', 1.02080000, CURRENT_DATE, 'manual_seed', 'AED <-> USD peg derived'),
  ('EUR', 4.05000000, CURRENT_DATE, 'manual_seed', 'indicative'),
  ('GBP', 4.72000000, CURRENT_DATE, 'manual_seed', 'indicative'),
  ('CNY', 0.51500000, CURRENT_DATE, 'manual_seed', 'indicative'),
  ('JPY', 0.02400000, CURRENT_DATE, 'manual_seed', 'indicative'),
  ('INR', 0.04400000, CURRENT_DATE, 'manual_seed', 'indicative'),
  ('CAD', 2.71000000, CURRENT_DATE, 'manual_seed', 'indicative'),
  ('AUD', 2.42000000, CURRENT_DATE, 'manual_seed', 'indicative'),
  ('CHF', 4.16000000, CURRENT_DATE, 'manual_seed', 'indicative');
