-- ============================================================================
-- 0023_decision_reason_extension.sql
--
-- Extends events_decision_reason_chk to allow:
--
--   • 'multi_product_input' — emitted when merchant-cleanup detects more than
--     one distinct product in a single submission and the route refuses to
--     classify (commit 650af44). Was missing from 0014's enum so every
--     multi-product event silently failed to log; this is the back-fill.
--
--   • 'code_deleted' — emitted when the submitted code (or broker-mapping
--     target) exactly matches a SABER-deleted HS code; route returns
--     deleted_code_alternatives so the broker can pick the replacement.
--     See 0021_hs_codes_deletion.sql + ADR-0021.
--
-- The constraint exists to make malformed decision_reason values impossible
-- at the DB level (catches typos in route handlers before they pollute
-- the events table — that table is the audit trail customs-ops queries to
-- explain rejected declarations).
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
      'heading_level_match',
      'multi_product_input',
      'code_deleted'
    ));
--> statement-breakpoint
