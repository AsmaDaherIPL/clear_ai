-- ============================================================================
-- 0045_declaration_set_items_goods_description_ar.sql
--
-- Adds `goods_description_ar text` to declaration_set_items. Populated by
-- Phase 1 (classification) from dispatch().goodsDescriptionAr — the dispatch
-- agent owns the value, BatchPlumber owns the column.
--
-- Why a top-level column rather than a nested key in classification_result:
--   • The ZATCA Declaration renderer reads `<deccm:goodsDescription>` from
--     the row — keeping it as a real column avoids jsonb shred on every
--     render. Same reason final_code is promoted (see 0043 + ADR
--     batch-items-canonical-jsonb.md).
--   • A future role-separation policy might want to grant SELECT on
--     goods_description_ar to clearai_readonly even when raw_row stays
--     gated. Top-level columns make that trivial.
--
-- Lifecycle invariant (mirrors final_code):
--   present (NOT NULL) iff status ∈ {'succeeded','flagged'}
--   NULL                otherwise
--
-- We keep it nullable in the schema and rely on a CHECK to enforce the
-- ordering invariant — same shape as batch_items_final_code_status_consistency_chk.
-- A separate CHECK avoids encoding two invariants in one constraint.
--
-- What's safe:
--   • ADD COLUMN with no default — every existing row would need a
--     value. Tables are empty in dev pre-PR1; in prod the column is also
--     empty since this is greenfield. Idempotency guard via the column-
--     exists check.
--   • Drizzle hashes the file content; never edit after applied.
-- ============================================================================

ALTER TABLE declaration_set_items
  ADD COLUMN IF NOT EXISTS goods_description_ar text;
--> statement-breakpoint

-- Drop a stale CHECK if a previous run left one (idempotency for re-runs in
-- dev). In prod this is a no-op the first time and from then on.
ALTER TABLE declaration_set_items
  DROP CONSTRAINT IF EXISTS declaration_set_items_goods_description_ar_status_consistency_chk;
--> statement-breakpoint

ALTER TABLE declaration_set_items
  ADD CONSTRAINT declaration_set_items_goods_description_ar_status_consistency_chk
  CHECK (
    (status IN ('succeeded', 'flagged') AND goods_description_ar IS NOT NULL)
    OR
    (status NOT IN ('succeeded', 'flagged') AND goods_description_ar IS NULL)
  );
--> statement-breakpoint

-- Update the analytics-role grant to include the new column. Defensive
-- guard: skip when role doesn't exist (matches 0043's pattern).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clearai_readonly') THEN
    GRANT SELECT (goods_description_ar) ON declaration_set_items TO clearai_readonly;
  END IF;
END
$$;
--> statement-breakpoint
