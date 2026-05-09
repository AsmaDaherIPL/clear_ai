-- Repair migration: 0067 was authored without --> statement-breakpoint between
-- the DO $$ ... END $$ block and the ALTER TABLE. Drizzle's migrator sent only
-- the first statement, so the column was never created on existing DBs even
-- though the journal recorded 0067 as applied. This migration is idempotent
-- and re-applies both side-effects safely.

DO $$ BEGIN
  CREATE TYPE confidence_band AS ENUM ('certain', 'high', 'medium', 'low', 'none');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE operator_declaration_config
  ADD COLUMN IF NOT EXISTS min_confidence_band confidence_band;
