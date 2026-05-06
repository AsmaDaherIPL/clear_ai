-- ============================================================================
-- 0050_operator_id_fks.sql
--
-- Switch every operator-scoped FK from operator_slug -> operator_id (uuid).
-- The slug stays on operators as a UNIQUE human label, but child tables now
-- reference operators(id) so renames of the slug never cascade.
--
-- Affected child tables:
--   operator_field_mappings
--   operator_constants
--   operator_lookups
--   operator_code_overrides
--   declaration_runs
--
-- Pattern per child:
--   1. ADD COLUMN operator_id uuid (nullable)
--   2. UPDATE child SET operator_id = operators.id FROM operators WHERE child.operator_slug = operators.slug
--   3. ALTER COLUMN operator_id SET NOT NULL
--   4. DROP CONSTRAINT <fk to operators.slug>
--   5. ADD CONSTRAINT <fk to operators.id> ON DELETE RESTRICT (or CASCADE for declaration_runs lookups)
--   6. DROP unique/index on operator_slug, recreate on operator_id where natural-key requires it
--   7. DROP COLUMN operator_slug
--
-- All blocks idempotent. Safe to re-run.
-- ============================================================================

-- ---------- operator_field_mappings ----------

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='operator_field_mappings' AND column_name='operator_id') THEN
    ALTER TABLE operator_field_mappings ADD COLUMN operator_id uuid;
  END IF;
END $$;

UPDATE operator_field_mappings c
   SET operator_id = o.id
  FROM operators o
 WHERE c.operator_id IS NULL AND c.operator_slug = o.slug;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='operator_field_mappings' AND column_name='operator_id' AND is_nullable='YES') THEN
    ALTER TABLE operator_field_mappings ALTER COLUMN operator_id SET NOT NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='operator_field_mappings_operator_slug_fk') THEN
    ALTER TABLE operator_field_mappings DROP CONSTRAINT operator_field_mappings_operator_slug_fk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='operator_field_mappings_operator_slug_canonical_uniq') THEN
    ALTER TABLE operator_field_mappings DROP CONSTRAINT operator_field_mappings_operator_slug_canonical_uniq;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='operator_field_mappings_tenant_canonical_uniq') THEN
    ALTER TABLE operator_field_mappings DROP CONSTRAINT operator_field_mappings_tenant_canonical_uniq;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='operator_field_mappings_operator_slug_format_chk') THEN
    ALTER TABLE operator_field_mappings DROP CONSTRAINT operator_field_mappings_operator_slug_format_chk;
  END IF;
END $$;

DROP INDEX IF EXISTS operator_field_mappings_operator_slug_idx;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='operator_field_mappings_operator_id_fk') THEN
    ALTER TABLE operator_field_mappings
      ADD CONSTRAINT operator_field_mappings_operator_id_fk
      FOREIGN KEY (operator_id) REFERENCES operators(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='operator_field_mappings_operator_id_canonical_uniq') THEN
    ALTER TABLE operator_field_mappings
      ADD CONSTRAINT operator_field_mappings_operator_id_canonical_uniq
      UNIQUE (operator_id, canonical_field);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS operator_field_mappings_operator_id_idx
  ON operator_field_mappings (operator_id);

ALTER TABLE operator_field_mappings DROP COLUMN IF EXISTS operator_slug;

-- ---------- operator_constants ----------

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='operator_constants' AND column_name='operator_id') THEN
    ALTER TABLE operator_constants ADD COLUMN operator_id uuid;
  END IF;
END $$;

UPDATE operator_constants c
   SET operator_id = o.id
  FROM operators o
 WHERE c.operator_id IS NULL AND c.operator_slug = o.slug;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='operator_constants' AND column_name='operator_id' AND is_nullable='YES') THEN
    ALTER TABLE operator_constants ALTER COLUMN operator_id SET NOT NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='operator_constants_operator_slug_fk') THEN
    ALTER TABLE operator_constants DROP CONSTRAINT operator_constants_operator_slug_fk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='operator_constants_operator_slug_key_uniq') THEN
    ALTER TABLE operator_constants DROP CONSTRAINT operator_constants_operator_slug_key_uniq;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='operator_constants_tenant_key_uniq') THEN
    ALTER TABLE operator_constants DROP CONSTRAINT operator_constants_tenant_key_uniq;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='operator_constants_operator_slug_format_chk') THEN
    ALTER TABLE operator_constants DROP CONSTRAINT operator_constants_operator_slug_format_chk;
  END IF;
END $$;

DROP INDEX IF EXISTS operator_constants_operator_slug_idx;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='operator_constants_operator_id_fk') THEN
    ALTER TABLE operator_constants
      ADD CONSTRAINT operator_constants_operator_id_fk
      FOREIGN KEY (operator_id) REFERENCES operators(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='operator_constants_operator_id_key_uniq') THEN
    ALTER TABLE operator_constants
      ADD CONSTRAINT operator_constants_operator_id_key_uniq
      UNIQUE (operator_id, key);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS operator_constants_operator_id_idx
  ON operator_constants (operator_id);

ALTER TABLE operator_constants DROP COLUMN IF EXISTS operator_slug;

-- ---------- operator_lookups ----------

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='operator_lookups' AND column_name='operator_id') THEN
    ALTER TABLE operator_lookups ADD COLUMN operator_id uuid;
  END IF;
END $$;

UPDATE operator_lookups c
   SET operator_id = o.id
  FROM operators o
 WHERE c.operator_id IS NULL AND c.operator_slug = o.slug;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='operator_lookups' AND column_name='operator_id' AND is_nullable='YES') THEN
    ALTER TABLE operator_lookups ALTER COLUMN operator_id SET NOT NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='operator_lookups_operator_slug_fk') THEN
    ALTER TABLE operator_lookups DROP CONSTRAINT operator_lookups_operator_slug_fk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='operator_lookups_natural_uniq') THEN
    ALTER TABLE operator_lookups DROP CONSTRAINT operator_lookups_natural_uniq;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='operator_lookups_operator_slug_format_chk') THEN
    ALTER TABLE operator_lookups DROP CONSTRAINT operator_lookups_operator_slug_format_chk;
  END IF;
END $$;

DROP INDEX IF EXISTS operator_lookups_operator_slug_type_idx;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='operator_lookups_operator_id_fk') THEN
    ALTER TABLE operator_lookups
      ADD CONSTRAINT operator_lookups_operator_id_fk
      FOREIGN KEY (operator_id) REFERENCES operators(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='operator_lookups_natural_uniq') THEN
    ALTER TABLE operator_lookups
      ADD CONSTRAINT operator_lookups_natural_uniq
      UNIQUE (operator_id, lookup_type, source_value);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS operator_lookups_operator_id_type_idx
  ON operator_lookups (operator_id, lookup_type);

ALTER TABLE operator_lookups DROP COLUMN IF EXISTS operator_slug;

-- ---------- operator_code_overrides ----------

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='operator_code_overrides' AND column_name='operator_id') THEN
    ALTER TABLE operator_code_overrides ADD COLUMN operator_id uuid;
  END IF;
END $$;

UPDATE operator_code_overrides c
   SET operator_id = o.id
  FROM operators o
 WHERE c.operator_id IS NULL AND c.operator_slug = o.slug;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='operator_code_overrides' AND column_name='operator_id' AND is_nullable='YES') THEN
    ALTER TABLE operator_code_overrides ALTER COLUMN operator_id SET NOT NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='operator_code_overrides_tenant_source_uniq') THEN
    ALTER TABLE operator_code_overrides DROP CONSTRAINT operator_code_overrides_tenant_source_uniq;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='operator_code_overrides_operator_slug_format_chk') THEN
    ALTER TABLE operator_code_overrides DROP CONSTRAINT operator_code_overrides_operator_slug_format_chk;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='operator_code_overrides_operator_id_fk') THEN
    ALTER TABLE operator_code_overrides
      ADD CONSTRAINT operator_code_overrides_operator_id_fk
      FOREIGN KEY (operator_id) REFERENCES operators(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='operator_code_overrides_operator_id_source_uniq') THEN
    ALTER TABLE operator_code_overrides
      ADD CONSTRAINT operator_code_overrides_operator_id_source_uniq
      UNIQUE (operator_id, source_code);
  END IF;
END $$;

ALTER TABLE operator_code_overrides DROP COLUMN IF EXISTS operator_slug;

-- ---------- declaration_runs ----------

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='declaration_runs' AND column_name='operator_id') THEN
    ALTER TABLE declaration_runs ADD COLUMN operator_id uuid;
  END IF;
END $$;

UPDATE declaration_runs c
   SET operator_id = o.id
  FROM operators o
 WHERE c.operator_id IS NULL AND c.operator_slug = o.slug;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='declaration_runs' AND column_name='operator_id' AND is_nullable='YES') THEN
    ALTER TABLE declaration_runs ALTER COLUMN operator_id SET NOT NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='declaration_runs_operator_slug_fk') THEN
    ALTER TABLE declaration_runs DROP CONSTRAINT declaration_runs_operator_slug_fk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='declaration_runs_operator_slug_format_chk') THEN
    ALTER TABLE declaration_runs DROP CONSTRAINT declaration_runs_operator_slug_format_chk;
  END IF;
END $$;

DROP INDEX IF EXISTS declaration_runs_operator_slug_idx;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='declaration_runs_operator_id_fk') THEN
    ALTER TABLE declaration_runs
      ADD CONSTRAINT declaration_runs_operator_id_fk
      FOREIGN KEY (operator_id) REFERENCES operators(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS declaration_runs_operator_id_idx
  ON declaration_runs (operator_id);

ALTER TABLE declaration_runs DROP COLUMN IF EXISTS operator_slug;
