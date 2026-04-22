/**
 * FullJustificationAccordion — lazy-loaded "Full customs justification".
 *
 * The default /api/resolve response SKIPS the ~14s Sonnet justifier so the
 * classify button feels snappy. This accordion fetches the full justification
 * on first expand via /api/justify, then merges the response into the result
 * card so the user sees the 7-section rationale + GRI citations inline.
 *
 * States:
 *   collapsed       → summary chip + "Click to load" hint
 *   expanded idle   → loading spinner + "Asking Sonnet…"
 *   expanded done   → full ResultTabs rendered
 *   expanded error  → inline banner with retry
 *
 * Caches the fetched justification per hs_code so subsequent expand/collapse
 * cycles don't re-fire the Sonnet call.
 */
import { useState } from 'react';
import { api, ApiError, type JustifyResponse, type ResolveResponse } from '../lib/api';
import ResultTabs from './ResultTabs';

interface Props {
  result: ResolveResponse;
  merchantDescription: string;
}

export default function FullJustificationAccordion({ result, merchantDescription }: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetched, setFetched] = useState<JustifyResponse | null>(null);

  // If the backend already included the justification (caller opted in),
  // render it directly — no lazy fetch needed.
  const alreadyHasJust = !!result.justification;

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (!next) return;
    if (alreadyHasJust || fetched) return;       // already have it
    if (loading) return;

    setLoading(true);
    setError(null);
    try {
      const body = await api.justify({
        hs_code: result.hs_code,
        description: merchantDescription,
      });
      setFetched(body);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Could not fetch justification — backend may be down.'
      );
    } finally {
      setLoading(false);
    }
  }

  // Merge: if we lazy-fetched, splice the returned fields into the result
  // object so ResultTabs can render without caring where they came from.
  const mergedResult: ResolveResponse =
    fetched && !alreadyHasJust
      ? {
          ...result,
          justification: fetched.justification,
          rationale_steps: fetched.rationale_steps,
          // Only swap evidence if the lazy call produced richer snippets
          // (it will — the default /resolve omits the justifier snippets).
          evidence: fetched.evidence.length ? fetched.evidence : result.evidence,
        }
      : result;

  return (
    <section className={`full-just ${open ? 'is-open' : ''}`}>
      <button
        type="button"
        className="full-just-summary"
        aria-expanded={open}
        onClick={toggle}
      >
        <span className="t">Full customs justification</span>
        <span className="s">
          {alreadyHasJust
            ? 'GRI citations, 7-section rationale, sources'
            : 'GRI citations, 7-section rationale — click to load (~14 s)'}
        </span>
        <span className="chev" aria-hidden>{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="full-just-body">
          {loading && (
            <div className="full-just-loading" role="status">
              <span className="spinner" aria-hidden />
              <span>Asking Sonnet for the 7-section rationale…</span>
            </div>
          )}
          {error && (
            <div className="err-banner" role="alert">
              {error}
              <button
                type="button"
                className="retry"
                onClick={() => { setFetched(null); toggle(); toggle(); }}
              >
                Retry
              </button>
            </div>
          )}
          {!loading && !error && (alreadyHasJust || fetched) && (
            <ResultTabs
              result={mergedResult}
              merchantDescription={merchantDescription}
            />
          )}
        </div>
      )}
    </section>
  );
}
