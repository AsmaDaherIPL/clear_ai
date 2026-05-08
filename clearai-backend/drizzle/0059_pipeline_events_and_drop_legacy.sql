-- 0059_pipeline_events_and_drop_legacy.sql
--
-- Replaces the legacy classification_events + classification_feedback
-- tables with one new table that matches the dispatch-v1 pipeline.
--
-- Both legacy tables are dropped in this migration:
--   * classification_events    — built around the retired /classifications
--                                describe/expand single-call model. Empty
--                                in prod; nothing in the dispatch pipeline
--                                writes to it.
--   * classification_feedback  — predates the dispatch HITL design and
--                                was never wired to a real reviewer
--                                workflow. The new HITL queue is
--                                designed against pipeline_events.
--
-- The new pipeline_events table is intentionally minimal: 13 columns that
-- you'll filter and aggregate on regularly, plus jsonb columns for the
-- redacted request and the full DispatchV1Trace. Anything else you ever
-- need for an ad-hoc query lives inside `trace`.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Create pipeline_events
-- ---------------------------------------------------------------------------
CREATE TABLE pipeline_events (
  id                                  uuid        PRIMARY KEY,
  created_at                          timestamptz NOT NULL DEFAULT now(),

  operator_id                         uuid        REFERENCES operators(id) ON DELETE SET NULL,
  operator_slug                       varchar(64) NOT NULL,

  status                              varchar(16) NOT NULL,
  final_code                          varchar(12),
  sanity_verdict                      varchar(8),

  description_classifier_chosen_code  varchar(12),
  description_classifier_confidence   double precision,

  code_resolver_resolved_code         varchar(12),
  code_resolver_path                  varchar(40),
  tenant_override_applied             boolean     NOT NULL DEFAULT false,

  total_latency_ms                    integer     NOT NULL,
  request                             jsonb       NOT NULL,
  trace                               jsonb       NOT NULL,

  CONSTRAINT pipeline_events_status_check
    CHECK (status IN ('succeeded', 'failed', 'rejected', 'flagged')),
  CONSTRAINT pipeline_events_sanity_verdict_check
    CHECK (sanity_verdict IS NULL OR sanity_verdict IN ('PASS', 'FLAG', 'BLOCK')),
  CONSTRAINT pipeline_events_resolver_path_check
    CHECK (code_resolver_path IS NULL OR code_resolver_path IN (
      'deterministic_passthrough',
      'deterministic_swap',
      'llm_pick_among_replacements',
      'llm_pick_under_prefix',
      'tenant_override',
      'null_resolution'
    ))
);

CREATE INDEX pipeline_events_created_at_idx
  ON pipeline_events (created_at DESC);

CREATE INDEX pipeline_events_operator_idx
  ON pipeline_events (operator_id, created_at DESC);

CREATE INDEX pipeline_events_status_idx
  ON pipeline_events (status);

CREATE INDEX pipeline_events_resolver_path_idx
  ON pipeline_events (code_resolver_path);

-- ---------------------------------------------------------------------------
-- 2. Drop the legacy tables
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS classification_feedback;
DROP TABLE IF EXISTS classification_events;

COMMIT;
