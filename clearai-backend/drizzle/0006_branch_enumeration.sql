-- ============================================================================
-- 0006_branch_enumeration.sql
--
-- Phase 1 of the v3 alternatives redesign: deterministic branch-local
-- enumeration replaces RRF-sourced alternatives for accepted classifications.
-- See src/decision/branch-enumerate.ts for the full rationale.
--
-- Two new tunables, idempotent INSERT.
-- ============================================================================

INSERT INTO setup_meta (key, value, description) VALUES
  ('BRANCH_PREFIX_LENGTH', '8',  'Prefix length (digits) used to enumerate the branch under an accepted chosen code. One of {4, 6, 8}: 4 = heading, 6 = subheading, 8 = national subheading (default). HS-8 was chosen as default after testing showed HS-6 mixes structurally-related but commercially-distinct families (e.g. wireless headphones with telephone exchange equipment); HS-8 keeps comparisons within the same national leaf family ("Other wireless apparatus": headphones / smart watches / GPS trackers / smart glasses).'),
  ('BRANCH_MAX_LEAVES',   '50', 'Hard cap on leaves returned by branch enumeration. Keeps response payloads bounded even when an HS-4 enumeration drags in 100+ leaves in dense headings.')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint

UPDATE setup_meta
   SET value_numeric = (value)::double precision,
       value_kind    = 'number'
 WHERE key IN ('BRANCH_PREFIX_LENGTH', 'BRANCH_MAX_LEAVES')
   AND value_numeric IS NULL;
--> statement-breakpoint

-- Defensive CHECK: BRANCH_PREFIX_LENGTH must be one of the canonical HS levels.
ALTER TABLE setup_meta
  DROP CONSTRAINT IF EXISTS setup_meta_branch_prefix_length_chk;
--> statement-breakpoint

ALTER TABLE setup_meta
  ADD CONSTRAINT setup_meta_branch_prefix_length_chk
    CHECK (
      key <> 'BRANCH_PREFIX_LENGTH'
      OR value_numeric IN (4, 6, 8)
    );
--> statement-breakpoint
