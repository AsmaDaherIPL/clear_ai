-- ============================================================================
-- 0010_submission_description.sql
--
-- Phase 5 of the v3 alternatives redesign: 1–3 word ZATCA-safe Arabic
-- submission description, deterministic distinctness check vs catalog AR,
-- deterministic prefix-mutation fallback. See ADR-0016 and
-- src/decision/submission-description.ts.
-- ============================================================================

INSERT INTO setup_meta (key, value, description) VALUES
  ('SUBMISSION_DESC_ENABLED',     '1',   'Feature flag: 1 = generate the 1–3 word Arabic submission description (Sonnet, with deterministic post-check); 0 = skip. Default 1 because this is the explicit broker-facing requirement that drove Phase 5. Boolean encoded as 0/1.'),
  ('SUBMISSION_DESC_MAX_TOKENS',  '300', 'Cap on tokens the submission-description LLM may emit. Default 300 — JSON is small (3 short fields) but we leave headroom for the rationale field which can be a sentence.')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint

UPDATE setup_meta
   SET value_numeric = (value)::double precision,
       value_kind    = 'number'
 WHERE key IN ('SUBMISSION_DESC_ENABLED', 'SUBMISSION_DESC_MAX_TOKENS')
   AND value_numeric IS NULL;
--> statement-breakpoint

ALTER TABLE setup_meta
  DROP CONSTRAINT IF EXISTS setup_meta_submission_desc_enabled_chk;
--> statement-breakpoint

ALTER TABLE setup_meta
  ADD CONSTRAINT setup_meta_submission_desc_enabled_chk
    CHECK (
      key <> 'SUBMISSION_DESC_ENABLED'
      OR value_numeric IN (0, 1)
    );
--> statement-breakpoint
