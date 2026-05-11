-- Drops the per-operator min_confidence_band gate and the confidence_band
-- enum entirely. The classification_status surface (AGREEMENT | DRIFT |
-- ZERO_SIGNAL) supersedes confidence_band. HITL escalation is now driven
-- solely by Stage 2 reconciliation emitting decision='escalate' (which
-- happens on ZERO_SIGNAL or degenerate DRIFT) — no per-operator gate.
--
-- The trace JSONB still contains `confidence_band` on historical rows;
-- those keys remain readable but the field is no longer written by new
-- runs and no live code reads it.

ALTER TABLE operator_declaration_config
  DROP COLUMN IF EXISTS min_confidence_band;
--> statement-breakpoint
DROP TYPE IF EXISTS confidence_band;
