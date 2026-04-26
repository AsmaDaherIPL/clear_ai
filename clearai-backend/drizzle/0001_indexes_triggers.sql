-- HNSW vector index for cosine similarity (pgvector >= 0.5)
CREATE INDEX IF NOT EXISTS hs_codes_embedding_hnsw
  ON hs_codes USING hnsw (embedding vector_cosine_ops);
--> statement-breakpoint

-- GIN indexes on tsvector columns for BM25-style full-text search
CREATE INDEX IF NOT EXISTS hs_codes_tsv_en_idx
  ON hs_codes USING gin (tsv_en);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS hs_codes_tsv_ar_idx
  ON hs_codes USING gin (tsv_ar);
--> statement-breakpoint

-- pg_trgm fuzzy match indexes on raw description columns
CREATE INDEX IF NOT EXISTS hs_codes_desc_en_trgm
  ON hs_codes USING gin (description_en gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS hs_codes_desc_ar_trgm
  ON hs_codes USING gin (description_ar gin_trgm_ops);
--> statement-breakpoint

-- tsvector triggers: keep tsv_en / tsv_ar in sync with descriptions.
-- We use 'simple' for Arabic (no native dictionary in core PG); 'english' for EN.
CREATE OR REPLACE FUNCTION hs_codes_tsv_refresh() RETURNS trigger AS $$
BEGIN
  NEW.tsv_en := to_tsvector('english', unaccent(coalesce(NEW.description_en, '')));
  NEW.tsv_ar := to_tsvector('simple',  unaccent(coalesce(NEW.description_ar, '')));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS hs_codes_tsv_trigger ON hs_codes;
--> statement-breakpoint
CREATE TRIGGER hs_codes_tsv_trigger
  BEFORE INSERT OR UPDATE OF description_en, description_ar
  ON hs_codes
  FOR EACH ROW EXECUTE FUNCTION hs_codes_tsv_refresh();
--> statement-breakpoint

-- Seed setup_meta with placeholder Evidence Gate thresholds (tuned later via eval set)
INSERT INTO setup_meta (key, value, description) VALUES
  ('MIN_SCORE_describe', '0.30', 'Evidence Gate: minimum top retrieval score for /classify/describe'),
  ('MIN_GAP_describe',   '0.04', 'Evidence Gate: minimum top1-top2 gap for /classify/describe'),
  ('MIN_SCORE_expand',   '0.20', 'Evidence Gate: minimum top retrieval score for /classify/expand'),
  ('MIN_GAP_expand',     '0.03', 'Evidence Gate: minimum top1-top2 gap for /classify/expand'),
  ('MIN_SCORE_boost',    '0.20', 'Evidence Gate: minimum top retrieval score for /boost'),
  ('MIN_GAP_boost',      '0.03', 'Evidence Gate: minimum top1-top2 gap for /boost'),
  ('BOOST_MARGIN',       '0.05', '/boost short-circuit: minimum margin a sibling must beat current code by'),
  ('RRF_K',              '60',   'Reciprocal Rank Fusion constant')
ON CONFLICT (key) DO NOTHING;
