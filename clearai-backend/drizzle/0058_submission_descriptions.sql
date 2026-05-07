-- Migration 0058 — submission_descriptions lookup table.
--
-- Memoizes the Stage 2.5 (submission_description) LLM output by the two
-- inputs that semantically determine it:
--
--   • path_ar                  — the chosen code's bilingual breadcrumb
--                                 (zatca_hs_code_display.path_ar). The LLM
--                                 conditions its Arabic on this catalog text.
--   • cleaned_description_norm — the user's input after NFKC + lowercase +
--                                 whitespace collapse. Normalising at the
--                                 lookup key means casing / extra whitespace /
--                                 NBSP / Arabic comma vs Latin comma all
--                                 collapse to one entry per semantic input.
--
-- Cross-operator: the table is intentionally NOT keyed on operator_id /
-- operator_slug. The LLM's Arabic output is conditioned on catalog text,
-- not operator preference — so two different operators classifying the
-- same input to the same path get the same AR. Sharing the table lets
-- every operator benefit from every other's history.
--
-- Write policy: only insert when submission-description.ts returned
-- invoked='llm' (a clean LLM result). Deterministic fallbacks
-- ('fallback' / 'fallback_after_collision' / 'llm_failed') are cheap to
-- recompute and would pollute the lookup with low-quality strings.

CREATE TABLE submission_descriptions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  path_ar                   text NOT NULL,
  cleaned_description_norm  text NOT NULL,
  -- Raw form retained for debugging / inspection only. Lookups go via
  -- the _norm column.
  cleaned_description_raw   text NOT NULL,
  description_ar            text NOT NULL,
  source                    text NOT NULL,
  model                     text,
  hit_count                 integer NOT NULL DEFAULT 0,
  created_at                timestamptz NOT NULL DEFAULT now(),
  last_hit_at               timestamptz,
  CONSTRAINT submission_descriptions_uniq
    UNIQUE (path_ar, cleaned_description_norm)
);

-- The UNIQUE constraint already creates an implicit btree on
-- (path_ar, cleaned_description_norm). No additional index needed —
-- the unique-index serves both the constraint and the read path.
