-- ============================================================================
-- 0009_alternatives_layered.sql
--
-- Layered alternatives fallback. When the HS-8 branch is sparse (e.g.
-- 1509.20.00 = Extra virgin olive oil has 1 leaf at HS-8), the enumerator
-- widens to HS-6 and ultimately tops up from filtered RRF if needed.
-- ALTERNATIVES_MIN_SHOWN controls the threshold. See ADR-0015 and
-- src/decision/branch-enumerate.ts for the full rationale.
-- ============================================================================

INSERT INTO setup_meta (key, value, description) VALUES
  ('ALTERNATIVES_MIN_SHOWN', '3', 'Minimum non-chosen alternatives to surface to the user. Branch enumerator widens HS-8 → HS-6 to satisfy this; if even HS-6 falls short, the route tops up from filtered RRF candidates (which still respect MIN_ALT_SCORE so noise stays out). Default 3 — gives the user a real comparison set without overwhelming the result card.')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint

UPDATE setup_meta
   SET value_numeric = (value)::double precision,
       value_kind    = 'number'
 WHERE key = 'ALTERNATIVES_MIN_SHOWN'
   AND value_numeric IS NULL;
--> statement-breakpoint
