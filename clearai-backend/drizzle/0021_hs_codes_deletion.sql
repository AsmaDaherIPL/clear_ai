-- ============================================================================
-- 0021_hs_codes_deletion.sql
--
-- Adds three columns to hs_codes to represent SABER-notified code deletions:
--
--   is_deleted              boolean NOT NULL DEFAULT false
--     True for codes that ZATCA/SABER has retired. Retrieval, branch
--     enumeration, and broker-mapping target lookups filter these out with
--     AND NOT is_deleted so they never reach the picker.
--
--   deletion_effective_date date
--     The date SABER published as the replacement effective date.
--     NULL when is_deleted = false (enforced by CHECK constraint).
--
--   replacement_codes       jsonb
--     Array of 12-digit strings: the more-specific codes that supersede
--     this one, e.g. '["550111000001","550111009999"]'.
--     NULL when is_deleted = false.
--     NULL also acceptable when is_deleted = true and SABER listed no
--     alternatives (the constraint only requires deletion_effective_date).
--
-- Partial index on (code) WHERE is_deleted = false:
--   All hot retrieval queries already filter on is_leaf = true (or similar).
--   This index lets them skip the ~64 deleted rows entirely at the index level
--   rather than as a post-filter, and guards against future larger deletion
--   batches.
--
-- CHECK constraint enforces internal consistency:
--   A row is either "live" (all three fields NULL/false) or "deleted"
--   (is_deleted = true, deletion_effective_date NOT NULL). replacement_codes
--   is allowed to be NULL even when deleted (SABER sometimes lists no alts).
--
-- Source: data/saber-deleted-codes.csv, generated from hscodes-1-2026.pdf
-- (SABER platform deletion notifications, cycles 2025-06-01 → 2025-11-27).
-- Re-seeded via 0022_hs_codes_deletion_seed.sql and pnpm db:seed:deleted.
-- ============================================================================

ALTER TABLE hs_codes
  ADD COLUMN IF NOT EXISTS is_deleted              boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS deletion_effective_date date,
  ADD COLUMN IF NOT EXISTS replacement_codes       jsonb;
--> statement-breakpoint

-- Partial index: retrieval hot path only touches active rows.
CREATE INDEX IF NOT EXISTS hs_codes_active_idx
  ON hs_codes (code)
  WHERE is_deleted = false;
--> statement-breakpoint

-- Consistency constraint: deleted rows must have an effective date.
ALTER TABLE hs_codes
  ADD CONSTRAINT hs_codes_deletion_consistency_chk CHECK (
    (is_deleted = false
      AND deletion_effective_date IS NULL
      AND replacement_codes IS NULL)
    OR
    (is_deleted = true
      AND deletion_effective_date IS NOT NULL)
  );
--> statement-breakpoint
