-- ============================================================================
-- 0086_pr3_manifest_aware_bundler.sql
--
-- PR3 cleanup migration. Two changes:
--
-- 1. Drop the legacy `classification_events` rows that pre-date the
--    manifest/AWB hierarchy. 69 rows confirmed by the 2026-05-18 product
--    decision — they're old enough that synthesising AWB/manifest links
--    for them would be lies-on-disk; cleaner to drop them than to fake
--    the FK.
--
-- 2. Replace the LV-pool SAR cap with the line-item cap + add the
--    cross-manifest config flag:
--    - DELETE setup_meta WHERE key='ZATCA_LV_INVOICE_CAP_SAR'
--    - INSERT setup_meta('ZATCA_LV_CROSS_MANIFEST_ALLOWED', 0)
--      (boolean stored as numeric: 0 = false, 1 = true. Drives the
--      bundler's manifest-scoping behaviour. Default off per the
--      2026-05-18 customs spec.)
--
-- ZATCA_BUNDLE_SIZE stays at 9999 per the user's 2026-05-18 confirmation
-- ("keep it now"); the new 10,000-line-item cap is documented in the
-- bundler but enforced via the existing key.
--
-- Idempotent.
-- ============================================================================

-- ---------- Drop legacy classification_events rows (one-shot, per product decision) ----------
-- Only delete rows that pre-date PR1 (the rename). Anything written after
-- the rename is by definition under the new schema and may have or will
-- have AWB linkage from PR3 onwards.

DELETE FROM classification_events
 WHERE created_at < '2026-05-18 00:00:00+00';

-- ---------- Remove ZATCA_LV_INVOICE_CAP_SAR ----------
DELETE FROM setup_meta WHERE key = 'ZATCA_LV_INVOICE_CAP_SAR';

-- ---------- Add ZATCA_LV_CROSS_MANIFEST_ALLOWED (default off) ----------
INSERT INTO setup_meta (key, value_numeric, value_kind)
VALUES ('ZATCA_LV_CROSS_MANIFEST_ALLOWED', 0, 'number')
ON CONFLICT (key) DO NOTHING;
