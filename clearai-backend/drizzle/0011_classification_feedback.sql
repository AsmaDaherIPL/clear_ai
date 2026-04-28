-- ============================================================================
-- 0011_classification_feedback.sql
--
-- Phase 4 — user feedback on classifications. Each row is a human judgement
-- attached to a specific classification_events row. Three feedback kinds:
--   - confirm             — "this is correct"
--   - reject              — "this is wrong" (corrected_code may be null
--                           if the user just wants to flag without
--                           specifying the right answer)
--   - prefer_alternative  — "use this code instead" (corrected_code is the
--                           alternative the user picked from the list)
--
-- This table is the gold-standard training data for tuning the picker over
-- time. Every row is a human-confirmed label. See ADR-0017 and
-- src/routes/feedback.ts for the full rationale.
--
-- user_id is null today (no auth wired up); when auth lands, it stores the
-- subject id from the auth provider. The unique constraint on
-- (event_id, user_id) prevents one user from spamming feedback on the same
-- request — they can only update the existing row, not insert duplicates.
-- ============================================================================

CREATE TABLE IF NOT EXISTS classification_feedback (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  event_id        uuid NOT NULL REFERENCES classification_events(id) ON DELETE CASCADE,
  kind            varchar(32) NOT NULL,
  rejected_code   varchar(12),
  corrected_code  varchar(12),
  reason          text,
  user_id         text,
  CONSTRAINT classification_feedback_kind_chk CHECK (
    kind IN ('confirm', 'reject', 'prefer_alternative')
  ),
  CONSTRAINT classification_feedback_corrected_kind_chk CHECK (
    -- prefer_alternative MUST have a corrected_code (that's the whole
    -- point of that kind). reject MAY have one. confirm MUST NOT.
    (kind = 'prefer_alternative' AND corrected_code IS NOT NULL) OR
    (kind = 'reject') OR
    (kind = 'confirm' AND corrected_code IS NULL)
  )
);
--> statement-breakpoint

-- One feedback row per (event, user) pair. Without this, a user spamming
-- the 👎 button creates dozens of duplicate rows.
CREATE UNIQUE INDEX IF NOT EXISTS classification_feedback_event_user_uniq
  ON classification_feedback (event_id, COALESCE(user_id, ''));
--> statement-breakpoint

-- Common query patterns:
--   - "show me all feedback for event X" → event_id index
--   - "show me all corrections for code Y" → rejected_code index
CREATE INDEX IF NOT EXISTS classification_feedback_event_idx
  ON classification_feedback (event_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS classification_feedback_rejected_code_idx
  ON classification_feedback (rejected_code) WHERE rejected_code IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS classification_feedback_corrected_code_idx
  ON classification_feedback (corrected_code) WHERE corrected_code IS NOT NULL;
--> statement-breakpoint

-- Touch updated_at on UPDATE so we can tell when feedback was last edited.
-- We define our own trigger function (rather than reusing setup_meta's) to
-- keep this migration self-contained.
CREATE OR REPLACE FUNCTION classification_feedback_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_classification_feedback_updated_at ON classification_feedback;
--> statement-breakpoint

CREATE TRIGGER trg_classification_feedback_updated_at
  BEFORE UPDATE ON classification_feedback
  FOR EACH ROW EXECUTE FUNCTION classification_feedback_touch_updated_at();
--> statement-breakpoint
