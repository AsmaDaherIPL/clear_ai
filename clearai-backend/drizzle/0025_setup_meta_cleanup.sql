-- ============================================================================
-- 0025_setup_meta_cleanup.sql
--
-- Cleans up dead /boost-route configuration from setup_meta and renames
-- BROKER_MAPPING_ENABLED → TENANT_OVERRIDES_ENABLED ahead of the
-- broker_code_mapping → tenant_code_overrides table rename in commit #2.
--
-- Why this is safe:
--   • There is no /boost route handler in src/routes/. The MIN_SCORE_boost,
--     MIN_GAP_boost, and BOOST_MARGIN keys were seeded in 0001 / 0002 / 0004
--     for a route that was never built (or was removed). They have no
--     readers in the application code today — only declarations in
--     src/catalog/setup-meta.ts that we remove in the same commit.
--
--   • The single string mention of "BOOST_MARGIN" inside resolve.ts is a
--     legacy rationale string, not a runtime read of the config value;
--     it is rewritten in the same commit so the user-visible message no
--     longer references a deleted key.
--
--   • BROKER_MAPPING_ENABLED is renamed (not deleted) — value preserved.
--     Commit #2 renames the table; this commit aligns the flag name so
--     the code change set is self-consistent.
--
--   • The CHECK constraint that pinned the old key name to {0,1} is
--     dropped and re-added under the new key name.
-- ============================================================================

-- 1. Drop the three /boost route configuration keys. No code reads these.
DELETE FROM setup_meta
 WHERE key IN ('MIN_SCORE_boost', 'MIN_GAP_boost', 'BOOST_MARGIN');
--> statement-breakpoint

-- 2. Rename BROKER_MAPPING_ENABLED → TENANT_OVERRIDES_ENABLED.
--    Done as UPDATE rather than DELETE+INSERT so the value (0 or 1) is
--    preserved across the rename — environments that disabled the flag
--    stay disabled.
UPDATE setup_meta
   SET key = 'TENANT_OVERRIDES_ENABLED',
       description = 'Feature flag: 1 = on /classifications/expand, check tenant_code_overrides first and short-circuit to the tenant''s canonical target if the source code is present; 0 = bypass entirely. Default 1 — tenant overrides embody accumulated wisdom and should be trusted ahead of the LLM where they have an answer. Boolean encoded as 0/1.'
 WHERE key = 'BROKER_MAPPING_ENABLED';
--> statement-breakpoint

-- 3. Backfill the empty description on UNDERSTOOD_MAX_DISTINCT_CHAPTERS that
--    the audit caught (originally seeded with description = '' in 0001).
UPDATE setup_meta
   SET description = 'Max distinct HS-2 chapters across the top-N retrieval window (UNDERSTOOD_TOP_K_describe sets N) before classification is treated as not-understood and routed to the LLM researcher.'
 WHERE key = 'UNDERSTOOD_MAX_DISTINCT_CHAPTERS'
   AND coalesce(description, '') = '';
--> statement-breakpoint

-- 4. Swap the CHECK constraint to gate the renamed key.
--    The old constraint name was set in 0013_broker_mapping_flag.sql.
ALTER TABLE setup_meta
  DROP CONSTRAINT IF EXISTS setup_meta_broker_mapping_enabled_chk;
--> statement-breakpoint

ALTER TABLE setup_meta
  ADD CONSTRAINT setup_meta_tenant_overrides_enabled_chk
    CHECK (
      key <> 'TENANT_OVERRIDES_ENABLED'
      OR value_numeric IN (0, 1)
    );
--> statement-breakpoint
