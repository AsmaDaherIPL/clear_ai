/** Root React island. Owns mode, phase, request state, drives the page layout. */

import { useEffect, useRef, useState } from 'react';
import TopBar from './TopBar';
import Hero from './Hero';
import ModeTabs, { type ClassifyMode } from './ModeTabs';
import Composer, { type ComposerExtras } from './Composer';
import ProcessingSteps from './ProcessingSteps';
import ResultSingle from './ResultSingle';
import ResultBatch from './ResultBatch';
import Footer from './Footer';
import { useAuthState, LoginCard } from './SignInGate';
import { useT } from '@/lib/i18n';
import {
  api,
  ApiError,
  type DescribeResponse,
  type DispatchResponse,
} from '@/lib/api';

/**
 * Adapt the new `/pipeline/dispatch` response shape into the legacy
 * `DescribeResponse` envelope the existing `ResultSingle` renderer expects.
 * Plan B step 3 will replace this with a purpose-built renderer for the
 * cleaner trace shape.
 */
function dispatchToDescribe(d: DispatchResponse): DescribeResponse {
  const accepted = d.final_code !== null && d.sanity_verdict !== 'BLOCK';

  // Pull the submission description from the dispatch trace's
  // submission_description action so the SPA's renderer can short-circuit
  // the legacy /classifications/{id}/submission-description fetch.
  const classify = d.trace.stages.find((s) => s.stage === 'classify');
  const subAction = classify?.actions.find((a) => a.action === 'submission_description');
  const subOutput = (subAction?.output ?? {}) as {
    description_ar?: string | null;
    description_en?: string | null;
  };
  const description_ar =
    typeof subOutput.description_ar === 'string'
      ? subOutput.description_ar
      : d.goods_description_ar;
  const description_en =
    typeof subOutput.description_en === 'string'
      ? subOutput.description_en
      : null;

  return {
    decision_status: accepted ? 'accepted' : 'needs_clarification',
    decision_reason: accepted ? 'strong_match' : 'ambiguous_top_candidates',
    alternatives: [],
    result: accepted
      ? {
          code: d.final_code as string,
          description_en: null,
          description_ar: d.goods_description_ar,
        }
      : undefined,
    submission_description: description_ar
      ? {
          description_ar,
          description_en: description_en ?? '',
          rationale: '',
          differs_from_catalog: true,
          source: 'llm',
        }
      : undefined,
    model: { embedder: 'text-embedding-3-large', llm: null },
  };
}

type Phase = 'idle' | 'classifying' | 'result' | 'error';

/** Per-mode result slice. Switching tabs preserves each mode's last result. */
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
  // Auth state drives the composer/login swap. The page chrome
  // (TopBar, Hero, Footer) renders the same regardless — only the
  // middle slot changes between the login card (unauthenticated)
  // and the composer + result region (authenticated).
  const authState = useAuthState();
  const [mode, setMode] = useState<ClassifyMode>('generate');

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

  const patchMode = (m: ClassifyMode, patch: Partial<ModeState>) => {
    setModeStates((s) => ({ ...s, [m]: { ...s[m], ...patch } }));
  };

  const stepTimers = useRef<Record<ClassifyMode, number[]>>({
    generate: [], expand: [], batch: [],
  });
  const lastSubmission = useRef<Record<
    ClassifyMode,
    { description: string; parentCode?: string; extras?: ComposerExtras } | null
  >>({ generate: null, expand: null, batch: null });
  const stepsRef = useRef<HTMLDivElement | null>(null);
  const resultRef = useRef<HTMLDivElement | null>(null);
  const errorRef = useRef<HTMLDivElement | null>(null);

  const clearStepTimers = (m: ClassifyMode) => {
    stepTimers.current[m].forEach((id) => window.clearTimeout(id));
    stepTimers.current[m] = [];
  };

  /** Wall-clock progression — purely visual, no per-stage server events. */
  const startStepProgression = (m: ClassifyMode) => {
    clearStepTimers(m);
    patchMode(m, { activeStep: 1 });
    stepTimers.current[m].push(window.setTimeout(() => patchMode(m, { activeStep: 2 }), 700));
    stepTimers.current[m].push(window.setTimeout(() => patchMode(m, { activeStep: 3 }), 2200));
  };

  const handleSubmit = async (
    description: string,
    parentCode?: string,
    extras?: ComposerExtras,
  ) => {
    // Capture mode at submit time so a tab switch mid-request lands in the
    // originating slice, not the new active tab.
    const m = mode;

    if (!description.trim()) {
      patchMode(m, { errorMessage: t('err_empty'), phase: 'error' });
      return;
    }
    lastSubmission.current[m] = { description, parentCode, extras };
    patchMode(m, {
      errorMessage: null,
      response: null,
      latencyMs: null,
      phase: 'classifying',
    });
    startStepProgression(m);

    const startedAt = performance.now();
    try {
      let res: DescribeResponse;
      if (m === 'generate') {
        // Generate mode now talks to the new two-track pipeline. The
        // dispatch response is adapted into a legacy DescribeResponse so
        // ResultSingle keeps working until Plan B step 3 lands a renderer
        // for the cleaner trace shape.
        const dispatchRes = await api.dispatch({
          description,
          value_amount: extras?.valueAmount,
          currency_code: extras?.currencyCode,
        });
        res = dispatchToDescribe(dispatchRes);
      } else if (m === 'expand') {
        if (!parentCode) {
          throw new Error('Parent code required for Expand mode.');
        }
        const expandRes = await api.expand({ code: parentCode, description });
        // Hoist chosen leaf into result.* so ResultSingle can render it transparently.
        res = {
          ...expandRes,
          result: expandRes.after,
        };
      } else {
        throw new Error('Batch mode is not wired yet.');
      }
      const elapsed = performance.now() - startedAt;
      clearStepTimers(m);
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

  /** Re-fire the last submission for the current mode. */
  const handleRetry = () => {
    const last = lastSubmission.current[mode];
    if (!last) return;
    handleSubmit(last.description, last.parentCode, last.extras);
  };

  /** Promote an alternative to chosen leaf, synthesizing an accepted envelope. */
  const handleManualPick = (chosenCode: string) => {
    if (!response || !response.alternatives) return;
    const chosen = response.alternatives.find((a) => a.code === chosenCode);
    if (!chosen) return;
    patchMode(mode, {
      response: {
        ...response,
        decision_status: 'accepted',
        decision_reason: 'already_most_specific',
        result: {
          code: chosen.code,
          description_en: chosen.description_en,
          description_ar: chosen.description_ar,
        },
        alternatives: response.alternatives.filter((a) => a.code !== chosenCode),
        rationale: undefined,
      },
    });
  };

  /** Scroll the user to whichever section the new phase made meaningful. */
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
        Result region wants the full 1180px column-width per the
        "Layout language" spec; the hero+composer above stays
        narrower (760px) because long line-lengths hurt the writing
        experience there. We widen the outer <main> to 1180 and
        re-constrain the hero/composer in their own 760-max wrapper.
      */}
      <main className="max-w-[1180px] mx-auto px-7 pt-20 pb-12">
        <div className="max-w-[760px] mx-auto">
          <Hero />

          {/*
            Centre slot. While MSAL is initialising we render an
            invisible spacer matched to the composer's roughly 200px
            footprint so the page doesn't jump when the auth state
            resolves. Unauthenticated → LoginCard. Authenticated →
            ModeTabs + Composer + processing steps + error region.
          */}
          {authState === 'initialising' && (
            <div aria-hidden style={{ minHeight: '200px' }} />
          )}

          {authState === 'unauthenticated' && (
            <div className="mt-2">
              <LoginCard />
            </div>
          )}

          {authState === 'authenticated' && (
            <>
              <div className="flex flex-col items-center">
                <ModeTabs mode={mode} onModeChange={setMode} />
                <Composer
                  mode={mode}
                  onSubmit={handleSubmit}
                  loading={phase === 'classifying'}
                  className="w-full"
                />
              </div>

              {/* Anchor wrappers stay mounted across phase transitions so refs are stable. */}
              <div ref={stepsRef} className="scroll-mt-20">
                <ProcessingSteps
                  visible={phase === 'classifying'}
                  activeStep={activeStep}
                  className="mt-6"
                />
              </div>

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
            </>
          )}
        </div>

        {/* Result lives outside the 760 inner wrapper so it breathes at full 1180px. */}
        <div ref={resultRef} className="scroll-mt-20">
          {authState === 'authenticated' && phase === 'result' && (
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
