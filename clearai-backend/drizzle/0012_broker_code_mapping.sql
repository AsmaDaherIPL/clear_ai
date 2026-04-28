-- ============================================================================
-- 0012_broker_code_mapping.sql
--
-- Phase 7 — broker-curated HS-code mapping lookup.
--
-- Source data: clear_ai/naqel-shared-data/Naqel_HS_code_mapping_lookup.xlsx,
-- a ~500-row hand-curated table the broker built over time mapping
-- bad/old/mistyped merchant HS codes to the correct 12-digit ZATCA code +
-- the canonical Arabic description used in submissions.
--
-- This table is the broker's accumulated wisdom — every row represents
-- a case where the merchant supplied a code that didn't exist in ZATCA's
-- catalog (or existed but was wrong for the actual product) and the
-- broker hand-corrected it. Reading these mappings BEFORE invoking the
-- LLM picker on `/classify/expand` short-circuits the long tail of
-- recurring "merchant gives wrong code" cases with deterministic
-- ground-truth — no LLM call, no retrieval, just SQL.
--
-- Schema choices:
--   - `client_code_norm` is the digit-only normalised form (dots, spaces,
--     and trailing zeros NOT stripped — we want exact-match lookup since
--     the broker's table is keyed on the literal merchant input). This is
--     the lookup key.
--   - `target_code` is always 12 digits (CHECK enforces). Bad-output rows
--     in the source file are filtered out at ingest, not imported.
--   - `target_description_ar` is the broker's preferred submission AR
--     for this code; may be null if the source row didn't have one.
--   - `unit_per_price` (numeric, optional) carries the broker's
--     unit-pricing flag from the source; we don't use it in classification
--     but preserve it for round-trip parity.
--
-- The table is replaceable wholesale: re-running the ingest with a fresh
-- xlsx truncates and re-inserts. We don't try to do diff-merging because
-- the source file is the source of truth and edits happen in Excel.
-- ============================================================================

CREATE TABLE IF NOT EXISTS broker_code_mapping (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at               timestamptz NOT NULL DEFAULT now(),
  -- Digit-only normalisation of the broker's input column (e.g. "9018.12.0000"
  -- becomes "901812000000"). We do NOT zero-pad to 12 — the lookup must
  -- match the merchant's exact code, including its precision (8 / 10 / 12).
  client_code_norm         varchar(14) NOT NULL,
  -- Always 12-digit ZATCA leaf. Rows in the source file with non-12-digit
  -- outputs are skipped at ingest with a logged warning.
  target_code              varchar(12) NOT NULL,
  target_description_ar    text,
  unit_per_price           numeric,
  -- Free-text source-file annotation for traceability ("R013", "row 79", etc.)
  source_row_ref           varchar(32),

  CONSTRAINT broker_code_mapping_client_digit_chk
    CHECK (client_code_norm ~ '^[0-9]+$' AND length(client_code_norm) BETWEEN 4 AND 14),
  CONSTRAINT broker_code_mapping_target_digit_chk
    CHECK (target_code ~ '^[0-9]{12}$'),
  -- Self-mapping rows are data errors in the source — the broker meant to
  -- correct something but left both columns identical. We filter them at
  -- ingest, but the CHECK is the safety net.
  CONSTRAINT broker_code_mapping_no_self_map_chk
    CHECK (client_code_norm <> target_code)
);
--> statement-breakpoint

-- Lookup is "given a merchant input, what does the broker say maps to?"
-- Always exact-match on the normalised code → btree on client_code_norm
-- is sufficient. UNIQUE because the broker's intent is one canonical
-- target per input; a duplicate is a data error and should fail loudly
-- at ingest rather than silently last-write-wins.
CREATE UNIQUE INDEX IF NOT EXISTS broker_code_mapping_client_norm_uniq
  ON broker_code_mapping (client_code_norm);
--> statement-breakpoint

-- Reverse lookup ("which merchant codes does the broker route to this
-- target?") for offline analysis. Non-unique (target_code repeats —
-- e.g. multiple cotton clothing inputs all map to 620442000000).
CREATE INDEX IF NOT EXISTS broker_code_mapping_target_idx
  ON broker_code_mapping (target_code);
--> statement-breakpoint
