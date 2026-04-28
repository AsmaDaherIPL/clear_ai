/**
 * MetaPanel — minimal dev-view of the model used + total wall-clock latency.
 *
 * The legacy ProcessPanel rendered a full pipeline timeline + per-LLM-call
 * trace, but the Fastify backend doesn't emit that telemetry yet. We surface
 * just what IS in the response (`model.embedder` + `model.llm`) plus the
 * client-measured round-trip so operators can spot regressions.
 */
import type { ModelInfo } from '../lib/api';

type Props = {
  model: ModelInfo;
  /** Client-side measured RTT — wall-clock from fetch() to JSON parse. */
  clientLatencyMs: number;
};

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`;
}

export default function MetaPanel({ model, clientLatencyMs }: Props) {
  return (
    <div className="proc">
      <div className="proc-head">
        <div className="t">Process &amp; metadata</div>
        <div className="proc-head-meta">
          <span className="devtag">DEV VIEW</span>
        </div>
      </div>

      <div className="proc-hero">
        <div className="proc-hero-latency">
          <div className="k">Round-trip</div>
          <div className="v">{fmtMs(clientLatencyMs)}</div>
        </div>
        <div className="proc-hero-models">
          <span className="model-chip" title="Embedding model used for hybrid retrieval">
            {model.embedder}
          </span>
          {model.llm && (
            <span className="model-chip" title="LLM picker">
              {model.llm}
            </span>
          )}
          {!model.llm && (
            <span className="model-chip model-chip-muted" title="No LLM call (deterministic path: gate failed, /boost, or single descendant)">
              no LLM call
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
