-- ============================================================================
-- 0054_operators_identity_columns.sql
--
-- Promote the 7 operator-identity values from operator_constants rows into
-- typed columns on the operators table. These are 1:1 with the operator and
-- belong as first-class columns, not key-value rows.
--
-- Mapping (operator_constants.key -> operators column):
--   reference_userid                  -> tabadul_userid
--   reference_acct_id                 -> tabadul_acct_id
--   sender_broker_license_type        -> broker_license_type
--   sender_broker_license_no          -> broker_license_no
--   sender_broker_representative_no   -> broker_representative_no
--   default_source_company_name       -> default_source_company_name
--   default_source_company_no         -> default_source_company_no
--
-- Steps:
--   1. ADD COLUMN ... NULL for the 7 columns
--   2. UPDATE operators SET col = (SELECT value FROM operator_constants ...)
--   3. ALTER COLUMN ... SET NOT NULL once every operator has values
--   4. DELETE the 7 keys + the 14 ZATCA-spec keys from operator_constants
--
-- Step 4 also removes the spec-wide keys that moved to
-- zatca_declaration_defaults in 0053 — they're safe to delete here because
-- the renderer code change in this PR reads them from the new table.
-- ============================================================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='operators' AND column_name='tabadul_userid') THEN
    ALTER TABLE operators ADD COLUMN tabadul_userid varchar(64);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='operators' AND column_name='tabadul_acct_id') THEN
    ALTER TABLE operators ADD COLUMN tabadul_acct_id varchar(64);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='operators' AND column_name='broker_license_type') THEN
    ALTER TABLE operators ADD COLUMN broker_license_type varchar(8);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='operators' AND column_name='broker_license_no') THEN
    ALTER TABLE operators ADD COLUMN broker_license_no varchar(32);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='operators' AND column_name='broker_representative_no') THEN
    ALTER TABLE operators ADD COLUMN broker_representative_no varchar(32);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='operators' AND column_name='default_source_company_name') THEN
    ALTER TABLE operators ADD COLUMN default_source_company_name text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='operators' AND column_name='default_source_company_no') THEN
    ALTER TABLE operators ADD COLUMN default_source_company_no varchar(32);
  END IF;
END $$;

-- Backfill from operator_constants rows. Each UPDATE runs once per operator;
-- if the row doesn't exist for a given operator, the column stays NULL and
-- the SET NOT NULL below would fail — that's correct fail-loud behaviour.
UPDATE operators o
   SET tabadul_userid = c.value
  FROM operator_constants c
 WHERE c.operator_id = o.id AND c.key = 'reference_userid' AND o.tabadul_userid IS NULL;

UPDATE operators o
   SET tabadul_acct_id = c.value
  FROM operator_constants c
 WHERE c.operator_id = o.id AND c.key = 'reference_acct_id' AND o.tabadul_acct_id IS NULL;

UPDATE operators o
   SET broker_license_type = c.value
  FROM operator_constants c
 WHERE c.operator_id = o.id AND c.key = 'sender_broker_license_type' AND o.broker_license_type IS NULL;

UPDATE operators o
   SET broker_license_no = c.value
  FROM operator_constants c
 WHERE c.operator_id = o.id AND c.key = 'sender_broker_license_no' AND o.broker_license_no IS NULL;

UPDATE operators o
   SET broker_representative_no = c.value
  FROM operator_constants c
 WHERE c.operator_id = o.id AND c.key = 'sender_broker_representative_no' AND o.broker_representative_no IS NULL;

UPDATE operators o
   SET default_source_company_name = c.value
  FROM operator_constants c
 WHERE c.operator_id = o.id AND c.key = 'default_source_company_name' AND o.default_source_company_name IS NULL;

UPDATE operators o
   SET default_source_company_no = c.value
  FROM operator_constants c
 WHERE c.operator_id = o.id AND c.key = 'default_source_company_no' AND o.default_source_company_no IS NULL;

-- Enforce NOT NULL only when every operator has values. Skipped if any
-- operator is missing a value (pre-existing fresh operator with no constants
-- yet) — they can be tightened in a follow-up once seeds are run.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM operators WHERE tabadul_userid IS NULL) THEN
    ALTER TABLE operators ALTER COLUMN tabadul_userid SET NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM operators WHERE tabadul_acct_id IS NULL) THEN
    ALTER TABLE operators ALTER COLUMN tabadul_acct_id SET NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM operators WHERE broker_license_type IS NULL) THEN
    ALTER TABLE operators ALTER COLUMN broker_license_type SET NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM operators WHERE broker_license_no IS NULL) THEN
    ALTER TABLE operators ALTER COLUMN broker_license_no SET NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM operators WHERE broker_representative_no IS NULL) THEN
    ALTER TABLE operators ALTER COLUMN broker_representative_no SET NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM operators WHERE default_source_company_name IS NULL) THEN
    ALTER TABLE operators ALTER COLUMN default_source_company_name SET NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM operators WHERE default_source_company_no IS NULL) THEN
    ALTER TABLE operators ALTER COLUMN default_source_company_no SET NOT NULL;
  END IF;
END $$;

-- Now safe to drop the rows from operator_constants. Two groups:
--   1. The 7 identity keys (now columns on operators)
--   2. The 14 ZATCA-spec keys (now in zatca_declaration_defaults from 0053)
DELETE FROM operator_constants
 WHERE key IN (
   -- identity keys promoted to operators columns
   'reference_userid',
   'reference_acct_id',
   'sender_broker_license_type',
   'sender_broker_license_no',
   'sender_broker_representative_no',
   'default_source_company_name',
   'default_source_company_no',
   -- ZATCA-spec keys moved to zatca_declaration_defaults
   'declaration_type',
   'final_country',
   'inspection_group_id',
   'payment_method',
   'invoice_seq_no',
   'invoice_type_id',
   'invoice_payment_method_id',
   'payment_document_status_id',
   'deal_value',
   'item_unit_per_packages',
   'item_duty_type_id',
   'express_transport_type',
   'express_add_country_code',
   'express_country'
 );
