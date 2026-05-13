-- 0078_llm_call_metrics.sql
--
-- Per-call observability for the Foundry LLM transport.
--
-- One row per `callLlm` invocation (each retry inside `callLlmWithRetry`
-- is a separate row, with `attempt` = 1-based loop index). Writes are
-- fire-and-forget from finalize() in inference/llm/client.ts — a failing
-- metric insert never blocks the classification call.
--
-- Schema notes:
--   - `outcome_class` mirrors the LlmFailureClass union in breaker.ts:
--     'ok' | 'auth_class' | 'transient' | 'other'. Enforced by CHECK so
--     a code-path bug can't corrupt the aggregation.
--   - `http_status` is parsed from result.error ("HTTP NNN: ...") when the
--     transport surfaced an HTTP error. NULL for timeouts / network errors
--     / clean successes.
--   - `error_class` is the transport-level LlmStatus ('error' | 'timeout')
--     for non-ok results; NULL on success. This pairs with outcome_class
--     for the rare "HTTP 200 with malformed body" case (outcome_class=other,
--     error_class=null).
--
-- Indexing:
--   - ts DESC powers the "last N minutes" window scan
--     (GET /admin/llm-call-metrics).
--   - (stage, ts DESC) powers the per-stage breakdown without scanning the
--     whole window for stages with little traffic.
--
-- Retention / sampling are intentionally out of scope for this migration.

CREATE TABLE llm_call_metrics (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ts            timestamptz NOT NULL DEFAULT now(),
  stage         varchar(64) NOT NULL,
  model         varchar(128) NOT NULL,
  attempt       smallint NOT NULL,
  outcome_class varchar(32) NOT NULL,
  latency_ms    integer NOT NULL,
  http_status   smallint,
  error_class   varchar(32),
  CONSTRAINT llm_call_metrics_outcome_class_chk
    CHECK (outcome_class IN ('ok', 'auth_class', 'transient', 'other'))
);
--> statement-breakpoint

CREATE INDEX llm_call_metrics_ts_idx ON llm_call_metrics (ts DESC);
--> statement-breakpoint

CREATE INDEX llm_call_metrics_stage_ts_idx ON llm_call_metrics (stage, ts DESC);
