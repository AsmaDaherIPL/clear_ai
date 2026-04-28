/**
 * ClassifyApp — the full UI shell. Owns mode, inputs, pipeline animation,
 * and the call to one of three backend endpoints:
 *
 *   generate → POST /classify/describe   (description → 12-digit code)
 *   expand   → POST /classify/expand     (parent prefix + description)
 *   boost    → POST /boost               (12-digit code → better sibling?)
 *
 * The decision envelope is a closed enum — we render a different result
 * shape for `accepted` vs `needs_clarification` vs `degraded`. No fake
 * confidence numbers; we use decision_reason as the truthful label.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  api,
  ApiError,
  reasonLabel,
  remediationHint,
  statusToTone,
  type DescribeResponse,
  type ExpandBoostResponse,
  type DecisionEnvelopeBase,
  type DecisionStatus,
  type ResultLine,
} from '../lib/api';
import TopBar from './TopBar';
import Hero from './Hero';
import ModeTabs, { type Mode } from './ModeTabs';
import InputCard from './InputCard';
import Suggestions from './Suggestions';
import Pipeline, { type StageKey } from './Pipeline';
import HSResultCard from './HSResultCard';
import BestEffortCard from './BestEffortCard';
import AlternativesCard from './AlternativesCard';
import SubmissionDescriptionCard from './SubmissionDescriptionCard';
import MetaPanel from './MetaPanel';
import Footer from './Footer';

type AnyResponse = DescribeResponse | ExpandBoostResponse;

/** Pulled from the response by mode. /describe puts the chosen line in
 *  `result`; /expand and /boost put it in `after`. */
function pickResultLine(mode: Mode, r: AnyResponse): ResultLine | undefined {
  if (mode === 'generate') return (r as DescribeResponse).result;
  return (r as ExpandBoostResponse).after;
}

function pickBeforeCode(mode: Mode, r: AnyResponse): string | undefined {
  if (mode === 'generate') return undefined;
  return (r as ExpandBoostResponse).before?.code;
}

type ClassifyAppProps = {
  /** Optional slot rendered between the ModeTabs and the InputCard.
   *  Used by ClassifyWorkbench to inject the single/batch run toggle. */
  runToggle?: ReactNode;
};

export default function ClassifyApp({ runToggle }: ClassifyAppProps = {}) {
  const [mode, setMode] = useState<Mode>('generate');

  const [text, setText] = useState('');
  const [hsCode, setHsCode] = useState('');

  const [busy, setBusy] = useState(false);
  // `phase` reflects what the request is plausibly doing right now. We can't
  // know precisely without SSE from the backend, so we flip from 'search' to
  // 'reason' on a single timer tuned to the typical retrieval cost (~250ms
  // warm). It's not perfect, but it's two honest labels instead of six lying
  // ones with fabricated millisecond budgets.
  const [phase, setPhase] = useState<StageKey | null>(null);
  const [pipeShow, setPipeShow] = useState(false);

  const [result, setResult] = useState<{
    body: AnyResponse;
    mode: Mode;
    clientLatencyMs: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reset transient state when switching modes.
  useEffect(() => {
    setResult(null);
    setError(null);
    setPhase(null);
    setPipeShow(false);
  }, [mode]);

  // Latest-state ref so the global ⌘↵ handler doesn't restage on every keystroke.
  const latest = useRef({ busy, mode, text, hsCode });
  latest.current = { busy, mode, text, hsCode };

  // One pending timer that flips us from 'search' → 'reason' partway through
  // the request. ~700ms approximates a warm describe() retrieval (embedder +
  // pgvector hybrid query); past that, the request is most likely waiting on
  // the LLM. If the response arrives sooner, we just clear the timer.
  const phaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function clearPhaseTimer() {
    if (phaseTimer.current !== null) {
      clearTimeout(phaseTimer.current);
      phaseTimer.current = null;
    }
  }
  useEffect(() => clearPhaseTimer, []);

  async function submit() {
    const s = latest.current;
    if (s.busy) return;
    // Per-mode validation (mirrors backend Zod regexes — fail fast on the client
    // so the user sees feedback immediately rather than chasing a 400).
    if (s.mode === 'generate' && !s.text.trim()) return;
    if (s.mode === 'expand' && (!/^\d{6,10}$/.test(s.hsCode) || !s.text.trim())) return;
    if (s.mode === 'boost' && !/^\d{12}$/.test(s.hsCode)) return;

    clearPhaseTimer();
    setError(null);
    setResult(null);
    setPipeShow(true);
    setBusy(true);
    setPhase('search');
    phaseTimer.current = setTimeout(() => setPhase('reason'), 700);

    const t0 = performance.now();
    try {
      let body: AnyResponse;
      if (s.mode === 'generate') {
        body = await api.describe({ description: s.text.trim() });
      } else if (s.mode === 'expand') {
        body = await api.expand({ code: s.hsCode, description: s.text.trim() });
      } else {
        body = await api.boost({ code: s.hsCode });
      }
      const clientLatencyMs = Math.round(performance.now() - t0);
      clearPhaseTimer();
      setPhase(null);
      setResult({ body, mode: s.mode, clientLatencyMs });
    } catch (err) {
      clearPhaseTimer();
      setPipeShow(false);
      setPhase(null);
      if (err instanceof ApiError) {
        // 400 from Zod usually carries a fieldErrors object — best-effort flatten.
        const detail = (err.body as { detail?: { fieldErrors?: Record<string, string[]> } } | null)
          ?.detail?.fieldErrors;
        if (detail) {
          const flat = Object.entries(detail)
            .map(([k, v]) => `${k}: ${(v as string[]).join(', ')}`)
            .join(' · ');
          setError(`Invalid input — ${flat}`);
        } else {
          setError(err.message);
        }
      } else {
        setError('Network error — is the backend running on :3000?');
      }
    } finally {
      setBusy(false);
    }
  }

  // Global ⌘↵ / Ctrl+↵
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const showResult = !!result && !error;

  return (
    <div className="shell">
      <TopBar />
      <Hero />
      <ModeTabs mode={mode} setMode={setMode} />

      {runToggle}

      <InputCard
        mode={mode}
        text={text} setText={setText}
        hsCode={hsCode} setHsCode={setHsCode}
        busy={busy} onSubmit={submit}
      />

      {mode === 'generate' && !pipeShow && !showResult && (
        <Suggestions setText={setText} />
      )}

      <Pipeline
        phase={phase}
        totalMs={result?.clientLatencyMs ?? null}
        show={pipeShow && !showResult}
      />

      {error && (
        <div className="err-banner" role="alert">{error}</div>
      )}

      {showResult && result && (
        <ResultBlock
          mode={result.mode}
          body={result.body}
          clientLatencyMs={result.clientLatencyMs}
        />
      )}

      <Footer />
    </div>
  );
}

// ---------- Result block ----------------------------------------------------

function ResultBlock({
  mode, body, clientLatencyMs,
}: {
  mode: Mode;
  body: AnyResponse;
  clientLatencyMs: number;
}) {
  const status = body.decision_status;
  const reason = body.decision_reason;
  const tone = statusToTone(status);
  const line = pickResultLine(mode, body);
  const beforeCode = pickBeforeCode(mode, body);
  const hint = remediationHint(status, reason);

  return (
    <div className="result show">
      {status === 'accepted' && line && (
        <>
          <HSResultCard
            status={status}
            reason={reason}
            result={line}
            {...(beforeCode ? { beforeCode } : {})}
            {...((body as DecisionEnvelopeBase).rationale
              ? { rationale: (body as DecisionEnvelopeBase).rationale as string }
              : {})}
          />
          {/* Phase 5 — ZATCA-safe submission description sits right under
              the chosen-code card. Only renders when the backend emitted
              one (feature-flagged via SUBMISSION_DESC_ENABLED). */}
          {(body as DecisionEnvelopeBase).submission_description && (
            <SubmissionDescriptionCard
              submission={(body as DecisionEnvelopeBase).submission_description!}
            />
          )}
        </>
      )}

      {status === 'best_effort' && line && (
        <BestEffortCard
          result={line}
          rationale={(body as DecisionEnvelopeBase).rationale}
          hint={hint}
        />
      )}

      {status !== 'accepted' && status !== 'best_effort' && (
        <NotAcceptedCard status={status} reason={reason} tone={tone} hint={hint} />
      )}

      <AlternativesCard
        alternatives={body.alternatives}
        {...(line?.code ? { chosenCode: line.code } : {})}
        {...(line?.description_en !== undefined
          ? { chosenDescriptionEn: line.description_en }
          : {})}
        {...(line?.description_ar !== undefined
          ? { chosenDescriptionAr: line.description_ar }
          : {})}
        {...(status !== 'accepted' && hint ? { remediationHint: hint } : {})}
      />

      <MetaPanel model={body.model} clientLatencyMs={clientLatencyMs} />
    </div>
  );
}

function NotAcceptedCard({
  status, reason, tone, hint,
}: {
  status: Exclude<DecisionStatus, 'accepted' | 'best_effort'>;
  reason: ReturnType<typeof reasonLabel> extends string ? Parameters<typeof reasonLabel>[0] : never;
  tone: 'warn' | 'bad' | 'good';
  hint: string | null;
}) {
  return (
    <div className={`hs-card hs-card-${tone}`}>
      <div className="hs-top">
        <div className="k">{status === 'degraded' ? 'SERVICE DEGRADED' : 'NEEDS CLARIFICATION'}</div>
        <div className={`conf-pill conf-${tone}`}>
          <span className="d" />
          <span>{reasonLabel(reason)}</span>
        </div>
      </div>
      {hint && <p className="not-accepted-hint">{hint}</p>}
    </div>
  );
}
