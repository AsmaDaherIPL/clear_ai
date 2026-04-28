/**
 * TracePage — full debug view for a single classification.
 *
 * Renders the classification_events row + any feedback rows associated
 * with it. Sections:
 *   1. Header — request id, endpoint, decision summary, latency
 *   2. Request — what came in, what cleanup understood it as, what was
 *      stripped
 *   3. Retrieval — top score, gap, candidate count, branch size
 *   4. Picker — chosen code, llm_used, llm_status, guard_tripped
 *   5. Model timeline — each model call with latency + status
 *   6. Feedback — existing rows + a form to add new feedback
 *
 * Per ADR-0017 the auth model is share-link-with-UUID — anyone with the
 * URL can view the trace and submit feedback. UUIDs are unguessable; the
 * trace is "your own request" by definition (the user's classification
 * just produced the id).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, type TraceResponse, type FeedbackKind } from '../lib/api';

type Props = {
  eventId: string;
};

function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`;
}

function fmtDate(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString();
}

interface ModelCall {
  model: string;
  latency_ms: number;
  status: string;
}

function isModelCallArray(v: unknown): v is ModelCall[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'object' && x !== null && 'model' in x);
}

/**
 * Resolve the real event ID at hydration time. On Azure Static Web Apps
 * the page is built once for a placeholder ID (`__placeholder__`) and
 * SWA rewrites every `/trace/<uuid>` to the same HTML — so the prop is
 * always the placeholder. We read the actual UUID from the URL pathname.
 *
 * In dev (Astro dev server) the prop is the real ID from `Astro.params`
 * and the URL also matches, so this function returns the same value
 * either way. The placeholder check is for the static-built deployment.
 */
function resolveEventId(propId: string): string {
  if (typeof window === 'undefined') return propId; // SSR build phase
  const path = window.location.pathname;
  const match = path.match(/\/trace\/([^/?#]+)/);
  const fromUrl = match?.[1];
  if (fromUrl && fromUrl !== '__placeholder__') return fromUrl;
  // Fallback: prop is the source of truth (dev mode).
  return propId === '__placeholder__' ? '' : propId;
}

export default function TracePage({ eventId: propEventId }: Props) {
  const eventId = resolveEventId(propEventId);
  const [data, setData] = useState<TraceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Feedback form state
  const [fbKind, setFbKind] = useState<FeedbackKind>('confirm');
  const [correctedCode, setCorrectedCode] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [fbError, setFbError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const t = await api.trace(eventId);
      setData(t);
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.status === 404 ? 'No trace found for that id.' : e.message);
      } else {
        setError('Network error — is the backend running on :3000?');
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!eventId) {
      setError('Missing trace id.');
      setLoading(false);
      return;
    }
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  async function submitFeedback() {
    if (submitting) return;
    setFbError(null);
    if (fbKind === 'prefer_alternative' && !/^\d{12}$/.test(correctedCode)) {
      setFbError('"Use this instead" requires a 12-digit corrected code.');
      return;
    }
    setSubmitting(true);
    try {
      const body: { kind: FeedbackKind; corrected_code?: string; reason?: string } = {
        kind: fbKind,
      };
      if (fbKind === 'prefer_alternative') body.corrected_code = correctedCode;
      if (reason.trim()) body.reason = reason.trim();
      await api.feedback(eventId, body);
      setReason('');
      setCorrectedCode('');
      await refresh();
    } catch (e) {
      setFbError(e instanceof ApiError ? e.message : 'Failed to submit feedback.');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="trace-shell">
        <div className="trace-loading">Loading trace…</div>
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="trace-shell">
        <h1>Trace</h1>
        <div className="trace-error" role="alert">
          {error ?? 'No data.'}
        </div>
        <a className="trace-back" href="/">← Back to classifier</a>
      </div>
    );
  }

  const e = data.event;
  const modelCalls: ModelCall[] = isModelCallArray(e.model_calls) ? e.model_calls : [];

  return (
    <div className="trace-shell">
      <a className="trace-back" href="/">← Back to classifier</a>

      <header className="trace-header">
        <div className="trace-eyebrow">CLASSIFICATION TRACE</div>
        <h1>
          {e.endpoint} · <span className="trace-status">{e.decision_status}</span>
        </h1>
        <div className="trace-sub">
          <span title="Event id">{e.id}</span>
          <span>·</span>
          <span>{fmtDate(e.created_at)}</span>
          <span>·</span>
          <span>{fmtMs(e.total_latency_ms)} total</span>
        </div>
      </header>

      <Section title="Decision">
        <Kv k="status" v={e.decision_status} />
        <Kv k="reason" v={e.decision_reason} />
        <Kv k="confidence" v={e.confidence_band ?? '—'} />
        <Kv k="chosen code" v={e.chosen_code ?? '—'} mono />
        <Kv k="llm used" v={e.llm_used ? 'yes' : 'no'} />
        {e.llm_status && <Kv k="llm status" v={e.llm_status} />}
        {e.guard_tripped && <Kv k="guard tripped" v="YES" warn />}
        {e.error && <Kv k="error" v={e.error} warn />}
      </Section>

      <Section title="Request">
        <pre className="trace-pre">
          {JSON.stringify(e.request, null, 2)}
        </pre>
      </Section>

      <Section title="Retrieval">
        <Kv k="top score" v={e.top_retrieval_score?.toFixed(4) ?? '—'} mono />
        <Kv k="top-2 gap" v={e.top2_gap?.toFixed(4) ?? '—'} mono />
        <Kv k="candidate count" v={e.candidate_count?.toString() ?? '—'} mono />
        <Kv k="branch size" v={e.branch_size?.toString() ?? '—'} mono />
        <Kv k="embedder" v={e.embedder_version ?? '—'} mono />
        <Kv k="language" v={e.language_detected ?? '—'} />
      </Section>

      <Section title="Model calls">
        {modelCalls.length === 0 ? (
          <div className="trace-muted">No model calls recorded for this request.</div>
        ) : (
          <div className="trace-timeline">
            {modelCalls.map((c, i) => (
              <div key={i} className={`trace-call trace-call-${c.status}`}>
                <span className="trace-call-idx">{i + 1}</span>
                <span className="trace-call-model">{c.model}</span>
                <span className="trace-call-latency">{fmtMs(c.latency_ms)}</span>
                <span className="trace-call-status">{c.status}</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Alternatives">
        <pre className="trace-pre">
          {JSON.stringify(e.alternatives, null, 2)}
        </pre>
      </Section>

      <Section title="Feedback">
        {data.feedback.length === 0 ? (
          <div className="trace-muted">No feedback yet.</div>
        ) : (
          <div className="trace-fb-list">
            {data.feedback.map((f) => (
              <div key={f.id} className={`trace-fb trace-fb-${f.kind}`}>
                <div className="trace-fb-head">
                  <span className="trace-fb-kind">{f.kind}</span>
                  <span className="trace-fb-when">{fmtDate(f.created_at)}</span>
                </div>
                {f.rejected_code && (
                  <div className="trace-fb-row">
                    <span className="k">Rejected:</span> <code>{f.rejected_code}</code>
                  </div>
                )}
                {f.corrected_code && (
                  <div className="trace-fb-row">
                    <span className="k">Corrected to:</span> <code>{f.corrected_code}</code>
                  </div>
                )}
                {f.reason && <div className="trace-fb-reason">{f.reason}</div>}
              </div>
            ))}
          </div>
        )}

        <div className="trace-fb-form">
          <div className="trace-fb-form-row">
            <label className="trace-fb-radio">
              <input type="radio" name="kind" value="confirm" checked={fbKind === 'confirm'} onChange={() => setFbKind('confirm')} />
              <span>Correct</span>
            </label>
            <label className="trace-fb-radio">
              <input type="radio" name="kind" value="reject" checked={fbKind === 'reject'} onChange={() => setFbKind('reject')} />
              <span>Wrong</span>
            </label>
            <label className="trace-fb-radio">
              <input type="radio" name="kind" value="prefer_alternative" checked={fbKind === 'prefer_alternative'} onChange={() => setFbKind('prefer_alternative')} />
              <span>Use a different code</span>
            </label>
          </div>

          {fbKind === 'prefer_alternative' && (
            <input
              className="trace-fb-input"
              type="text"
              placeholder="Correct 12-digit code (e.g. 851762900009)"
              value={correctedCode}
              onChange={(ev) => setCorrectedCode(ev.target.value.replace(/\D/g, '').slice(0, 12))}
              maxLength={12}
            />
          )}

          <textarea
            className="trace-fb-textarea"
            placeholder="Optional reason (max 500 chars)…"
            value={reason}
            onChange={(ev) => setReason(ev.target.value.slice(0, 500))}
            rows={3}
          />

          {fbError && <div className="trace-error" role="alert">{fbError}</div>}

          <button
            className="trace-fb-submit"
            type="button"
            onClick={submitFeedback}
            disabled={submitting}
          >
            {submitting ? 'Submitting…' : 'Submit feedback'}
          </button>
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="trace-section">
      <h2>{title}</h2>
      <div className="trace-section-body">{children}</div>
    </section>
  );
}

function Kv({ k, v, mono, warn }: { k: string; v: string; mono?: boolean; warn?: boolean }) {
  return (
    <div className={`trace-kv${warn ? ' trace-kv-warn' : ''}`}>
      <span className="k">{k}</span>
      <span className={`v${mono ? ' mono' : ''}`}>{v}</span>
    </div>
  );
}
