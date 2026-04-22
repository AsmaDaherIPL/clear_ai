/**
 * ClassifyApp — the v5 shell. Owns:
 *   - mode (generate / boost / validate)
 *   - input state (description / hs hint / value)
 *   - pipeline animation state
 *   - api call + result
 *
 * Pipeline animation is cosmetic: it advances through the 6 stages while
 * the single /api/resolve call is in flight. When the API returns it jumps
 * to "done" and renders the result. Real per-stage timings come from the
 * backend's `stages[]` field once wired up (see lib/api.ts BACKEND GAPs).
 */
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type ResolveRequest, type ResolveResponse } from '../lib/api';
import TopBar from './TopBar';
import Hero from './Hero';
import ModeTabs, { type Mode } from './ModeTabs';
import InputCard from './InputCard';
import Suggestions from './Suggestions';
import Pipeline, { STAGES } from './Pipeline';
import HSResultCard from './HSResultCard';
import HSLadderCard from './HSLadderCard';
import ClosestAlternativeCard from './ClosestAlternativeCard';
import ResultTabs from './ResultTabs';
import ProcessPanel from './ProcessPanel';
import SoonCard from './SoonCard';
import Footer from './Footer';

export default function ClassifyApp() {
  const [mode, setMode] = useState<Mode>('generate');

  const [text, setText] = useState('');
  const [hsHint, setHsHint] = useState('');
  const [value, setValue] = useState('');
  const [currency, setCurrency] = useState('USD');

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number>(-1);
  const [pipeShow, setPipeShow] = useState(false);

  const [result, setResult] = useState<ResolveResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Keep refs so the global ⌘↵ handler sees fresh state without re-binding.
  const latest = useRef({ busy, text, hsHint, value, currency, mode });
  latest.current = { busy, text, hsHint, value, currency, mode };

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
        animTimers.current.push(setTimeout(tick, STAGES[i].defaultMs));
      }
    };
    animTimers.current.push(setTimeout(tick, STAGES[0].defaultMs));
  }

  async function classify() {
    const s = latest.current;
    if (s.busy || s.mode !== 'generate') return;
    if (!s.text.trim() && !s.hsHint.trim()) return;

    clearTimers();
    setError(null);
    setResult(null);
    setPipeShow(true);
    setBusy(true);

    runAnimation();

    const req: ResolveRequest = {
      description: s.text.trim() || undefined,
      hs_code: s.hsHint.trim() || undefined,
      value: s.value ? Number(s.value) : undefined,
      currency: s.currency || 'USD',
      destination: 'SA',
    };

    try {
      const res = await api.resolve(req);
      clearTimers();
      setProgress(STAGES.length); // snap to done
      setResult(res);
    } catch (err) {
      clearTimers();
      setPipeShow(false);
      setProgress(-1);
      setError(
        err instanceof ApiError
          ? err.message
          : 'Network error — is the backend running on :8787?'
      );
    } finally {
      setBusy(false);
    }
  }

  // Global ⌘↵ / Ctrl+↵
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        classify();
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

      {mode === 'generate' && (
        <>
          <InputCard
            text={text} setText={setText}
            hsHint={hsHint} setHsHint={setHsHint}
            value={value} setValue={setValue}
            currency={currency} setCurrency={setCurrency}
            busy={busy} onClassify={classify}
          />

          {!pipeShow && !showResult && <Suggestions setText={setText} />}

          <Pipeline
            progress={progress}
            show={pipeShow && !showResult}
          />

          {error && (
            <div className="err-banner" role="alert">{error}</div>
          )}

          {showResult && result && (
            <div className="result show">
              <HSResultCard result={result} />

              {/* Non-expert view: ladder + "why not this competitor?" */}
              <HSLadderCard
                rows={result.hs_code_ladder ?? []}
                resolvedCode={result.hs_code}
              />
              <ClosestAlternativeCard alt={result.closest_alternative} />

              {/* Full WCO/GRI justification — collapsed by default so
                  non-experts aren't walled-of-text-ed. Opens in place. */}
              <details className="full-just">
                <summary>
                  <span className="t">Full customs justification</span>
                  <span className="s">GRI citations, 7-section rationale, sources</span>
                </summary>
                <ResultTabs result={result} merchantDescription={text} />
              </details>

              <ProcessPanel result={result} />
            </div>
          )}
        </>
      )}

      {mode !== 'generate' && <SoonCard mode={mode} />}

      <Footer />
    </div>
  );
}
