-- Migration 0057 — Plan B step 1: catalog embedding dim 384 → 1024.
--
-- Swaps the in-process Xenova/multilingual-e5-small embedder for Foundry's
-- text-embedding-3-large with Matryoshka truncation to 1024-dim.
--
-- The 384-dim e5-small vectors are NOT comparable to 1024-dim
-- text-embedding-3-large output, so we drop the column entirely (and
-- its HNSW index) and recreate at the new dim. The post-migration
-- reseed step (local-dev/scripts/ingest-zatca-hs-code-search.ts
-- --reembed-only) repopulates ~25k rows in one batch run; takes ~30s
-- and ~$0.10 of Foundry tokens.
--
-- The retrieval endpoint will return empty results during the reseed
-- window. Dev-only — coordinate with ops before re-running on prod.

BEGIN;

-- Drop the old column. CASCADE removes the HNSW index automatically.
ALTER TABLE zatca_hs_code_search DROP COLUMN embedding;

-- Recreate at the new dim. NULL until the reseed runs.
ALTER TABLE zatca_hs_code_search ADD COLUMN embedding vector(1024);

-- Rebuild the HNSW index (cosine ops to match retrieve.ts query operator).
-- Defaults: m=16, ef_construction=64 — same as the original 0028 build.
CREATE INDEX zatca_hs_code_search_embedding_hnsw
  ON zatca_hs_code_search
  USING hnsw (embedding vector_cosine_ops);

-- Tag the embedder version on every row that gets re-embedded so the
-- audit trail makes the dim/model swap visible in produced traces.
-- We don't update embedding_model here; the reseed script writes the
-- new value as part of its UPDATE.

COMMIT;
