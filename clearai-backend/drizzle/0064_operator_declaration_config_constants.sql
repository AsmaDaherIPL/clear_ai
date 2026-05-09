-- 0064_operator_declaration_config_constants.sql
--
-- Final consolidation: pull the last 3 per-operator constants out of
-- the operator_constants key/value table into typed columns on
-- operator_declaration_config, then drop the operator_constants table.
--
-- Keys migrated:
--   default_reg_port_code   → default_reg_port_code (varchar)
--   default_carrier_prefix  → default_carrier_prefix (varchar, optional override)
--   doc_ref_prefix          → doc_ref_prefix (varchar, e.g. 'NQD')
--
-- After this migration, every per-operator declaration default lives on
-- operator_declaration_config. The key/value table is gone — adding a
-- new default means adding a typed column, not a magic string.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Add the 3 columns to operator_declaration_config
-- ---------------------------------------------------------------------------
ALTER TABLE operator_declaration_config
  ADD COLUMN default_reg_port_code   varchar(8),
  ADD COLUMN default_carrier_prefix  varchar(16),
  ADD COLUMN doc_ref_prefix          varchar(16);

-- ---------------------------------------------------------------------------
-- 2. Backfill from operator_constants if it exists (it may not on local
--    dev DBs that skipped migrations 0050-0057)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  has_table boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'operator_constants'
  ) INTO has_table;

  IF has_table THEN
    EXECUTE $sql$
      UPDATE operator_declaration_config c
         SET default_reg_port_code = (
               SELECT value FROM operator_constants
                WHERE operator_id = c.operator_id AND key = 'default_reg_port_code'
                LIMIT 1
             ),
             default_carrier_prefix = (
               SELECT value FROM operator_constants
                WHERE operator_id = c.operator_id AND key = 'default_carrier_prefix'
                LIMIT 1
             ),
             doc_ref_prefix = (
               SELECT value FROM operator_constants
                WHERE operator_id = c.operator_id AND key = 'doc_ref_prefix'
                LIMIT 1
             );
    $sql$;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Drop operator_constants
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS operator_constants;

COMMIT;
