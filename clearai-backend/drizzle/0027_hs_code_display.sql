-- ============================================================================
-- 0027_hs_code_display.sql
--
-- Adds the hs_code_display table — derived display + explainability data
-- for every row in hs_codes. Created empty here; populated by the
-- ingest pipeline (src/scripts/ingest-hs-code-display.ts) which can be
-- re-run independently of the main ZATCA xlsx ingest.
--
-- Why a separate table (ADR-0025):
--   • hs_codes stays the verbatim ZATCA source-of-truth.
--   • Derived strings (cleaned label, breadcrumb path, declarability flag)
--     live here so re-deriving is a single TRUNCATE + re-populate, no
--     risk of corrupting the source rows.
--   • Future RAG / chatbot / batch flows all share the same explainability
--     primitives (label_en, path_en, path_codes) — derived once, used N times.
--
-- Read consumers (wired in commit #6):
--   • API response shape: result.label_en, result.path_en
--   • Picker prompt: structured ancestor context
--   • Audit log: cleaned code identity instead of dash-prefixed raw text
--
-- Submission descriptions (LLM-polished canonical names per code) live
-- here as nullable columns; populated by an optional follow-up script
-- (`pnpm db:seed:descriptions`) that runs Sonnet once per row, ~$10 total.
-- Their absence does not block any read path.
-- ============================================================================

CREATE TABLE IF NOT EXISTS hs_code_display (
  -- 1:1 mirror of hs_codes; cascade ensures this table never holds rows
  -- whose source row has been deleted.
  code char(12) PRIMARY KEY REFERENCES hs_codes(code) ON DELETE CASCADE,

  -- Cleaned own-row label (dashes stripped). What the API surfaces.
  -- e.g. "Other" for 640299000000 (raw was "- - Other").
  label_en text NOT NULL,
  label_ar text,

  -- Full breadcrumb path joined by " > ". For frontend rendering, picker
  -- rationale, and broker error messages.
  -- e.g. "Other footwear with outer soles… > Other footwear > Other"
  path_en text NOT NULL,
  path_ar text,

  -- Ancestor codes in hierarchy order (root → self). JSONB array of 12-digit
  -- strings. Required (NOT NULL) — every code has at minimum [self].
  -- e.g. ["640200000000", "640290000000", "640299000000"]
  path_codes jsonb NOT NULL,

  -- Hierarchy depth derived from leading-dash count of description_en.
  --   0 = heading-padded row (XXXX00000000)
  --   1 = "- Sports footwear"
  --   2 = "- - Other :"
  --   3 = "- - - For men and boys"
  --   4 = full leaf with no dashes (e.g. "Soccer shoes…")
  depth smallint NOT NULL,

  -- Flags
  is_generic_label boolean NOT NULL DEFAULT false,  -- true for "Other"/"غيرها"
  is_declarable boolean NOT NULL,                    -- replaces is_leaf semantically

  -- LLM-polished canonical name per code. Generated once, served forever.
  -- NULL until `pnpm db:seed:descriptions` runs. The picker / API can fall
  -- back to label_en when null.
  submission_description_en text,
  submission_description_ar text,
  submission_desc_model text,                        -- e.g. "claude-sonnet-4-5@2026-04"
  submission_desc_generated_at timestamptz,

  derived_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT hs_code_display_path_codes_nonempty_chk
    CHECK (jsonb_array_length(path_codes) >= 1),
  CONSTRAINT hs_code_display_depth_chk
    CHECK (depth BETWEEN 0 AND 5)
);
--> statement-breakpoint

-- GIN index on path_codes enables "find all codes whose path includes X"
-- queries via jsonb containment (used by /classifications/expand to
-- enumerate descendants, and by frontend "click ancestor" navigation).
CREATE INDEX IF NOT EXISTS hs_code_display_path_codes_gin
  ON hs_code_display USING gin (path_codes);
--> statement-breakpoint

-- Partial index on declarable codes — the hot filter for retrieval.
CREATE INDEX IF NOT EXISTS hs_code_display_declarable_idx
  ON hs_code_display(code) WHERE is_declarable = true;
--> statement-breakpoint

-- Lookup index for "is this code's label generic?" — used by the picker
-- to apply the "prefer specific sibling if any" tie-break logic.
CREATE INDEX IF NOT EXISTS hs_code_display_generic_idx
  ON hs_code_display(is_generic_label);
--> statement-breakpoint
