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

import { useEffect, useRef, useState } from 'react';
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

/**
 * One slice of result state, owned by exactly one ClassifyMode.
 *
 * Why per-mode: switching tabs should NOT clobber a result the user
 * just got. Generate's "men's t-shirt" sticks around even if they
 * pop over to Expand to try a parent-code lookup, then come back.
 * Each mode owns its own (phase, response, latency, error,
 * activeStep) and we project the slice for the active mode into the
 * render below.
 */
interface ModeState {
  phase: Phase;
  activeStep: number;
  response: DescribeResponse | null;
  latencyMs: number | null;
  errorMessage: string | null;
}
const initialModeState: ModeState = {
  phase: 'idle',
  activeStep: 0,
  response: null,
  latencyMs: null,
  errorMessage: null,
};

export default function ClassifyApp() {
  const t = useT();
  const [mode, setMode] = useState<ClassifyMode>('generate');

  /**
   * Per-mode state map. We index by ClassifyMode so each tab keeps
   * its own latest result independent of whichever tab is active
   * right now. Tab switches are pure projection — no clearing.
   */
  const [modeStates, setModeStates] = useState<Record<ClassifyMode, ModeState>>({
    generate: { ...initialModeState },
    expand:   { ...initialModeState },
    batch:    { ...initialModeState },
  });
  const cur = modeStates[mode];
  const phase = cur.phase;
  const activeStep = cur.activeStep;
  const response = cur.response;
  const latencyMs = cur.latencyMs;
  const errorMessage = cur.errorMessage;

  /** Helper: patch the slice for a given mode, leaving the others untouched. */
  const patchMode = (m: ClassifyMode, patch: Partial<ModeState>) => {
    setModeStates((s) => ({ ...s, [m]: { ...s[m], ...patch } }));
  };

  // Step timers + lastSubmission are also per-mode. Holding them in
  // a ref keyed on mode means a Generate request mid-flight can't
  // race against an Expand submission's timers, and Retry never
  // re-fires the wrong mode's last query.
  const stepTimers = useRef<Record<ClassifyMode, number[]>>({
    generate: [], expand: [], batch: [],
  });
  const lastSubmission = useRef<Record<
    ClassifyMode,
    { description: string; parentCode?: string } | null
  >>({ generate: null, expand: null, batch: null });
  // Scroll anchors. Phase transitions auto-scroll the user from the
  // composer down to whichever section is now meaningful — steps panel
  // while classifying, result card once it lands, error panel on
  // failure. Keeping the anchors at the parent level (rather than
  // inside ProcessingSteps / ResultSingle) means the scroll target is
  // stable across the conditional renders below.
  const stepsRef = useRef<HTMLDivElement | null>(null);
  const resultRef = useRef<HTMLDivElement | null>(null);
  const errorRef = useRef<HTMLDivElement | null>(null);

  const clearStepTimers = (m: ClassifyMode) => {
    stepTimers.current[m].forEach((id) => window.clearTimeout(id));
    stepTimers.current[m] = [];
  };

  const startStepProgression = (m: ClassifyMode) => {
    // Three-step progression: understand → search → reason.
    // Timings approximate — see the file header for the rationale.
    // Cleanup of any prior run's timers happens up-front so a rapid
    // re-submit never lets two progressions race.
    clearStepTimers(m);
    patchMode(m, { activeStep: 1 });
    stepTimers.current[m].push(window.setTimeout(() => patchMode(m, { activeStep: 2 }), 700));
    stepTimers.current[m].push(window.setTimeout(() => patchMode(m, { activeStep: 3 }), 2200));
  };

  const handleSubmit = async (description: string, parentCode?: string) => {
    // Capture the active mode at submit time. The user can switch tabs
    // mid-request — all of this request's state writes must land in the
    // ORIGINATING mode's slice, not whichever tab is active when the
    // promise resolves. (Without this capture, switching from Generate
    // to Expand mid-fetch would let the resolved Generate response
    // overwrite Expand's idle state.)
    const m = mode;

    if (!description.trim()) {
      patchMode(m, { errorMessage: t('err_empty'), phase: 'error' });
      return;
    }
    // Stash for the result card's Retry button. Per-mode so Retry on
    // mode A never accidentally re-fires mode B's last query.
    lastSubmission.current[m] = { description, parentCode };
    patchMode(m, {
      errorMessage: null,
      response: null,
      latencyMs: null,
      phase: 'classifying',
    });
    startStepProgression(m);

    const startedAt = performance.now();
    try {
      // Generate mode → /classify/describe. Expand and Batch are not yet
      // wired in v2 (Composer uses parentCode only when mode==='expand',
      // but the api.expand call is deferred until the Expand result card
      // is wired separately).
      let res: DescribeResponse;
      if (m === 'generate') {
        res = await api.describe({ description });
      } else if (m === 'expand') {
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
      clearStepTimers(m);
      // Step counter beyond the last step (3) marks every row "done".
      patchMode(m, {
        activeStep: 4,
        response: res,
        latencyMs: elapsed,
        phase: 'result',
      });
    } catch (err) {
      clearStepTimers(m);
      const msg =
        err instanceof ApiError
          ? `${err.status === 0 ? '' : `${err.status}: `}${err.message || t('err_generic')}`
          : err instanceof Error
            ? err.message
            : t('err_generic');
      patchMode(m, { activeStep: 0, errorMessage: msg, phase: 'error' });
    }
  };

  /**
   * Re-fire the most recent submission for the CURRENT mode. Per-mode
   * lookup means clicking Retry on Expand re-runs Expand's last query,
   * not Generate's.
   */
  const handleRetry = () => {
    const last = lastSubmission.current[mode];
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
    // Manual-pick lands in the SAME mode as the originating response.
    // We use the captured `mode` here because manual-pick is a
    // synchronous reaction to a click on the result card — no race
    // window — so reading the live `mode` is fine.
    patchMode(mode, {
      response: {
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
        // user's behalf.
        rationale: undefined,
      },
    });
  };

  /**
   * Smooth-scroll the user to the section that just became meaningful
   * after a phase transition. Skips on the initial mount (`idle`) so the
   * page doesn't jump on first paint.
   *
   * Picks the target by phase:
   *   classifying → ProcessingSteps panel
   *   result      → ResultSingle / ResultBatch wrapper
   *   error       → the inline error panel
   *
   * Why one rAF before scrolling:
   *   The ref's `current` is populated synchronously when React commits
   *   the new DOM, but the browser hasn't yet laid it out. Calling
   *   scrollIntoView in the same tick can scroll to the OLD position of
   *   the target (the steps panel renders below where it was a tick ago
   *   because previous-phase content unmounted above it). A single
   *   requestAnimationFrame defers the scroll until the next paint,
   *   when the layout has settled.
   *
   * Why `behavior: prefers-reduced-motion ? 'auto' : 'smooth'`:
   *   Users with vestibular sensitivity opt out of CSS-driven motion via
   *   the system setting. We honour that here too — `auto` is an
   *   instant jump, `smooth` is the animated ease.
   *
   * `block: 'start'` aligns the target to the top of the viewport with
   *   ~24px of breathing room (provided by the section's own top
   *   padding). The composer stays visible above the fold on most
   *   desktop heights; on smaller viewports the composer scrolls off,
   *   which is fine — the user just submitted, they want to see the
   *   result, not re-edit the input.
   */
  useEffect(() => {
    if (phase === 'idle') return;
    if (typeof window === 'undefined') return;

    const target =
      phase === 'classifying' ? stepsRef.current
      : phase === 'result'    ? resultRef.current
      : phase === 'error'     ? errorRef.current
      : null;
    if (!target) return;

    const reduce =
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    const raf = window.requestAnimationFrame(() => {
      target.scrollIntoView({
        behavior: reduce ? 'auto' : 'smooth',
        block: 'start',
      });
    });
    return () => window.cancelAnimationFrame(raf);
  }, [phase]);

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

        {/* Anchor wrappers stay mounted across phase transitions so the
            scroll-effect's refs are always pointable at a real node.
            Only the inner content is conditional — the wrapper div is
            empty when not in the relevant phase, contributes 0 height,
            and scrollIntoView still works because the wrapper has a
            position in the document flow. */}

        <div ref={stepsRef} className="scroll-mt-20">
          <ProcessingSteps
            visible={phase === 'classifying'}
            activeStep={activeStep}
            className="mt-6"
          />
        </div>

        {/* Inline error panel — minimal styling, sits where the result
            card would so the user sees the failure in the same visual
            slot as a success. */}
        <div ref={errorRef} className="scroll-mt-20">
          {phase === 'error' && errorMessage && (
            <div
              role="alert"
              className="mt-6 px-4 py-3 rounded-[var(--radius)] border border-[var(--line)] bg-[var(--line-2)] text-[14px] text-[var(--ink-2)]"
            >
              {errorMessage}
            </div>
          )}
        </div>

        <div ref={resultRef} className="scroll-mt-20">
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
        </div>
      </main>

      <Footer />
    </>
  );
}
