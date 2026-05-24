-- ============================================================================
-- 0092_sanity_enabled_flag.sql
--
-- Per-operator flag to disable the sanity LLM call.
--
-- Motivation:
--   Sanity is the dominant Sonnet cost line — it consumes ~70% of the
--   Sonnet TPM budget per classified row. For operators like Naqel that
--   emit LV catch-all declarations anyway (every row → 9803.00.00.00.01),
--   sanity produces no XML-shipping signal: a FLAG verdict routes to HITL
--   but the LV bundler still ships the catch-all code regardless. The
--   stage is audit-only for these operators (per rule_sanity_is_audit_only).
--
--   Day-1 cost projection at 288,742 rows with sanity ON: ~$5,000.
--   Same projection with sanity OFF for Naqel:           ~$1,600.
--
-- Behaviour:
--   Default true (preserve historical behaviour for any other operator
--   that may join later). Set to false explicitly for Naqel.
--
--   When false, the orchestrator skips the sanity LLM call entirely:
--     - `sanity_verdict` is null in classification_events
--     - the row is treated as PASS for routing purposes (no sanity_flag
--       HITL reason ever fires)
--     - all other stages (identify_fast, picker, submission) run
--       unchanged
-- ============================================================================

ALTER TABLE operator_declaration_config
  ADD COLUMN IF NOT EXISTS sanity_enabled boolean NOT NULL DEFAULT true;

-- Naqel: disable sanity (LV catch-all renders the audit redundant).
UPDATE operator_declaration_config
   SET sanity_enabled = false
 WHERE operator_id = (SELECT id FROM operators WHERE slug = 'naqel');
