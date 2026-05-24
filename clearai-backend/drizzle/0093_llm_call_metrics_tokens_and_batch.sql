-- ============================================================================
-- 0093_llm_call_metrics_tokens_and_batch.sql
--
-- Extend llm_call_metrics (0078) so per-call cost + per-batch rollups are
-- queryable from the same trace store.
--
-- New columns (all nullable; NULL means "the response didn't carry it"):
--   input_tokens
--     From Anthropic's usage.input_tokens. The standard input lane,
--     billed at the model's input rate (~$3/1M Sonnet, ~$0.80/1M Haiku).
--   output_tokens
--     Billed at the model's output rate (~$15/1M Sonnet, ~$4/1M Haiku).
--   cache_creation_input_tokens
--     The first call in a cache window pays this at ~1.25× input rate.
--     Only present when the request sent `cache_control: ephemeral` AND
--     Foundry/Anthropic honoured it (commits 730074a + this one).
--   cache_read_input_tokens
--     Subsequent calls in the same ~5-min window pay this at ~0.1×
--     input rate. Cache-hits — the cost win.
--   batch_id
--     The owning batch when the call was triggered by a batch row
--     (FK→batches.id). NULL for single-shot dispatches via /classifications.
--     Index supports per-batch cost roll-ups.
--
-- Why nullable: 0078 rows pre-date this migration. Existing data is
-- already in the table and shouldn't break under reporting queries.
-- ============================================================================

ALTER TABLE llm_call_metrics
  ADD COLUMN IF NOT EXISTS input_tokens                integer,
  ADD COLUMN IF NOT EXISTS output_tokens               integer,
  ADD COLUMN IF NOT EXISTS cache_creation_input_tokens integer,
  ADD COLUMN IF NOT EXISTS cache_read_input_tokens     integer,
  ADD COLUMN IF NOT EXISTS batch_id                    uuid;

-- batch_id index for per-batch cost reports.
CREATE INDEX IF NOT EXISTS llm_call_metrics_batch_id_idx
  ON llm_call_metrics (batch_id)
  WHERE batch_id IS NOT NULL;
