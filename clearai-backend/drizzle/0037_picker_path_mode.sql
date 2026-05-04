-- ============================================================================
-- 0037_picker_path_mode.sql
--
-- Adds the PICKER_PATH_MODE setup_meta key. Controls how candidate paths
-- are formatted in the picker prompt's user message:
--
--   0 = none           — current behaviour (just code + en/ar leaf descriptions)
--   1 = heading-only   — group candidates by HS-4 heading, prefix each group
--                        with `Heading <NNNN> — <heading title>`. Uses
--                        zatca_hs_code_display.path_en[2] / path_ar[2] (1-indexed
--                        in PG: [1]=section, [2]=heading-or-chapter title).
--   2 = full path      — emit per-candidate breadcrumb
--                        `Section › Chapter › Heading › Sub-heading › Leaf`
--                        from zatca_hs_code_display.path_en / path_ar
--
-- Why this exists:
--   The current picker user message gives the model 12 candidates each as
--   `code | description_en | description_ar`. For ZATCA-style catalogs, the
--   leaf description is frequently literally "Other" (~thousands of leaves
--   share that label). Without the parent context, the picker has no way to
--   distinguish e.g. heading 3926 "Other articles of plastics" from heading
--   9615 "Combs, hair-slides...". The eval set's documented broker-vs-AI
--   chapter-39 over-default failures fit this pattern exactly.
--
-- Why a config flag (not just a code change):
--   We want to A/B test mode 0 / 1 / 2 against the 500-row eval suite to
--   measure heading-or-better accuracy delta per mode without re-deploying.
--   `psql -c "UPDATE setup_meta SET value_numeric = N WHERE ..."` + restart
--   is the loop.
--
-- Default 1 (heading-only) — minimal token cost, primary accuracy hypothesis.
-- Mode 2 trades more tokens for more context; eval decides if worth shipping.
-- Mode 0 is the rollback path (set value_numeric = 0, restart).
-- ============================================================================

INSERT INTO setup_meta (key, value, description) VALUES
  ('PICKER_PATH_MODE', '1', 'How candidate path context is injected into the picker prompt: 0 = none (current); 1 = heading-only (group by HS-4 heading, single header per group); 2 = full path breadcrumb per candidate (Section › Chapter › Heading › Sub-heading › Leaf). Numeric encoded as 0/1/2.')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint

UPDATE setup_meta
   SET value_numeric = (value)::double precision,
       value_kind    = 'number'
 WHERE key = 'PICKER_PATH_MODE'
   AND value_numeric IS NULL;
--> statement-breakpoint

ALTER TABLE setup_meta
  DROP CONSTRAINT IF EXISTS setup_meta_picker_path_mode_chk;
--> statement-breakpoint

ALTER TABLE setup_meta
  ADD CONSTRAINT setup_meta_picker_path_mode_chk
    CHECK (
      key <> 'PICKER_PATH_MODE'
      OR value_numeric IN (0, 1, 2)
    );
--> statement-breakpoint
