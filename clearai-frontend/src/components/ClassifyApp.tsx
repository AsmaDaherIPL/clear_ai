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
import { useEffect, useRef, useState } from 'react';
import {
  api,
  ApiError,
  reasonLabel,
  remediationHint,
  statusToTone,
  type DescribeResponse,
  type ExpandBoostResponse,
  type DecisionEnvelopeBase,
  type ResultLine,
} from '../lib/api';
import TopBar from './TopBar';
import Hero from './Hero';
import ModeTabs, { type Mode } from './ModeTabs';
import InputCard from './InputCard';
import Suggestions from './Suggestions';
import Pipeline, { STAGES } from './Pipeline';
import HSResultCard from './HSResultCard';
import AlternativesCard from './AlternativesCard';
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

export default function ClassifyApp() {
  const [mode, setMode] = useState<Mode>('generate');

  const [text, setText] = useState('');
  const [hsCode, setHsCode] = useState('');

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number>(-1);
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
    setProgress(-1);
    setPipeShow(false);
  }, [mode]);

  // Latest-state ref so the global ⌘↵ handler doesn't restage on every keystroke.
  const latest = useRef({ busy, mode, text, hsCode });
  latest.current = { busy, mode, text, hsCode };

  const animTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  function clearTimers() {
    animTimers.current.forEach(clearTimeout);
    animTimers.current = [];
  }
  useEffect(() => clearTimers, []);

  function runAnimation() {
    let i = 0;
    setProgress(0);
    const tick = () => {
      i += 1;
      setProgress(i);
      if (i < STAGES.length) {
        animTimers.current.push(setTimeout(tick, STAGES[i]!.defaultMs));
      }
    };
    animTimers.current.push(setTimeout(tick, STAGES[0]!.defaultMs));
  }

  async function submit() {
    const s = latest.current;
    if (s.busy) return;
    // Per-mode validation (mirrors backend Zod regexes — fail fast on the client
    // so the user sees feedback immediately rather than chasing a 400).
    if (s.mode === 'generate' && !s.text.trim()) return;
    if (s.mode === 'expand' && (!/^\d{4}$|^\d{6}$|^\d{8}$|^\d{10}$/.test(s.hsCode) || !s.text.trim())) return;
    if (s.mode === 'boost' && !/^\d{12}$/.test(s.hsCode)) return;

    clearTimers();
    setError(null);
    setResult(null);
    setPipeShow(true);
    setBusy(true);
    runAnimation();

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
      clearTimers();
      setProgress(STAGES.length);
      setResult({ body, mode: s.mode, clientLatencyMs });
    } catch (err) {
      clearTimers();
      setPipeShow(false);
      setProgress(-1);
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

      <InputCard
        mode={mode}
        text={text} setText={setText}
        hsCode={hsCode} setHsCode={setHsCode}
        busy={busy} onSubmit={submit}
      />

      {mode === 'generate' && !pipeShow && !showResult && (
        <Suggestions setText={setText} />
      )}

      <Pipeline progress={progress} show={pipeShow && !showResult} />

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
        <HSResultCard
          status={status}
          reason={reason}
          result={line}
          {...(beforeCode ? { beforeCode } : {})}
        />
      )}

      {status !== 'accepted' && (
        <NotAcceptedCard status={status} reason={reason} tone={tone} hint={hint} />
      )}

      <AlternativesCard
        alternatives={body.alternatives}
        {...(line?.code ? { chosenCode: line.code } : {})}
        {...((body as DecisionEnvelopeBase).rationale
          ? { rationale: (body as DecisionEnvelopeBase).rationale as string }
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
  status: 'needs_clarification' | 'degraded';
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
