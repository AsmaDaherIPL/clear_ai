-- ============================================================================
-- 0014_heading_level_match.sql
--
-- Adds 'heading_level_match' to the events_decision_reason_chk closed-enum
-- check constraint. This decision_reason is emitted when the route
-- promotes a best-effort heading (e.g. 4-digit "4202") into a heading-padded
-- 12-digit accepted code (e.g. "420200000000") that ZATCA recognises as a
-- valid declaration.
--
-- See ADR-0019 and src/routes/describe.ts for the full rationale.
-- ============================================================================

ALTER TABLE classification_events
  DROP CONSTRAINT IF EXISTS events_decision_reason_chk;
--> statement-breakpoint

ALTER TABLE classification_events
  ADD CONSTRAINT events_decision_reason_chk
    CHECK (decision_reason IN (
      'strong_match',
      'single_valid_descendant',
      'already_most_specific',
      'weak_retrieval',
      'ambiguous_top_candidates',
      'invalid_prefix',
      'guard_tripped',
      'llm_unavailable',
      'brand_not_recognised',
      'best_effort_heading',
      'heading_level_match'
    ));
--> statement-breakpoint
