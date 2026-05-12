-- ============================================================================
-- 0074_final_code_source.sql
--
-- Two new columns on declaration_run_items to support the review/override
-- workflow without losing the pipeline's original audit signal.
--
--   final_code_source: 'pipeline' | 'reviewer_override'
--                      Marks whether final_code came from the auto pipeline
--                      or was set by a human reviewer.
--
--   pipeline_final_code: NULL until a reviewer overrides. When override
--                        happens, this captures the pipeline's original
--                        chosen code so we can audit pipeline-vs-reviewer
--                        disagreement rates over time.
--
-- Override semantics (in a single transaction at PATCH /classifications/review/:id):
--   pipeline_final_code := current final_code     -- only if NULL
--   final_code         := reviewer-supplied code
--   final_code_source  := 'reviewer_override'
-- ============================================================================

ALTER TABLE declaration_run_items
  ADD COLUMN IF NOT EXISTS final_code_source varchar(32) NOT NULL DEFAULT 'pipeline',
  ADD COLUMN IF NOT EXISTS pipeline_final_code varchar(12);
