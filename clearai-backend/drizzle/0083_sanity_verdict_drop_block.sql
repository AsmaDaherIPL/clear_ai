-- ============================================================================
-- 0083_sanity_verdict_drop_block.sql
--
-- Tighten the classification_events.sanity_verdict CHECK to {PASS, FLAG, NULL}.
-- The legacy 'BLOCK' string was an overload meaning "row never classified
-- (parse rejection / unusable cleanup)", which is more honestly encoded by
-- classification_status IS NULL (or declaration_run_items.status='blocked').
-- The sanity LLM itself never emitted BLOCK; only the orchestrator's
-- pre-classification short-circuit did, via PipelineResult.sanity_verdict.
--
-- After this migration:
--   sanity_verdict = PASS  → sanity ran, value plausible
--   sanity_verdict = FLAG  → sanity ran, value implausible (HITL routing,
--                            but XML still ships — see double-axis WHERE
--                            in declaration.repository.listClassifiedItems)
--   sanity_verdict = NULL  → sanity did not run (ZERO_SIGNAL escalate OR
--                            pre-classification short-circuit)
--
-- Data migration: rewrite any historical 'BLOCK' rows to NULL. They were
-- always paired with a NULL final_code; classification_status was already
-- NULL on those rows, so the "row never classified" semantics are
-- preserved by the new constraint set.
--
-- Idempotent: DROP IF EXISTS + ADD with the new spec. Safe to re-run.
-- ============================================================================

UPDATE classification_events
   SET sanity_verdict = NULL
 WHERE sanity_verdict = 'BLOCK';
--> statement-breakpoint

ALTER TABLE classification_events
  DROP CONSTRAINT IF EXISTS classification_events_sanity_verdict_check;
--> statement-breakpoint

ALTER TABLE classification_events
  ADD CONSTRAINT classification_events_sanity_verdict_check
    CHECK (sanity_verdict IS NULL OR sanity_verdict IN ('PASS', 'FLAG'));
--> statement-breakpoint
