-- ============================================================================
-- 0013_broker_mapping_flag.sql
--
-- Seeds the BROKER_MAPPING_ENABLED feature flag for Phase 7. See ADR-0018
-- and src/decision/broker-mapping.ts for the full rationale.
-- ============================================================================

INSERT INTO setup_meta (key, value, description) VALUES
  ('BROKER_MAPPING_ENABLED', '1', 'Feature flag: 1 = on /classify/expand, check broker_code_mapping first and short-circuit to the broker''s canonical target if the merchant code is present; 0 = bypass entirely. Default 1 — the broker''s hand-curated table embodies accumulated wisdom and should be trusted ahead of the LLM where it has an answer. Boolean encoded as 0/1.')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint

UPDATE setup_meta
   SET value_numeric = (value)::double precision,
       value_kind    = 'number'
 WHERE key = 'BROKER_MAPPING_ENABLED'
   AND value_numeric IS NULL;
--> statement-breakpoint

ALTER TABLE setup_meta
  DROP CONSTRAINT IF EXISTS setup_meta_broker_mapping_enabled_chk;
--> statement-breakpoint

ALTER TABLE setup_meta
  ADD CONSTRAINT setup_meta_broker_mapping_enabled_chk
    CHECK (
      key <> 'BROKER_MAPPING_ENABLED'
      OR value_numeric IN (0, 1)
    );
--> statement-breakpoint
