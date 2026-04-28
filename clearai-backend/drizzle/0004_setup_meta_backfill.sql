-- ============================================================================
-- 0004_setup_meta_backfill.sql
--
-- Why this exists:
--   Earlier migrations (0001, 0002) were edited in-place to add new
--   setup_meta keys (notably UNDERSTOOD_MAX_DISTINCT_CHAPTERS). Drizzle's
--   migrator hashes migrations by content and skips already-applied ones —
--   so an environment that ran 0001 *before* the edit will never pick up
--   the added INSERT, and its DB stays missing the key. This produced a
--   503 in prod even though logs showed `[migrate] up to date`: the loader
--   (ADR-0009 fail-closed) refused to operate.
--
-- What this does:
--   Re-asserts every numeric key the v2 loader (REQUIRED_NUMERIC_KEYS in
--   src/decision/setup-meta.ts) expects. ON CONFLICT DO NOTHING so any
--   operator override or earlier-seeded value is preserved; only genuinely
--   missing rows are inserted. Same backfill for value_numeric / value_kind
--   as 0002 + 0003 used.
--
-- This migration is idempotent: running it on a fully-seeded DB is a no-op
-- (every INSERT collides with the unique key, every UPDATE is gated on
-- value_numeric IS NULL).
-- ============================================================================

INSERT INTO setup_meta (key, value, description) VALUES
  -- Evidence Gate thresholds (per-route)
  ('MIN_SCORE_describe',          '0.30', 'Minimum RRF score for /classify/describe acceptance'),
  ('MIN_GAP_describe',            '0.05', 'Minimum RRF gap between top-1 and top-2 for /classify/describe acceptance'),
  ('MIN_SCORE_expand',            '0.30', 'Minimum RRF score for /classify/expand acceptance'),
  ('MIN_GAP_expand',              '0.05', 'Minimum RRF gap for /classify/expand acceptance'),
  ('MIN_SCORE_boost',             '0.30', 'Minimum RRF score for /boost acceptance'),
  ('MIN_GAP_boost',               '0.05', 'Minimum RRF gap for /boost acceptance'),
  ('BOOST_MARGIN',                '0.05', 'Margin a sibling must beat the current code by, in /boost'),
  ('RRF_K',                       '60',   'Reciprocal-rank-fusion constant'),

  -- v2 understanding signal + retrieval shape
  ('UNDERSTOOD_MAX_DISTINCT_CHAPTERS', '3', 'Max distinct HS-2 chapters in top-N retrieval before input is treated as not-understood and routed to LLM researcher'),
  ('UNDERSTOOD_TOP_K_describe',     '5',   'Window size (top-N retrieval candidates) inspected by the chapter-coherence understanding check on /classify/describe'),
  ('RETRIEVAL_TOP_K_describe',      '12',  'Number of candidates pulled from pgvector + lexical RRF for /classify/describe'),
  ('PICKER_CANDIDATES_describe',    '8',   'Number of candidates fed to the LLM picker for /classify/describe'),
  ('ALTERNATIVES_SHOWN_describe',   '5',   'Number of alternatives surfaced to the user for /classify/describe'),
  ('RESEARCHER_MAX_TOKENS',         '250', 'Token cap on the strong-model researcher (JSON output)'),
  ('BEST_EFFORT_MAX_TOKENS',        '200', 'Token cap on the best-effort fallback LLM call'),
  ('BEST_EFFORT_ENABLED',           '1',   'Feature flag: 0 = disabled (route returns needs_clarification on hard cases); 1 = enabled (route attempts a chapter-level best-effort heading with confidence_band=low). Boolean encoded as 0/1.'),
  ('BEST_EFFORT_MAX_DIGITS',        '4',   'Maximum specificity (digit count) for best-effort fallback codes. Must be one of {2, 4, 6, 8, 10}. Default 4 — chapter-heading granularity, the least-harmful fallback.')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint

-- Backfill value_numeric / value_kind for any rows where they're still null.
-- Existing values (incl. operator overrides) are left intact.
UPDATE setup_meta
   SET value_numeric = (value)::double precision,
       value_kind    = 'number'
 WHERE key IN (
    'MIN_SCORE_describe', 'MIN_GAP_describe',
    'MIN_SCORE_expand',   'MIN_GAP_expand',
    'MIN_SCORE_boost',    'MIN_GAP_boost',
    'BOOST_MARGIN',       'RRF_K',
    'UNDERSTOOD_MAX_DISTINCT_CHAPTERS',
    'UNDERSTOOD_TOP_K_describe',
    'RETRIEVAL_TOP_K_describe',
    'PICKER_CANDIDATES_describe',
    'ALTERNATIVES_SHOWN_describe',
    'RESEARCHER_MAX_TOKENS',
    'BEST_EFFORT_MAX_TOKENS',
    'BEST_EFFORT_ENABLED',
    'BEST_EFFORT_MAX_DIGITS'
   )
   AND value_numeric IS NULL;
--> statement-breakpoint
