-- ============================================================================
-- 0052_declaration_run_filings_status.sql
--
-- Add lifecycle tracking to declaration_run_filings.
--
-- Two independent status columns:
--   • status        — ClearAI's own pipeline state (rendered the XML or not)
--   • zatca_status  — ZATCA's verdict (NULL until they respond)
--
-- Plus rejection_reason / submitted_at / finalized_at, all guarded by a
-- consistency CHECK so an 'accepted' row can't have a NULL bayan_no and a
-- 'rejected' row can't have a NULL rejection_reason.
--
-- Backfill rule for existing rows: every existing row was rendered + uploaded
-- successfully (otherwise it wouldn't have a row), so status defaults to
-- 'generated'. zatca_status stays NULL — none of the historical rows have a
-- ZATCA verdict yet.
-- ============================================================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='declaration_run_filings' AND column_name='status') THEN
    ALTER TABLE declaration_run_filings ADD COLUMN status text NOT NULL DEFAULT 'pending';
  END IF;
END $$;

UPDATE declaration_run_filings SET status = 'generated' WHERE status = 'pending';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='declaration_run_filings' AND column_name='zatca_status') THEN
    ALTER TABLE declaration_run_filings ADD COLUMN zatca_status text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='declaration_run_filings' AND column_name='rejection_reason') THEN
    ALTER TABLE declaration_run_filings ADD COLUMN rejection_reason text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='declaration_run_filings' AND column_name='submitted_at') THEN
    ALTER TABLE declaration_run_filings ADD COLUMN submitted_at timestamptz;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='declaration_run_filings' AND column_name='finalized_at') THEN
    ALTER TABLE declaration_run_filings ADD COLUMN finalized_at timestamptz;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='declaration_run_filings_status_chk') THEN
    ALTER TABLE declaration_run_filings
      ADD CONSTRAINT declaration_run_filings_status_chk
      CHECK (status IN ('pending', 'generated', 'failed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='declaration_run_filings_zatca_status_chk') THEN
    ALTER TABLE declaration_run_filings
      ADD CONSTRAINT declaration_run_filings_zatca_status_chk
      CHECK (zatca_status IS NULL OR zatca_status IN ('accepted', 'rejected'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='declaration_run_filings_zatca_consistency_chk') THEN
    ALTER TABLE declaration_run_filings
      ADD CONSTRAINT declaration_run_filings_zatca_consistency_chk
      CHECK (
        (zatca_status IS NULL      AND bayan_no IS NULL     AND rejection_reason IS NULL)
        OR
        (zatca_status = 'accepted' AND bayan_no IS NOT NULL AND rejection_reason IS NULL)
        OR
        (zatca_status = 'rejected' AND bayan_no IS NULL     AND rejection_reason IS NOT NULL)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS declaration_run_filings_status_idx
  ON declaration_run_filings (status);

CREATE INDEX IF NOT EXISTS declaration_run_filings_zatca_status_idx
  ON declaration_run_filings (zatca_status)
  WHERE zatca_status IS NOT NULL;
