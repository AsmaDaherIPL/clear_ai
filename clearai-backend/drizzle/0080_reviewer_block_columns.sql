-- ============================================================================
-- 0080_reviewer_block_columns.sql
--
-- Adds reviewer-driven "block from submission" support to
-- declaration_run_items. Sister to migration 0074 (final_code_source +
-- pipeline_final_code for override) — this is the same shape for the
-- block decision.
--
-- New columns:
--   excluded_from_xml   boolean NOT NULL DEFAULT false
--                       True when a reviewer deliberately blocked the row
--                       from the ZATCA submission. The XML builder (when
--                       wired) filters WHERE excluded_from_xml = false.
--                       Until then, this is recorded only — no behaviour
--                       change in the renderer.
--
--   blocked_reason      varchar(64) NULL
--                       Discriminator. V1 only emits 'reviewer_decision'
--                       (the human pressed the "Remove from declaration"
--                       button). Future automated block sources (e.g.
--                       carrier-side blocklists) can add new values.
--
--   blocked_at          timestamptz NULL
--                       Wall-clock when the block decision was committed.
--                       NULL on rows that were never blocked.
--
--   blocked_by          text NULL
--                       Identity of the reviewer who blocked. NULL on
--                       rows where (a) status != 'blocked' or (b) the V1
--                       deployment still has no user identity wired.
--
-- Side notes:
--   - The hitl_queue row carries the human-readable reviewer_notes that
--     explains WHY a row was blocked. blocked_reason here is just the
--     coarse-grained discriminator.
--   - The 'blocked' value already exists in
--     declaration_run_items_status_chk (since migration 0001). No CHECK
--     widening needed — the new reviewer path piggybacks on the existing
--     terminal status.
--   - Partial index on excluded_from_xml = true means COUNT/list-by-batch
--     queries for blocked rows are cheap without slowing down the common
--     "all submissible rows" scan.
-- ============================================================================

ALTER TABLE declaration_run_items
  ADD COLUMN IF NOT EXISTS excluded_from_xml boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS blocked_reason varchar(64),
  ADD COLUMN IF NOT EXISTS blocked_at timestamptz,
  ADD COLUMN IF NOT EXISTS blocked_by text;

CREATE INDEX IF NOT EXISTS declaration_run_items_excluded_idx
  ON declaration_run_items (declaration_run_id)
  WHERE excluded_from_xml = true;
