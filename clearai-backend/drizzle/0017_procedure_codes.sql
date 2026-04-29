-- ============================================================================
-- 0017_procedure_codes.sql
--
-- Lookup table for ZATCA "import/export procedures" codes referenced by
-- `hs_codes.procedures` (a comma-separated string like "2,28,61"). Sourced
-- from دليل_رموز_إجراءات_فسح_وتصدير_السلع — the official ZATCA procedures
-- guide (~111 codes, Arabic-only descriptions, codes 1–113 with gaps).
--
-- Stored as varchar(8) keys (not int) for two reasons:
--   1. Future ZATCA revisions might introduce sub-codes ("23a") or zero-
--      padded codes — varchar tolerates both without a migration.
--   2. Joins from `hs_codes.procedures` (text "2,28") are simpler with
--      string equality than with `to_int` casts.
--
-- `is_repealed` materialises the `(ملغي)` marker baked into ~25 of the
-- descriptions. The frontend can choose to grey-out or hide repealed
-- procedures rather than acting on guidance ZATCA itself has retired.
--
-- The `(ملغي)` suffix stays inside `description_ar` verbatim — it's part
-- of the official text. We just precompute the boolean for fast filtering.
-- ============================================================================

CREATE TABLE IF NOT EXISTS procedure_codes (
  code           varchar(8)  PRIMARY KEY,
  description_ar text        NOT NULL,
  is_repealed    boolean     NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS procedure_codes_repealed_idx
  ON procedure_codes (is_repealed)
  WHERE is_repealed = false;
--> statement-breakpoint
