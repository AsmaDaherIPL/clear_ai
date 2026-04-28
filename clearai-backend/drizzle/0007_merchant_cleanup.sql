-- ============================================================================
-- 0007_merchant_cleanup.sql
--
-- Phase 1.5 of the v3 alternatives redesign: merchant-input cleanup runs
-- BEFORE retrieval, strips brand/SKU/marketing noise from raw merchant
-- descriptions so the embedder + RRF + picker see customs-relevant signal
-- only. See src/preprocess/merchant-cleanup.ts for the full rationale.
--
-- Two new tunables, idempotent INSERT.
-- ============================================================================

INSERT INTO setup_meta (key, value, description) VALUES
  ('MERCHANT_CLEANUP_ENABLED',     '1',   'Feature flag: 1 = run the cleanup pre-step (Haiku strips brand/SKU/marketing on noisy inputs); 0 = bypass entirely, raw input goes straight to retrieval. Boolean encoded as 0/1.'),
  ('MERCHANT_CLEANUP_MAX_TOKENS',  '200', 'Cap on tokens the cleanup LLM may emit. The cleanup output is structured JSON, not prose — 200 is comfortable headroom for even pathological inputs with long stripped-token lists.')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint

UPDATE setup_meta
   SET value_numeric = (value)::double precision,
       value_kind    = 'number'
 WHERE key IN ('MERCHANT_CLEANUP_ENABLED', 'MERCHANT_CLEANUP_MAX_TOKENS')
   AND value_numeric IS NULL;
--> statement-breakpoint

-- MERCHANT_CLEANUP_ENABLED must be 0 or 1 (boolean-as-number convention).
ALTER TABLE setup_meta
  DROP CONSTRAINT IF EXISTS setup_meta_merchant_cleanup_enabled_chk;
--> statement-breakpoint

ALTER TABLE setup_meta
  ADD CONSTRAINT setup_meta_merchant_cleanup_enabled_chk
    CHECK (
      key <> 'MERCHANT_CLEANUP_ENABLED'
      OR value_numeric IN (0, 1)
    );
--> statement-breakpoint
