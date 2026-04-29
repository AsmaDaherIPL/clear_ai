/**
 * ClassifyApp.tsx — root React island for the ClearAI v2 application
 *
 * RESPONSIBILITIES:
 *   - Owns the top-level application state: active mode, UI phase,
 *     in-flight request, the most recent DescribeResponse, and the
 *     measured round-trip latency.
 *   - Composes all child components into the page structure.
 *   - Calls api.describe() / api.expand() / api.boost() based on mode
 *     and forwards the result to the matching Result* component.
 *   - Mounted with client:load in index.astro so it hydrates immediately.
 *
 * STATE OWNED:
 *   - mode: ClassifyMode — which tab is active.
 *   - phase: 'idle' | 'classifying' | 'result' | 'error' — UI phase.
 *   - activeStep: number — drives ProcessingSteps progression.
 *   - response: DescribeResponse | null — last successful response.
 *   - latencyMs: number | null — client-measured round-trip.
 *   - errorMessage: string | null — last error to surface to the user.
 *
 * STEP-PROGRESSION HEURISTIC:
 *   The backend returns a single classify response, not per-step events.
 *   We can't know exactly when retrieval finishes vs reasoning starts on
 *   the client. So we drive ProcessingSteps with rough wall-clock timers
 *   that match typical request profiles (≈1s retrieval, ≈3s reasoning,
 *   ≈8s describe). When the real response lands, we jump straight to
 *   step 5 ("done") regardless of where the timer was. This is purely
 *   visual — it gives the user something to watch instead of a static
 *   spinner — and the timers are short enough that even a fast response
 *   never feels chopped.
 */

import { useRef, useState } from 'react';
import TopBar from './TopBar';
import Hero from './Hero';
import ModeTabs, { type ClassifyMode } from './ModeTabs';
import Composer from './Composer';
import ProcessingSteps from './ProcessingSteps';
import ResultSingle from './ResultSingle';
// ResultExpand is unused here for now — Expand-mode responses are funneled
// through ResultSingle by hoisting the `after` leaf into `result`. Keep
// the file in tree for the eventual dedicated before/after layout pass.
import ResultBatch from './ResultBatch';
import Footer from './Footer';
import { useT } from '@/lib/i18n';
import { api, ApiError, type DescribeResponse } from '@/lib/api';

type Phase = 'idle' | 'classifying' | 'result' | 'error';

export default function ClassifyApp() {
  const t = useT();
  const [mode, setMode] = useState<ClassifyMode>('generate');
  const [phase, setPhase] = useState<Phase>('idle');
  const [activeStep, setActiveStep] = useState(0);
  const [response, setResponse] = useState<DescribeResponse | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Hold timer handles so we can clear them if the response lands first
  // (otherwise the timers would race past `activeStep=5` and re-render
  // pending dots beneath the result card).
  const stepTimers = useRef<number[]>([]);

  const clearStepTimers = () => {
    stepTimers.current.forEach((id) => window.clearTimeout(id));
    stepTimers.current = [];
  };

  const startStepProgression = () => {
    // Two-step progression: search/retrieve → reason. The previous
    // four-step sequence was a leftover from when describe also drafted
    // the submission description; that work moved to a lazy follow-up
    // request so it no longer belongs in this panel.
    //
    // Timing is approximate (the backend doesn't emit per-step events).
    // Search+retrieve typically completes around 1s; the reasoning step
    // dominates the total ~3-5s. We move to step 2 quickly so the user
    // sees forward progress, then jump to "done" (step 3) the moment
    // the real response lands. handleSubmit clears the timers either
    // way so we never overshoot.
    clearStepTimers();
    setActiveStep(1);
    stepTimers.current.push(window.setTimeout(() => setActiveStep(2), 1000));
  };

  const handleSubmit = async (description: string, parentCode?: string) => {
    if (!description.trim()) {
      setErrorMessage(t('err_empty'));
      setPhase('error');
      return;
    }
    setErrorMessage(null);
    setResponse(null);
    setLatencyMs(null);
    setPhase('classifying');
    startStepProgression();

    const startedAt = performance.now();
    try {
      // Generate mode → /classify/describe. Expand and Batch are not yet
      // wired in v2 (Composer uses parentCode only when mode==='expand',
      // but the api.expand call is deferred until the Expand result card
      // is wired separately).
      let res: DescribeResponse;
      if (mode === 'generate') {
        res = await api.describe({ description });
      } else if (mode === 'expand') {
        // Soft-fail: surface a friendly error rather than crashing.
        // Wiring expand requires plumbing api.expand → ResultExpand which
        // is on the v2 punch list (today ResultExpand is a stub).
        if (!parentCode) {
          throw new Error('Parent code required for Expand mode.');
        }
        // Treat the expand response as compatible with DescribeResponse
        // for now — both share the decision envelope. ResultExpand will
        // get its own typed prop in a follow-up.
        const expandRes = await api.expand({ code: parentCode, description });
        // Lift the chosen leaf into result.* shape so ResultSingle can
        // render it transparently. before/after split rendering is a
        // ResultExpand-specific concern handled separately.
        res = {
          ...expandRes,
          result: expandRes.after,
        };
      } else {
        throw new Error('Batch mode is not wired yet.');
      }
      const elapsed = performance.now() - startedAt;
      clearStepTimers();
      // Step counter beyond the last step (2) marks every row "done".
      setActiveStep(3);
      setResponse(res);
      setLatencyMs(elapsed);
      setPhase('result');
    } catch (err) {
      clearStepTimers();
      setActiveStep(0);
      const msg =
        err instanceof ApiError
          ? `${err.status === 0 ? '' : `${err.status}: `}${err.message || t('err_generic')}`
          : err instanceof Error
            ? err.message
            : t('err_generic');
      setErrorMessage(msg);
      setPhase('error');
    }
  };

  return (
    <>
      <TopBar />

      {/*
        Spacing matches `new landing page.html`:
        - main: padding 80px 28px 48px
        - Hero subtitle owns its own 40px bottom margin
        - ModeTabs + Composer flow directly under, no extra gap
        - ProcessingSteps + Result cards have a 24px stand-off (mt-6)
      */}
      <main className="max-w-[760px] mx-auto px-7 pt-20 pb-12">
        <Hero />

        <div className="flex flex-col items-center">
          <ModeTabs mode={mode} onModeChange={setMode} />
          <Composer
            mode={mode}
            onSubmit={handleSubmit}
            loading={phase === 'classifying'}
            className="w-full"
          />
        </div>

        <ProcessingSteps
          visible={phase === 'classifying'}
          activeStep={activeStep}
          className="mt-6"
        />

        {/* Inline error panel — minimal styling, sits where the result
            card would so the user sees the failure in the same visual
            slot as a success. */}
        {phase === 'error' && errorMessage && (
          <div
            role="alert"
            className="mt-6 px-4 py-3 rounded-[var(--radius)] border border-[var(--line)] bg-[var(--line-2)] text-[14px] text-[var(--ink-2)]"
          >
            {errorMessage}
          </div>
        )}

        {phase === 'result' && (
          <div className="mt-6">
            <ResultSingle
              visible={mode === 'generate' || mode === 'expand'}
              data={response}
              latencyMs={latencyMs ?? undefined}
            />
            <ResultBatch visible={mode === 'batch'} />
          </div>
        )}
      </main>

      <Footer />
    </>
  );
}
