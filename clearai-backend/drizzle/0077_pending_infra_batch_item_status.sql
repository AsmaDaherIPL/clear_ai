-- 0077_pending_infra_batch_item_status.sql
--
-- Adds a new declaration_run_items.status value: 'pending_infra'.
--
-- Distinguishes rows that were downgraded by an LLM-stage exhaustion
-- (transient Foundry slowness / sanity degraded / cleanup degraded /
-- researcher failed_passthrough / picker exhausted / submission_description
-- llm_failed) from real data problems. The HITL queue UI can filter
-- pending_infra rows out separately so reviewers don't waste time on
-- infra-only failures that will resolve on a Foundry retry.
--
-- The status CHECK and the two consistency CHECKs (final_code,
-- goods_description_ar) are dropped and recreated. The consistency CHECKs
-- are widened so pending_infra rows can ALSO carry final_code +
-- goods_description_ar when the pipeline produced them — keeping the
-- forensic info visible to HITL reviewers.
--
-- Constraint names follow migration 0048's RENAME pattern
-- (declaration_set_items_* -> declaration_run_items_*).

ALTER TABLE declaration_run_items
  DROP CONSTRAINT IF EXISTS declaration_run_items_status_chk;
--> statement-breakpoint

ALTER TABLE declaration_run_items
  ADD CONSTRAINT declaration_run_items_status_chk
    CHECK (status IN ('pending', 'classifying', 'succeeded', 'flagged', 'blocked', 'pending_infra', 'failed'));
--> statement-breakpoint

ALTER TABLE declaration_run_items
  DROP CONSTRAINT IF EXISTS declaration_run_items_final_code_status_consistency_chk;
--> statement-breakpoint

ALTER TABLE declaration_run_items
  ADD CONSTRAINT declaration_run_items_final_code_status_consistency_chk
    CHECK (
      (status IN ('succeeded', 'flagged') AND final_code IS NOT NULL)
      OR
      (status = 'pending_infra')
      OR
      (status NOT IN ('succeeded', 'flagged', 'pending_infra') AND final_code IS NULL)
    );
--> statement-breakpoint

ALTER TABLE declaration_run_items
  DROP CONSTRAINT IF EXISTS declaration_run_items_goods_description_ar_status_consistency_chk;
--> statement-breakpoint

ALTER TABLE declaration_run_items
  ADD CONSTRAINT declaration_run_items_goods_description_ar_status_consistency_chk
    CHECK (
      (status IN ('succeeded', 'flagged') AND goods_description_ar IS NOT NULL)
      OR
      (status = 'pending_infra')
      OR
      (status NOT IN ('succeeded', 'flagged', 'pending_infra') AND goods_description_ar IS NULL)
    );
