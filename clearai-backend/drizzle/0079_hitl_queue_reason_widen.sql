-- 0079_hitl_queue_reason_widen.sql
--
-- Broaden hitl_queue.reason CHECK to cover the four reasons the
-- orchestrator actually emits.
--
-- Migration 0060 created the table with reason restricted to
-- ('verdict_escalate', 'sanity_flag'). Two additional reasons were
-- introduced in code without a matching DB migration:
--
--   - 'low_information'      — added in PR-A-2/3 (anchored + legacy
--                              when researcher gave up + too thin to
--                              retrieve against). Tested only via path
--                              that never inserts (escalate→FK on
--                              classification_events fails first), which
--                              is why this CHECK never tripped in
--                              production.
--
--   - 'verifier_uncertain'   — added in PR 12 of the pipeline rewrite
--                              (multi-arm v2). Verifier deterministic
--                              rules fire on identify-chapter
--                              disagreement or picker-confidence
--                              inversion; UNCERTAIN routes here.
--
-- Drops the old check and reinstates with the full 4-reason whitelist.
-- Anything else is still rejected.

ALTER TABLE hitl_queue
  DROP CONSTRAINT IF EXISTS hitl_queue_reason_check;

ALTER TABLE hitl_queue
  ADD CONSTRAINT hitl_queue_reason_check
  CHECK (reason IN (
    'verdict_escalate',
    'sanity_flag',
    'low_information',
    'verifier_uncertain'
  ));
