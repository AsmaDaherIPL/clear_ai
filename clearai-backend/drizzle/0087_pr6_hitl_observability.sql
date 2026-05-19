-- ============================================================================
-- 0087_pr6_hitl_observability.sql
--
-- PR6 / remediation plan §1.1.2 + §1.4.3 + §1.5.3 + §1.6.1.
--
-- Two structural additions:
--
--   1. hitl_queue.shadow_sample (boolean, default false): marks rows that
--      reached HITL via the random 5% AGREEMENT sampler (rather than via
--      a real sanity FLAG, verifier UNCERTAIN, or pick escalate). Used
--      downstream to filter the calibration set: regular HITL = real
--      failures; shadow_sample = high-confidence rows we deliberately
--      sampled to surface invisible misclassifications.
--
--   2. hitl_feedback table: where every reviewer correction is stored.
--      Nothing consumes this yet (consumer is in Step 2 / a later PR).
--      Created now so the writer can start populating from PR6 onward,
--      giving us a backlog of corrections to learn from.
--
-- Idempotent: ALTER ... IF NOT EXISTS for the column, CREATE TABLE
-- IF NOT EXISTS for the new table.
-- ============================================================================

-- 1. hitl_queue.shadow_sample
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'hitl_queue' AND column_name = 'shadow_sample'
  ) THEN
    ALTER TABLE hitl_queue ADD COLUMN shadow_sample boolean NOT NULL DEFAULT false;
  END IF;
END $$;

-- Partial index for cheap "list shadow-sampled rows" queries.
CREATE INDEX IF NOT EXISTS hitl_queue_shadow_sample_idx
  ON hitl_queue (shadow_sample) WHERE shadow_sample = true;

-- 1b. Widen hitl_queue.reason CHECK to include the new reasons:
--   shadow_sample      — random 5% AGREEMENT sampling
--   missing_attributes — picker emitted missing_attributes + partial fit
ALTER TABLE hitl_queue
  DROP CONSTRAINT IF EXISTS hitl_queue_reason_check;

ALTER TABLE hitl_queue
  ADD CONSTRAINT hitl_queue_reason_check
  CHECK (reason IN (
    'verdict_escalate',
    'sanity_flag',
    'low_information',
    'verifier_uncertain',
    'missing_attributes',
    'shadow_sample'
  ));

-- 2. hitl_feedback
CREATE TABLE IF NOT EXISTS hitl_feedback (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id                 uuid NOT NULL,
  description                 text NOT NULL,
  canonical                   text,
  pipeline_picked_code        text,
  reviewer_corrected_code     text NOT NULL,
  reviewer_notes              text,
  classification_event_id     uuid REFERENCES classification_events(id) ON DELETE SET NULL,
  hitl_queue_id               uuid REFERENCES hitl_queue(id) ON DELETE SET NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  promoted_to_override        boolean NOT NULL DEFAULT false,
  promoted_at                 timestamptz,
  CONSTRAINT hitl_feedback_corrected_code_format_chk
    CHECK (reviewer_corrected_code ~ '^[0-9]{12}$' OR reviewer_corrected_code ~ '^[0-9]{6,11}$')
);

CREATE INDEX IF NOT EXISTS hitl_feedback_operator_canonical_idx
  ON hitl_feedback (operator_id, canonical);

CREATE INDEX IF NOT EXISTS hitl_feedback_operator_created_at_idx
  ON hitl_feedback (operator_id, created_at DESC);
