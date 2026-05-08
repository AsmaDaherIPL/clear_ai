-- 0061_declaration_runs_blob_prefix.sql
--
-- Add blob_prefix column to declaration_runs. Records the prefix under
-- which manifest.json + HV/LV XMLs land in blob storage, so the read
-- endpoints don't have to recompute the date partition from created_at
-- (timezone-safe).
--
-- Layout: {operator_slug}/{YYYY}/{MM}/{DD}/{run_id}
-- Stored without leading container name (the Storage SDK takes
-- container + key separately).

BEGIN;

ALTER TABLE declaration_runs
  ADD COLUMN blob_prefix text;

COMMIT;
