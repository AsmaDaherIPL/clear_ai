-- Seed Tabadul currency_code rows from Naqel's CurrencyMapping reference sheet.
--
-- Source: /Users/asma/Desktop/Customs AI/other/naqel-shared-data/Naqel
--         (Fields details + Mapping data).xlsx — sheet 'CurrencyMapping'.
--
-- Tabadul's currency reference data is operator-agnostic (lives in
-- tabadul_codes, no operator_id), but the canonical Tabadul ids are pulled
-- from the carriers' shared lookup since each carrier publishes the same
-- table internally. Naqel's CurrencyMapping is the closest authoritative
-- source we have until ZATCA publishes its own.
--
-- mapping (source_value -> canonical_value):
--   SAR  -> 100   AED  -> 120   USD  -> 410   GBP  -> 521
--   OMR  -> 119   JOD  -> 112   LBP  -> 111   BHD  -> 116
--   EGP  -> 214   KWD  -> 113   CNY  -> 142   QAR  -> 117
--   EUR  -> 950
--
-- ON CONFLICT DO NOTHING: idempotent; pre-existing rows are left alone so
-- a partial seed (or a manual hotfix during the SAR-missing incident) is
-- not overwritten.

INSERT INTO tabadul_codes (code_type, source_value, canonical_value, metadata) VALUES
  ('currency_code', 'SAR', '100', '{"naqel_source_id": 1}'::jsonb),
  ('currency_code', 'AED', '120', '{"naqel_source_id": 2}'::jsonb),
  ('currency_code', 'USD', '410', '{"naqel_source_id": 4}'::jsonb),
  ('currency_code', 'GBP', '521', '{"naqel_source_id": 5}'::jsonb),
  ('currency_code', 'OMR', '119', '{"naqel_source_id": 6}'::jsonb),
  ('currency_code', 'JOD', '112', '{"naqel_source_id": 7}'::jsonb),
  ('currency_code', 'LBP', '111', '{"naqel_source_id": 8}'::jsonb),
  ('currency_code', 'BHD', '116', '{"naqel_source_id": 9}'::jsonb),
  ('currency_code', 'EGP', '214', '{"naqel_source_id": 10}'::jsonb),
  ('currency_code', 'KWD', '113', '{"naqel_source_id": 11}'::jsonb),
  ('currency_code', 'CNY', '142', '{"naqel_source_id": 12}'::jsonb),
  ('currency_code', 'QAR', '117', '{"naqel_source_id": 34}'::jsonb),
  ('currency_code', 'EUR', '950', '{"naqel_source_id": 16}'::jsonb)
ON CONFLICT ON CONSTRAINT tabadul_codes_natural_uniq DO NOTHING;
