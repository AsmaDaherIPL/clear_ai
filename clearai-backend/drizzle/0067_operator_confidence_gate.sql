-- Adds per-operator minimum confidence band gate.
-- Null = no gate (existing behaviour preserved for all current operators).

DO $$ BEGIN
  CREATE TYPE confidence_band AS ENUM ('certain', 'high', 'medium', 'low', 'none');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE operator_declaration_config
  ADD COLUMN IF NOT EXISTS min_confidence_band confidence_band;
