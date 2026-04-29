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
 *   We can't know exactly when each phase finishes on the client, so we
 *   drive ProcessingSteps with rough wall-clock timers matching typical
 *   request profiles:
 *     - Step 1 (Understanding your product)            : ~700ms
 *     - Step 2 (Searching the ZATCA tariff codes lib.) : ~1500ms more
 *     - Step 3 (Reasoning + applying classification)   : dwell here
 *       until the real response lands.
 *   When the response arrives, we jump straight to step 4 ("all done"
 *   — one past the last index) regardless of where the timers were.
 *   Timers are cleared on success / error so they never overshoot.
 *   This is purely visual — gives the user something to watch instead
 *   of a static spinner.
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
  // Last (description, parentCode) we submitted. Lets the result card
  // expose a "Retry auto-pick" button on degraded responses without
  // forcing the user to retype. We keep this in a ref instead of state
  // because reading it doesn't need to trigger a re-render — only the
  // explicit retry call does.
  const lastSubmission = useRef<{ description: string; parentCode?: string } | null>(null);

  const clearStepTimers = () => {
    stepTimers.current.forEach((id) => window.clearTimeout(id));
    stepTimers.current = [];
  };

  const startStepProgression = () => {
    // Three-step progression: understand → search → reason.
    // Timings approximate — see the file header for the rationale.
    // Cleanup of any prior run's timers happens up-front so a rapid
    // re-submit never lets two progressions race.
    clearStepTimers();
    setActiveStep(1);
    stepTimers.current.push(window.setTimeout(() => setActiveStep(2), 700));
    stepTimers.current.push(window.setTimeout(() => setActiveStep(3), 2200));
  };

  const handleSubmit = async (description: string, parentCode?: string) => {
    if (!description.trim()) {
      setErrorMessage(t('err_empty'));
      setPhase('error');
      return;
    }
    // Stash for the result card's Retry button. Cleared on successful
    // accepted-path commit (no point retrying then) and refreshed on
    // every fresh submit so retry always re-fires the LATEST query.
    lastSubmission.current = { description, parentCode };
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
      // Step counter beyond the last step (3) marks every row "done".
      setActiveStep(4);
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

  /**
   * Re-fire the most recent submission. Surfaced on the degraded result
   * card as "Retry auto-pick" — when the picker LLM was unavailable on
   * the first attempt but retrieval still produced candidates, the
   * failure is usually transient (config glitch, rate limit) and a
   * second attempt succeeds. No-op if nothing has been submitted yet.
   */
  const handleRetry = () => {
    const last = lastSubmission.current;
    if (!last) return;
    handleSubmit(last.description, last.parentCode);
  };

  /**
   * Promote a manually-picked alternative to the chosen leaf. Called
   * when the user clicks "Use this code" on a candidate row in the
   * degraded variant — the picker LLM couldn't choose, so the human
   * does. We synthesize an `accepted`-shaped envelope locally so the
   * normal ResultSingle accepted layout takes over (with the chosen
   * code rendering as the 12-digit segments + duty + alternatives).
   *
   * The synthesized envelope keeps the original alternatives list
   * minus the now-chosen row, and tags the decision_reason with a
   * sentinel so a future ResultSingle pass could surface "you picked
   * this manually" if desired. For now it just behaves as a normal
   * accepted result.
   */
  const handleManualPick = (chosenCode: string) => {
    if (!response || !response.alternatives) return;
    const chosen = response.alternatives.find((a) => a.code === chosenCode);
    if (!chosen) return;
    setResponse({
      ...response,
      decision_status: 'accepted',
      // already_most_specific is the closest existing reason that
      // doesn't trigger any LLM-rationale rendering. The card reads
      // it through reasonLabel(); the user-facing impact is the pill
      // label changes from "Service degraded" to "Already most
      // specific" — acceptable for now, can be refined when the
      // backend adds a dedicated 'manual_override' reason.
      decision_reason: 'already_most_specific',
      result: {
        code: chosen.code,
        description_en: chosen.description_en,
        description_ar: chosen.description_ar,
      },
      // Drop the chosen row from alternatives so it doesn't appear
      // both as the chosen leaf and as a sibling row.
      alternatives: response.alternatives.filter((a) => a.code !== chosenCode),
      // The auto-pick rationale is intentionally absent — the LLM
      // didn't generate one, and we shouldn't fabricate text on the
      // user's behalf. Same for submission_description (lazy-loaded
      // separately; see SubmissionDescriptionCard).
      rationale: undefined,
    });
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
              onRetry={handleRetry}
              onPickAlternative={handleManualPick}
            />
            <ResultBatch visible={mode === 'batch'} />
          </div>
        )}
      </main>

      <Footer />
    </>
  );
}
