-- ============================================================================
-- 0015_research_web.sql
--
-- Phase F — web-search-augmented researcher feature flag + token cap.
-- See ADR-0021 and src/preprocess/research-with-web.ts for the full rationale.
--
-- Default 0 (off) so the first deploy ships disabled. Flip to 1 once
-- measurement on real traffic justifies the extra Sonnet + hosted-tool
-- round-trip on the UNKNOWN branch.
-- ============================================================================

INSERT INTO setup_meta (key, value, description) VALUES
  ('RESEARCH_WEB_ENABLED',     '0',   'Feature flag: 1 = on UNKNOWN from the standard researcher, fire one Anthropic-hosted web_search tool call to fetch external evidence and re-attempt identification; 0 = stop at UNKNOWN. Default 0 — flip after measuring cost/quality on real traffic. Each call adds ~3-5s. Boolean encoded as 0/1.'),
  ('RESEARCH_WEB_MAX_TOKENS',  '400', 'Cap on tokens the web-augmented researcher may emit. JSON payload is small; budget mostly pays for the model synthesising search snippets into the canonical description.')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint

UPDATE setup_meta
   SET value_numeric = (value)::double precision,
       value_kind    = 'number'
 WHERE key IN ('RESEARCH_WEB_ENABLED', 'RESEARCH_WEB_MAX_TOKENS')
   AND value_numeric IS NULL;
--> statement-breakpoint

ALTER TABLE setup_meta
  DROP CONSTRAINT IF EXISTS setup_meta_research_web_enabled_chk;
--> statement-breakpoint

ALTER TABLE setup_meta
  ADD CONSTRAINT setup_meta_research_web_enabled_chk
    CHECK (
      key <> 'RESEARCH_WEB_ENABLED'
      OR value_numeric IN (0, 1)
    );
--> statement-breakpoint
