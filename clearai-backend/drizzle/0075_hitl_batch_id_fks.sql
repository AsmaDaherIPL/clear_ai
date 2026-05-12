-- ============================================================================
-- 0075_hitl_batch_id_fks.sql
--
-- Two changes to hitl_queue:
--
-- 1. Add batch_id column. NULLABLE because single-shot dispatches
--    (POST /classifications/dispatch) produce HITL queue rows that have
--    no parent batch — they only have classification_event_id. For batch
--    rows, batch_id points at declaration_runs(id).
--
-- 2. FK on batch_id with ON DELETE CASCADE so deleting a batch cleans up
--    its review rows. NO FK on item_id — for single-shot dispatches there
--    is no matching declaration_run_items row, so a strict FK would
--    break that path. The existing classification_event_id FK already
--    cascades the queue row when its event is deleted, so item-level
--    cascade is redundant.
--
-- Backfill walk: each existing batch-sourced row's item_id →
-- declaration_run_items.id → declaration_run_id. Single-shot rows (if any
-- existed before this migration) get batch_id = NULL.
-- ============================================================================

ALTER TABLE hitl_queue
  ADD COLUMN batch_id uuid;
--> statement-breakpoint

UPDATE hitl_queue h
   SET batch_id = (
     SELECT i.declaration_run_id
       FROM declaration_run_items i
      WHERE i.id = h.item_id
   );
--> statement-breakpoint

ALTER TABLE hitl_queue
  ADD CONSTRAINT hitl_queue_batch_id_fkey
    FOREIGN KEY (batch_id) REFERENCES declaration_runs(id) ON DELETE CASCADE;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS hitl_queue_batch_idx ON hitl_queue (batch_id, status);
