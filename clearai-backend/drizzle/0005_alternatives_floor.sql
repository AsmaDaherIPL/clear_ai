-- ============================================================================
-- 0005_alternatives_floor.sql
--
-- Adds two setup_meta tunables that control the user-facing alternatives
-- list filter (src/decision/filter-alternatives.ts).
--
-- Why this exists:
--   RRF (vector + BM25 + trigram) is a fusion of *ranked* lists, normalised
--   to [0, 1] *within this query*. Once strong matches are exhausted, the
--   long tail still gets surfaced and rescaled upward — so users saw
--   "Bathing headgear at 80%" listed as an alternative to wireless
--   headphones simply because nothing better was left in the catalog. The
--   picker (Sonnet) correctly ignored these candidates when picking, but
--   the alternatives surface is downstream of the picker and dumped raw
--   top-K. Two-rule filter: absolute score floor + chapter coherence with
--   an escape hatch for genuinely close cross-chapter siblings.
--
-- Idempotent: ON CONFLICT DO NOTHING preserves operator overrides.
-- ============================================================================

INSERT INTO setup_meta (key, value, description) VALUES
  ('MIN_ALT_SCORE',    '0.55', 'Absolute RRF floor for surfaced alternatives. Drops noise the picker already ignored — RRF rescales the long tail upward, so without this floor users see "Bathing headgear at 80%" alongside genuine matches.'),
  ('STRONG_ALT_RATIO', '0.95', 'Cross-chapter ratio against the top retrieval score. A cross-chapter candidate only survives if score >= topScore * STRONG_ALT_RATIO. 0.95 means "must be within 5% of the top score" — a genuine near-tie. Lets wired vs wireless headphones both through while killing rows that just share a token with the query.')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint

UPDATE setup_meta
   SET value_numeric = (value)::double precision,
       value_kind    = 'number'
 WHERE key IN ('MIN_ALT_SCORE', 'STRONG_ALT_RATIO')
   AND value_numeric IS NULL;
--> statement-breakpoint
