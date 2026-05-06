-- ============================================================================
-- 0056_operators_consignee_address_jsonb.sql
--
-- Move the 3 address-shaped operator_constants into a single jsonb column
-- on operators. The 4 fields (cityCode, zipCode, poBox, streetAr) describe
-- one address; they should travel together.
--
--   express_default_city  -> default_consignee_address->>'cityCode'
--   express_zip_code      -> default_consignee_address->>'zipCode'
--   express_po_box        -> default_consignee_address->>'poBox'
--   (no source today)     -> default_consignee_address->>'streetAr' (NULL)
--
-- After this PR, these constants are gone. The renderer's per-row fallback
-- chain reads canonical.consigneeAddress.<field> first, then falls back to
-- operator.defaultConsigneeAddress.<field>, then throws.
-- ============================================================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='operators' AND column_name='default_consignee_address') THEN
    ALTER TABLE operators ADD COLUMN default_consignee_address jsonb;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='operators_default_consignee_address_object_chk') THEN
    ALTER TABLE operators
      ADD CONSTRAINT operators_default_consignee_address_object_chk
      CHECK (default_consignee_address IS NULL OR jsonb_typeof(default_consignee_address) = 'object');
  END IF;
END $$;

-- Backfill from operator_constants. Only operators that have at least one of
-- the 3 source rows get a populated default; others stay NULL.
UPDATE operators o
   SET default_consignee_address = jsonb_strip_nulls(jsonb_build_object(
     'cityCode', (SELECT value FROM operator_constants WHERE operator_id = o.id AND key = 'express_default_city'),
     'zipCode',  (SELECT value FROM operator_constants WHERE operator_id = o.id AND key = 'express_zip_code'),
     'poBox',    (SELECT value FROM operator_constants WHERE operator_id = o.id AND key = 'express_po_box'),
     'streetAr', NULL
   ))
 WHERE o.default_consignee_address IS NULL
   AND EXISTS (
     SELECT 1 FROM operator_constants
      WHERE operator_id = o.id
        AND key IN ('express_default_city', 'express_zip_code', 'express_po_box')
   );

-- The 3 address rows are now redundant.
DELETE FROM operator_constants
 WHERE key IN ('express_default_city', 'express_zip_code', 'express_po_box');
