-- ============================================================================
-- 0053_zatca_declaration_defaults.sql
--
-- ZATCA-spec defaults that fill slots in the saudiEDI envelope. These values
-- are determined by the ZATCA Declaration spec, NOT by which operator is
-- submitting — every broker filing through Tabadul uses the same values.
--
-- Previously these lived as rows in operator_constants under each operator,
-- which polluted per-operator config with copies of spec-wide defaults.
-- Move them to a dedicated, operator-agnostic table.
--
-- The 14 keys seeded here mirror what was in operator_constants for naqel.
-- Comments document the XML element each key fills.
--
-- This migration ONLY creates the table and seeds defaults. The matching
-- DELETE from operator_constants happens in migration 0054 once we've
-- backfilled the operator-identity columns and removed those rows safely.
-- ============================================================================

CREATE TABLE IF NOT EXISTS zatca_declaration_defaults (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key   varchar(64) NOT NULL,
  value text        NOT NULL,
  CONSTRAINT zatca_declaration_defaults_key_uniq UNIQUE (key),
  CONSTRAINT zatca_declaration_defaults_key_format_chk
    CHECK (key ~ '^[a-z][a-z0-9_]*$')
);

INSERT INTO zatca_declaration_defaults (key, value) VALUES
  ('declaration_type',                    '2'),    -- <decsub:declarationType>
  ('final_country',                       'SA'),   -- <decsub:finalCountry>
  ('inspection_group_id',                 '10'),   -- <decsub:inspectionGroupID>
  ('payment_method',                      '1'),    -- <decsub:paymentMethod>
  ('invoice_seq_no',                      '1'),    -- <decsub:invoiceSeqNo> (always 1; one invoice per declaration)
  ('invoice_type_id',                     '5'),    -- <deccm:invoiceType>
  ('invoice_payment_method_id',           '1'),    -- <deccm:invoicePayment>
  ('payment_document_status_id',          '0'),    -- <deccm:paymentDocumentsStatus>
  ('deal_value',                          '1'),    -- <deccm:deal>
  ('item_unit_per_packages',              '1'),    -- <deccm:unitPerPackages>
  ('item_duty_type_id',                   '1'),    -- <deccm:itemDutyType>
  ('express_transport_type',              '4'),    -- <deccm:transportType> (air)
  ('express_add_country_code',            '100'),  -- <deccm:addCtryCd> (SA Tabadul code)
  ('express_country',                     '100')   -- <deccm:country>     (SA Tabadul code)
ON CONFLICT (key) DO NOTHING;
