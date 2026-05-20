-- ============================================================================
-- 0088_pr15_low_confidence_band.sql
--
-- PR15 (2026-05-20): adds `low_confidence_band` to the allowed
-- `hitl_queue.reason` set so the orchestrator can route any pick whose
-- confidence_band ∈ {fair, low, no_result} into HITL for review.
--
-- Policy decision (user, 2026-05-20):
--   high      → accept, no review
--   moderate  → accept, no review
--   fair      → HITL (this PR)
--   low       → HITL (this PR)
--   no_result → HITL (this PR; for accepted-with-floor-clamp rows;
--                     genuine ZERO_SIGNAL paths already escalate
--                     via verdict_escalate)
--
-- The other existing reasons (`verdict_escalate`, `sanity_flag`,
-- `low_information`, `verifier_uncertain`, `missing_attributes`,
-- `shadow_sample`) stay — they trigger on different signals and may
-- co-fire with `low_confidence_band`. buildHitl() picks the more
-- specific reason when multiple apply.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS before re-adding.
-- ============================================================================

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
    'shadow_sample',
    'low_confidence_band'
  ));
