-- ============================================================================
-- 0028_hs_code_search.sql
--
-- Adds the hs_code_search table — the dedicated search index for hybrid
-- retrieval (dense + sparse + sparse-fuzzy). One row per hs_codes row.
--
-- Why a separate table (ADR-0025):
--   • Search-index data is build artifact, not catalog data. Splitting it
--     out lets the source-of-truth table (hs_codes) stay narrow and avoid
--     re-running embeddings/triggers on unrelated UPDATEs.
--   • Asymmetric retrieval per arm: vector arm reads `embedding_input`
--     (single coherent passage); BM25 + trigram arms read `tsv_input_*`
--     (deduplicated token bag). This lets each arm's input shape be tuned
--     for what that arm rewards (recall vs precision) — which the
--     ADR-0024 single-column approach couldn't do.
--   • is_deleted is mirrored from hs_codes (denormalised) so the hot
--     retrieval path can filter without joining; kept in sync by trigger.
--
-- Both `embedding_input` and `tsv_input_*` are stored as text columns
-- (Option B in ADR-0025) — they are reproducible from hs_codes +
-- hs_code_display by re-running the population script, so they are not
-- a separate source of truth, just provenance for the index.
--
-- Population: src/scripts/ingest-hs-code-search.ts (depends on
-- hs_code_display being populated first).
-- ============================================================================

CREATE TABLE IF NOT EXISTS hs_code_search (
  -- 1:1 mirror of hs_codes; cascade ensures stale rows are cleaned up.
  code char(12) PRIMARY KEY REFERENCES hs_codes(code) ON DELETE CASCADE,

  -- Exact bytes fed to the embedder. Stored for provenance + drift detection.
  -- One coherent passage (sentence-shaped), bilingual.
  embedding_input text NOT NULL,

  -- Lexical text fed to BM25 (via tsv_*) and trigram. Deduplicated token
  -- bag of all path tokens — one occurrence per meaningful word so generic
  -- words like "Other" don't get amplified by repetition across the chain.
  tsv_input_en text NOT NULL,
  tsv_input_ar text,

  -- Dense vector (e5-small, 384-dim).
  embedding vector(384),
  embedding_model text NOT NULL,        -- e.g. "Xenova/multilingual-e5-small@1.0.0"

  -- Sparse arms — populated by trigger from tsv_input_*.
  tsv_en tsvector,
  tsv_ar tsvector,

  -- Denormalised mirror of hs_codes.is_deleted for hot-path filtering
  -- without a join. Kept in sync by the trigger added below.
  is_deleted boolean NOT NULL DEFAULT false,

  -- Build provenance.
  build_version text NOT NULL,           -- git SHA or semver tag of the ingest pipeline
  indexed_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- HNSW index for cosine similarity (pgvector >= 0.5).
CREATE INDEX IF NOT EXISTS hs_code_search_embedding_hnsw
  ON hs_code_search USING hnsw (embedding vector_cosine_ops);
--> statement-breakpoint

-- BM25 GIN indexes.
CREATE INDEX IF NOT EXISTS hs_code_search_tsv_en_idx
  ON hs_code_search USING gin (tsv_en);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS hs_code_search_tsv_ar_idx
  ON hs_code_search USING gin (tsv_ar);
--> statement-breakpoint

-- Trigram GIN indexes on the deduplicated input text.
CREATE INDEX IF NOT EXISTS hs_code_search_tsv_input_en_trgm
  ON hs_code_search USING gin (tsv_input_en gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS hs_code_search_tsv_input_ar_trgm
  ON hs_code_search USING gin (tsv_input_ar gin_trgm_ops);
--> statement-breakpoint

-- Hot-path filter: WHERE is_deleted = false.
CREATE INDEX IF NOT EXISTS hs_code_search_active_idx
  ON hs_code_search(code) WHERE is_deleted = false;
--> statement-breakpoint

-- Trigger: maintain tsv_en / tsv_ar from the deduplicated input columns.
CREATE OR REPLACE FUNCTION hs_code_search_tsv_refresh() RETURNS trigger AS $$
BEGIN
  NEW.tsv_en := to_tsvector('english', unaccent(coalesce(NEW.tsv_input_en, '')));
  NEW.tsv_ar := to_tsvector('simple',  unaccent(coalesce(NEW.tsv_input_ar, '')));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS hs_code_search_tsv_trigger ON hs_code_search;
--> statement-breakpoint
CREATE TRIGGER hs_code_search_tsv_trigger
  BEFORE INSERT OR UPDATE OF tsv_input_en, tsv_input_ar
  ON hs_code_search
  FOR EACH ROW EXECUTE FUNCTION hs_code_search_tsv_refresh();
--> statement-breakpoint

-- Trigger: mirror hs_codes.is_deleted → hs_code_search.is_deleted.
-- This keeps the denormalised flag in sync without requiring application
-- code to remember to UPDATE both tables. Fires on any change to is_deleted.
CREATE OR REPLACE FUNCTION hs_codes_propagate_deletion() RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'UPDATE' AND OLD.is_deleted IS DISTINCT FROM NEW.is_deleted)
     OR TG_OP = 'INSERT' THEN
    UPDATE hs_code_search
       SET is_deleted = NEW.is_deleted
     WHERE code = NEW.code;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS hs_codes_propagate_deletion_trigger ON hs_codes;
--> statement-breakpoint
CREATE TRIGGER hs_codes_propagate_deletion_trigger
  AFTER INSERT OR UPDATE OF is_deleted
  ON hs_codes
  FOR EACH ROW EXECUTE FUNCTION hs_codes_propagate_deletion();
--> statement-breakpoint
