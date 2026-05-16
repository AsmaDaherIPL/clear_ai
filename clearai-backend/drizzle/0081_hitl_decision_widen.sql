-- ============================================================================
-- 0081_hitl_decision_widen.sql
--
-- Widens hitl_queue_reviewer_decision_check to allow two new values:
--
--   block_from_submission
--     Shipped in code with migration 0080 (the reviewer-block flow) but the
--     CHECK constraint was never widened to match. Without this migration,
--     PATCH /classifications/review/:id with decision='block_from_submission'
--     fails at COMMIT with a constraint violation. Latent bug — caught while
--     adding confirm_flag (2026-05-17).
--
--   confirm_flag
--     New verb for sanity_flag rows. Semantics: reviewer agrees with sanity
--     that the declared value is implausible — but unlike block_from_submission,
--     the row STILL goes into the XML. This is an audit signal recorded
--     against the merchant for downstream data-quality analysis, NOT a
--     hard-stop on submission.
--
--     Allowed reasons: 'sanity_flag' only. Other reasons (verifier_uncertain,
--     verdict_escalate, low_information) are about CODE quality, not VALUE
--     plausibility — confirm_flag is meaningless on those. The reason-check
--     is enforced in the route handler (review.routes.ts) rather than via a
--     conditional CHECK on the column, because the reason is on the same row
--     and adding a composite CHECK would force a row rewrite on existing
--     rows. Single-table-validation in the API layer is acceptable here.
--
-- Side effects on declaration_run_items: NONE for confirm_flag (the row
-- remains in 'flagged' status with excluded_from_xml=false). The XML render
-- query is unaffected.
-- ============================================================================

ALTER TABLE hitl_queue
  DROP CONSTRAINT IF EXISTS hitl_queue_reviewer_decision_check;

ALTER TABLE hitl_queue
  ADD CONSTRAINT hitl_queue_reviewer_decision_check
  CHECK (
    reviewer_decision IS NULL
    OR reviewer_decision IN (
      'approve',
      'override',
      'reject',
      'block_from_submission',
      'confirm_flag'
    )
  );
