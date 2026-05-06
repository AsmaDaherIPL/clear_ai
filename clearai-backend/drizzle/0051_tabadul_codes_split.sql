-- ============================================================================
-- 0051_tabadul_codes_split.sql
--
-- Split universal Tabadul reference data out of operator_lookups into its
-- own operator-agnostic table `tabadul_codes`.
--
-- Universal types (currency, country, city, port, customs_gate, uom) are
-- the same regardless of operator — they describe Tabadul's master data.
-- Per-operator types (client_country, client_source_company,
-- destination_station) stay in operator_lookups.
--
-- Existing universal rows under any operator are MOVED into tabadul_codes
-- and de-duped on (code_type, source_value). Per-operator rows stay put.
--
-- After move:
--   tabadul_codes      : id, code_type, source_value, canonical_value, metadata
--                        natural key (code_type, source_value)
--   operator_lookups   : same shape, but only holds operator-specific types
-- ============================================================================

CREATE TABLE IF NOT EXISTS tabadul_codes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_type       varchar(64) NOT NULL,
  source_value    text        NOT NULL,
  canonical_value text        NOT NULL,
  metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT tabadul_codes_metadata_object_chk
    CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT tabadul_codes_code_type_format_chk
    CHECK (code_type ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT tabadul_codes_natural_uniq
    UNIQUE (code_type, source_value)
);

CREATE INDEX IF NOT EXISTS tabadul_codes_code_type_idx
  ON tabadul_codes (code_type);

-- Move universal rows from operator_lookups into tabadul_codes. Use the
-- canonical mapping for operator_lookups.lookup_type -> tabadul_codes.code_type.
-- Names line up 1:1 today (currency_code, country_of_origin, etc.) so we
-- preserve them.
INSERT INTO tabadul_codes (code_type, source_value, canonical_value, metadata)
SELECT DISTINCT ON (lookup_type, source_value)
       lookup_type,
       source_value,
       canonical_value,
       metadata
  FROM operator_lookups
 WHERE lookup_type IN (
   'currency_code',
   'country_of_origin',
   'tabdul_city',
   'port',
   'customs_gate',
   'uom'
 )
 ORDER BY lookup_type, source_value
ON CONFLICT (code_type, source_value) DO NOTHING;

DELETE FROM operator_lookups
 WHERE lookup_type IN (
   'currency_code',
   'country_of_origin',
   'tabdul_city',
   'port',
   'customs_gate',
   'uom'
 );
