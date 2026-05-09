-- 0063_operator_declaration_config.sql
--
-- Consolidate every per-operator render default into one table:
--
--   operator_declaration_config (1:1 with operators)
--     • ZATCA submitter credentials (was operators.zatca_*, added in 0062)
--     • Envelope constants (was global zatca_declaration_defaults table)
--     • Consignee-address defaults (was operators.default_consignee_address jsonb)
--
-- After this migration:
--   - operators.zatca_submitter_carrier_id     DROPPED
--   - operators.zatca_submitter_name           DROPPED
--   - operators.zatca_declaration_namespace    DROPPED
--   - operators.default_consignee_address      DROPPED
--   - zatca_declaration_defaults table         DROPPED
--
-- Backfill copies the existing values into the new row per operator;
-- envelope constants come from the global table seeded in 0053.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Create the table
-- ---------------------------------------------------------------------------
CREATE TABLE operator_declaration_config (
  operator_id uuid PRIMARY KEY REFERENCES operators(id) ON DELETE CASCADE,

  -- ZATCA submitter (was operators.zatca_*)
  zatca_submitter_carrier_id   varchar(32),
  zatca_submitter_name         text,
  zatca_declaration_namespace  text,

  -- Envelope constants (was zatca_declaration_defaults)
  declaration_type             smallint    NOT NULL DEFAULT 2,
  final_country                varchar(8)  NOT NULL DEFAULT 'SA',
  inspection_group_id          smallint    NOT NULL DEFAULT 10,
  payment_method               smallint    NOT NULL DEFAULT 1,
  invoice_seq_no               smallint    NOT NULL DEFAULT 1,
  invoice_type_id              smallint    NOT NULL DEFAULT 5,
  invoice_payment_method_id    smallint    NOT NULL DEFAULT 1,
  payment_document_status_id   smallint    NOT NULL DEFAULT 0,
  deal_value                   smallint    NOT NULL DEFAULT 1,
  item_unit_per_packages       smallint    NOT NULL DEFAULT 1,
  item_duty_type_id            smallint    NOT NULL DEFAULT 1,
  express_transport_type       smallint    NOT NULL DEFAULT 4,
  express_add_country_code     smallint    NOT NULL DEFAULT 100,
  express_country              smallint    NOT NULL DEFAULT 100,

  -- Consignee address default (was operators.default_consignee_address jsonb)
  consignee_default_city_code  varchar(8),
  consignee_default_zip_code   varchar(8),
  consignee_default_po_box     varchar(8),
  consignee_default_street_ar  text,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 2. Backfill — one row per operator
-- ---------------------------------------------------------------------------
-- Done in two steps so the address-jsonb backfill can be conditional on
-- the column actually existing on the local schema (some envs ran 0056
-- as a no-op; the typed columns just default to NULL there).
DO $$
DECLARE
  has_addr boolean;
  has_defaults_table boolean;
  sql_text text;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'operators' AND column_name = 'default_consignee_address'
  ) INTO has_addr;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'zatca_declaration_defaults'
  ) INTO has_defaults_table;

  IF has_defaults_table THEN
    sql_text := $sql$
      INSERT INTO operator_declaration_config (
        operator_id,
        zatca_submitter_carrier_id, zatca_submitter_name, zatca_declaration_namespace,
        declaration_type, final_country, inspection_group_id, payment_method,
        invoice_seq_no, invoice_type_id, invoice_payment_method_id,
        payment_document_status_id, deal_value, item_unit_per_packages,
        item_duty_type_id, express_transport_type, express_add_country_code,
        express_country
      )
      SELECT
        o.id,
        o.zatca_submitter_carrier_id, o.zatca_submitter_name, o.zatca_declaration_namespace,
        COALESCE((SELECT value::smallint FROM zatca_declaration_defaults WHERE key = 'declaration_type'),         2),
        COALESCE((SELECT value         FROM zatca_declaration_defaults WHERE key = 'final_country'),              'SA'),
        COALESCE((SELECT value::smallint FROM zatca_declaration_defaults WHERE key = 'inspection_group_id'),      10),
        COALESCE((SELECT value::smallint FROM zatca_declaration_defaults WHERE key = 'payment_method'),           1),
        COALESCE((SELECT value::smallint FROM zatca_declaration_defaults WHERE key = 'invoice_seq_no'),           1),
        COALESCE((SELECT value::smallint FROM zatca_declaration_defaults WHERE key = 'invoice_type_id'),          5),
        COALESCE((SELECT value::smallint FROM zatca_declaration_defaults WHERE key = 'invoice_payment_method_id'), 1),
        COALESCE((SELECT value::smallint FROM zatca_declaration_defaults WHERE key = 'payment_document_status_id'), 0),
        COALESCE((SELECT value::smallint FROM zatca_declaration_defaults WHERE key = 'deal_value'),               1),
        COALESCE((SELECT value::smallint FROM zatca_declaration_defaults WHERE key = 'item_unit_per_packages'),   1),
        COALESCE((SELECT value::smallint FROM zatca_declaration_defaults WHERE key = 'item_duty_type_id'),        1),
        COALESCE((SELECT value::smallint FROM zatca_declaration_defaults WHERE key = 'express_transport_type'),   4),
        COALESCE((SELECT value::smallint FROM zatca_declaration_defaults WHERE key = 'express_add_country_code'), 100),
        COALESCE((SELECT value::smallint FROM zatca_declaration_defaults WHERE key = 'express_country'),          100)
      FROM operators o;
    $sql$;
  ELSE
    sql_text := $sql$
      INSERT INTO operator_declaration_config (
        operator_id,
        zatca_submitter_carrier_id, zatca_submitter_name, zatca_declaration_namespace
      )
      SELECT o.id, o.zatca_submitter_carrier_id, o.zatca_submitter_name, o.zatca_declaration_namespace
      FROM operators o;
    $sql$;
  END IF;
  EXECUTE sql_text;

  IF has_addr THEN
    EXECUTE $sql$
      UPDATE operator_declaration_config c
         SET consignee_default_city_code = o.default_consignee_address->>'cityCode',
             consignee_default_zip_code  = o.default_consignee_address->>'zipCode',
             consignee_default_po_box    = o.default_consignee_address->>'poBox',
             consignee_default_street_ar = o.default_consignee_address->>'streetAr'
        FROM operators o
       WHERE c.operator_id = o.id
         AND o.default_consignee_address IS NOT NULL;
    $sql$;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Drop migrated columns + the now-redundant table
-- ---------------------------------------------------------------------------
ALTER TABLE operators
  DROP COLUMN IF EXISTS zatca_submitter_carrier_id,
  DROP COLUMN IF EXISTS zatca_submitter_name,
  DROP COLUMN IF EXISTS zatca_declaration_namespace,
  DROP COLUMN IF EXISTS default_consignee_address;

DROP TABLE IF EXISTS zatca_declaration_defaults;

COMMIT;
