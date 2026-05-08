-- 0060_classification_events_rename_and_hitl_queue.sql
--
-- Two changes:
--   1. Rename pipeline_events (created in 0059) back to classification_events.
--      The old name is what the team uses everywhere outside the schema.
--   2. Create the hitl_queue table that the orchestrator's enqueueHitl()
--      writes into. v0 design: per-item rows with reviewer columns left
--      nullable; any logged-in user can read the queue (RBAC enforced at
--      the app layer, not the DB).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Rename table + indexes + constraints + FK
-- ---------------------------------------------------------------------------
ALTER TABLE pipeline_events RENAME TO classification_events;

ALTER INDEX pipeline_events_pkey                RENAME TO classification_events_pkey;
ALTER INDEX pipeline_events_created_at_idx      RENAME TO classification_events_created_at_idx;
ALTER INDEX pipeline_events_operator_idx        RENAME TO classification_events_operator_idx;
ALTER INDEX pipeline_events_status_idx          RENAME TO classification_events_status_idx;
ALTER INDEX pipeline_events_resolver_path_idx   RENAME TO classification_events_resolver_path_idx;

ALTER TABLE classification_events
  RENAME CONSTRAINT pipeline_events_status_check          TO classification_events_status_check;
ALTER TABLE classification_events
  RENAME CONSTRAINT pipeline_events_sanity_verdict_check  TO classification_events_sanity_verdict_check;
ALTER TABLE classification_events
  RENAME CONSTRAINT pipeline_events_resolver_path_check   TO classification_events_resolver_path_check;
ALTER TABLE classification_events
  RENAME CONSTRAINT pipeline_events_operator_id_fkey      TO classification_events_operator_id_fkey;

-- ---------------------------------------------------------------------------
-- 2. hitl_queue
-- ---------------------------------------------------------------------------
CREATE TABLE hitl_queue (
  id                       uuid        PRIMARY KEY,
  created_at               timestamptz NOT NULL DEFAULT now(),
  enqueued_at              timestamptz NOT NULL,

  classification_event_id  uuid        NOT NULL
    REFERENCES classification_events(id) ON DELETE CASCADE,

  -- Denormalized for fast queue queries without joins.
  item_id                  uuid        NOT NULL,
  operator_slug            varchar(64) NOT NULL,

  reason                   varchar(32) NOT NULL,    -- 'verdict_escalate' | 'sanity_flag'

  status                   varchar(16) NOT NULL DEFAULT 'pending',
  reviewed_at              timestamptz,
  reviewed_by              text,
  reviewer_decision        varchar(16),             -- 'approve' | 'override' | 'reject'
  reviewer_code            varchar(12),
  reviewer_notes           text,

  payload                  jsonb       NOT NULL,    -- forensic snapshot: cleaned_description, verdict_output, sanity_result, trace

  CONSTRAINT hitl_queue_reason_check
    CHECK (reason IN ('verdict_escalate', 'sanity_flag')),
  CONSTRAINT hitl_queue_status_check
    CHECK (status IN ('pending', 'in_review', 'resolved', 'dismissed')),
  CONSTRAINT hitl_queue_reviewer_decision_check
    CHECK (reviewer_decision IS NULL OR reviewer_decision IN ('approve', 'override', 'reject'))
);

CREATE INDEX hitl_queue_status_idx    ON hitl_queue (status, created_at);
CREATE INDEX hitl_queue_operator_idx  ON hitl_queue (operator_slug, status);
CREATE INDEX hitl_queue_event_idx     ON hitl_queue (classification_event_id);

COMMIT;
