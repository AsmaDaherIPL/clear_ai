/**
 * ProcessPanel — "Other codes considered" + process metadata grid.
 *
 * Alternatives come from the FAISS evidence (minus the chosen code).
 * The metadata grid is a dev-view, not a customer-facing quality
 * signal — it surfaces model, latency, tokens, and FAISS candidate
 * accounting when the server returns `meta`.
 */
import type { ResolveResponse } from '../lib/api';

type Props = { result: ResolveResponse };

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`;
}

export default function ProcessPanel({ result }: Props) {
  const alts = result.evidence.filter((e) => e.hs_code !== result.hs_code).slice(0, 3);
  const meta = result.meta;
  const stages = result.stages ?? [];

  // Highlight the slowest stage so bottlenecks jump out at a glance.
  const maxStageMs = stages.reduce((m, s) => Math.max(m, s.duration_ms), 0);
  const totalStageMs = stages.reduce((a, s) => a + s.duration_ms, 0) || 1;

  return (
    <div className="proc">
      <div className="proc-head">
        <div className="t">Process &amp; metadata</div>
        <div className="proc-head-meta">
          <span className="devtag">DEV VIEW</span>
          {result.trace_id && <div className="s">trace · {result.trace_id}</div>}
        </div>
      </div>

      {stages.length > 0 && (
        <>
          <div className="proc-sub">Step-by-step timing</div>
          <ul className="stage-rows">
            {stages.map((s) => {
              const pct = Math.round((s.duration_ms / totalStageMs) * 100);
              const isSlow = s.duration_ms === maxStageMs && maxStageMs > 0;
              return (
                <li key={s.key} className={`stage-row ${isSlow ? 'slow' : ''}`}>
                  <span className="stage-key">{s.key}</span>
                  <span className="stage-label">{s.label}</span>
                  <div className="stage-bar">
                    <div className="fill" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="stage-ms">{fmtMs(s.duration_ms)}</span>
                  <span className="stage-pct">{pct}%</span>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {alts.length > 0 && (
        <>
          <div className="proc-sub">Other codes considered</div>
          {alts.map((a) => (
            <div key={`${a.rank}-${a.hs_code}`} className="alt-row">
              <div className="alt-code">{a.hs_code}</div>
              <div className="alt-desc">{a.description_en || '—'}</div>
              <div className="alt-sim">
                <div className="bar">
                  <div className="fill" style={{ width: `${Math.max(0, Math.min(1, a.score)) * 100}%` }} />
                </div>
                sim {a.score.toFixed(2)}
              </div>
              <button className="alt-pick" type="button" title="Switch to this code — not yet wired">
                Pick →
              </button>
            </div>
          ))}
        </>
      )}

      <div className="meta-grid">
        <div className="meta-cell">
          <div className="k">Model</div>
          <div className="v">{meta?.model ?? result.model_used ?? '—'}</div>
        </div>
        <div className="meta-cell">
          <div className="k">Latency</div>
          <div className="v">{meta ? fmtMs(meta.latency_ms) : '—'}</div>
        </div>
        <div className="meta-cell">
          <div className="k">Tokens · input</div>
          <div className="v">{meta ? meta.tokens_in.toLocaleString() : '—'}</div>
        </div>
        <div className="meta-cell">
          <div className="k">Tokens · output</div>
          <div className="v">{meta ? meta.tokens_out.toLocaleString() : '—'}</div>
        </div>
        <div className="meta-cell">
          <div
            className="k"
            title="FAISS candidates. 'cited' is what the justifier referenced in its snippets; 'retrieved' is the full top-K neighbour set."
          >
            Candidates
          </div>
          <div className="v">
            {meta
              ? `${meta.candidates_considered} cited / ${meta.candidates_retrieved} retrieved`
              : `${result.evidence.length} retrieved`}
          </div>
        </div>
      </div>
    </div>
  );
}
