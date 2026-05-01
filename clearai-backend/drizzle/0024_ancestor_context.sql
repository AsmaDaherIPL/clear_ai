-- ============================================================================
-- 0024_ancestor_context.sql
--
-- Adds searchable_description_en / searchable_description_ar columns to
-- hs_codes. These store ancestor-enriched text built at ingest time by
-- src/scripts/ingest.ts: the leaf's raw description is prefixed by every
-- parent row's description within the same heading, joined with " > ".
--
-- Example for 640299000000 ("- - Other"):
--   searchable_description_en =
--     "Other footwear with outer soles and uppers of rubber or plastics
--      > Other footwear : > Other"
--
-- This makes ~1,492 "Other"/"غيرها" leaf nodes retrievable by all three
-- retrieval arms (vector, BM25, trigram). Previously their descriptions
-- contained only "Other" which has zero discriminating semantic signal.
--
-- The display columns (description_en / description_ar) are unchanged —
-- they continue to show the raw xlsx text in the API response.
--
-- Impact on existing indexes / triggers:
--   • tsv_en / tsv_ar triggers are updated to index the enriched columns
--     instead of the raw display columns (more signal for BM25).
--   • New trgm indexes on searchable_description_* replace the old ones
--     on description_en / description_ar for the trigram arm.
--   • The old trgm indexes are dropped (they now get zero benefit and
--     waste index maintenance budget).
--   • HNSW stays on (embedding) — embeddings are already re-embedded
--     from the enriched text by the re-run of pnpm db:ingest.
-- ============================================================================

-- 1. Add the two enriched-text columns.
ALTER TABLE hs_codes
  ADD COLUMN IF NOT EXISTS searchable_description_en text,
  ADD COLUMN IF NOT EXISTS searchable_description_ar text;
--> statement-breakpoint

-- 2. Drop the old trgm indexes (they point at display columns — low signal).
DROP INDEX IF EXISTS hs_codes_desc_en_trgm;
--> statement-breakpoint
DROP INDEX IF EXISTS hs_codes_desc_ar_trgm;
--> statement-breakpoint

-- 3. New trgm indexes on the enriched columns.
CREATE INDEX IF NOT EXISTS hs_codes_search_en_trgm
  ON hs_codes USING gin (searchable_description_en gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS hs_codes_search_ar_trgm
  ON hs_codes USING gin (searchable_description_ar gin_trgm_ops);
--> statement-breakpoint

-- 4. Update the tsv trigger to use enriched columns.
--    Falls back to display column if searchable_* is NULL (pre-reingest rows).
CREATE OR REPLACE FUNCTION hs_codes_tsv_refresh() RETURNS trigger AS $$
BEGIN
  NEW.tsv_en := to_tsvector('english',
    unaccent(coalesce(NEW.searchable_description_en, NEW.description_en, '')));
  NEW.tsv_ar := to_tsvector('simple',
    unaccent(coalesce(NEW.searchable_description_ar, NEW.description_ar, '')));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- The trigger definition itself is unchanged — it fires on the same
-- columns; the function body now reads searchable_description_* first.
-- No DROP/CREATE trigger needed — CREATE OR REPLACE on the function
-- takes effect for future inserts immediately.
