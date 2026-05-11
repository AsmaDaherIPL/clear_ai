/** Root React island. Owns mode, phase, request state, drives the page layout. */

import { useEffect, useRef, useState, useCallback } from 'react';
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
  type DeclarationRunSummary,
  type DeclarationRunItem,
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

/**
 * Batch-mode state. Kept separate from ModeState because a batch run
 * has structurally different progress (run summary + per-item rows)
 * than a single-shot dispatch (one DescribeResponse).
 */
export interface BatchState {
  phase: 'idle' | 'uploading' | 'polling' | 'done' | 'error';
  runId: string | null;
  summary: DeclarationRunSummary | null;
  items: DeclarationRunItem[];
  errorMessage: string | null;
}
const initialBatchState: BatchState = {
  phase: 'idle',
  runId: null,
  summary: null,
  items: [],
  errorMessage: null,
};

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 min cap; backend can run longer but the UI won't watch indefinitely

function getUrlRunId(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('run');
}

function syncRunIdToUrl(runId: string | null): void {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  if (runId) {
    params.set('run', runId);
  } else {
    params.delete('run');
  }
  const qs = params.toString();
  const next = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
  window.history.replaceState(null, '', next);
}

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
  const [batchState, setBatchState] = useState<BatchState>(initialBatchState);
  const pollTimerRef = useRef<number | null>(null);
  const cur = modeStates[mode];
  const phase = cur.phase;
  const activeStep = cur.activeStep;
  const response = cur.response;
  const latencyMs = cur.latencyMs;
  const errorMessage = cur.errorMessage;

  const patchMode = (m: ClassifyMode, patch: Partial<ModeState>) => {
    setModeStates((s) => ({ ...s, [m]: { ...s[m], ...patch } }));
  };

  const stopPolling = () => {
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  // Keep ?run=<id> in the URL in sync with batchState.runId so the user
  // can bookmark or share a batch run and return to it later.
  useEffect(() => {
    syncRunIdToUrl(batchState.runId);
  }, [batchState.runId]);

  /**
   * Reset batch mode to its initial state. Called from the
   * "Start a new batch" button in the result panel footer; also
   * stops any in-flight poll. Causes the composer collapser to
   * un-collapse and the result panel to unmount.
   */
  const handleResetBatch = () => {
    stopPolling();
    syncRunIdToUrl(null);
    setBatchState({ ...initialBatchState });
  };

  /**
   * Core poll loop for a known runId. Fires immediately (no initial delay
   * when resuming a run from a URL param) and keeps polling until the run
   * reaches a terminal state. Extracted so both handleBatchUpload and the
   * URL-resume effect can share it without duplicating the logic.
   */
  const startPollingRun = useCallback((runId: string) => {
    const startedAt = Date.now();
    let classificationsFetched = false;

    const poll = async (): Promise<void> => {
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        setBatchState((s) => ({
          ...s,
          phase: 'error',
          errorMessage: 'Run still in progress after 5 minutes — check the run page later.',
        }));
        return;
      }
      try {
        const summary = await api.getDeclarationRun(runId);
        setBatchState((s) => ({ ...s, summary }));

        // v3.1 + PR G: items now stream in as they complete. Re-fetch
        // every tick during Phase 1 so the table live-fills row-by-
        // row (instead of one big swap at the end). The endpoint
        // returns a `classification_phase` flag at the top level
        // which is the authoritative Phase 1 lifecycle signal —
        // independent of the run-level status (which can flip to
        // 'failed' because Phase 2 failed even when Phase 1 was fine).
        let classificationPhase: 'pending' | 'running' | 'completed' | 'failed' | undefined;
        try {
          const cls = await api.getDeclarationRunClassifications(runId);
          classificationPhase = cls.classification_phase;
          setBatchState((s) => ({ ...s, items: cls.items }));
        } catch {
          // Non-fatal: keep polling. Next tick may succeed.
        }

        // Stop polling when EITHER signal goes terminal — whichever
        // flips first wins. summary.status covers run-level success
        // and Phase-2 failure; classification_phase covers Phase-1
        // completion. Belt-and-braces.
        const summaryTerminal =
          summary.status === 'completed' ||
          summary.status === 'failed' ||
          summary.status === 'cancelled';
        const classificationTerminal =
          classificationPhase === 'completed' || classificationPhase === 'failed';
        if (summaryTerminal || classificationTerminal) {
          // One final fetch to make sure the table reflects every
          // last completion before we stop polling.
          if (!classificationsFetched) {
            classificationsFetched = true;
            try {
              const finalCls = await api.getDeclarationRunClassifications(runId);
              setBatchState((s) => ({ ...s, items: finalCls.items }));
            } catch {
              /* swallow — best-effort final read */
            }
          }
          setBatchState((s) => ({ ...s, phase: 'done' }));
          return;
        }
        pollTimerRef.current = window.setTimeout(poll, POLL_INTERVAL_MS);
      } catch (err) {
        const msg =
          err instanceof ApiError
            ? `${err.status}: ${err.message}`
            : err instanceof Error
              ? err.message
              : 'Polling failed.';
        setBatchState((s) => ({ ...s, phase: 'error', errorMessage: msg }));
      }
    };

    // Fire the first tick immediately so a URL-resumed run shows data
    // without a 2-second blank gap.
    void poll();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Batch-mode entry point. Fired by Composer when the user picks a file.
   * Uploads multipart, then polls /declaration-runs/:id every 2s until
   * status is terminal (completed | failed | cancelled). When Phase 1
   * completes (classification_status='completed') we fetch the per-item
   * classifications so the result table can render even before Phase 2
   * finishes XML rendering.
   */
  const handleBatchUpload = async (file: File) => {
    stopPolling();
    setBatchState({ ...initialBatchState, phase: 'uploading' });
    try {
      const created = await api.createDeclarationRun({
        file,
        operatorSlug: 'naqel',
        mode: 'classify_and_declare',
      });
      const runId = created.declaration_run_id;
      setBatchState((s) => ({ ...s, phase: 'polling', runId }));
      startPollingRun(runId);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? `${err.status}: ${err.message}`
          : err instanceof Error
            ? err.message
            : 'Upload failed.';
      setBatchState({ ...initialBatchState, phase: 'error', errorMessage: msg });
    }
  };

  // Stop polling on unmount.
  useEffect(() => () => stopPolling(), []);

  // Resume a batch run from ?run=<id> in the URL. Runs once on mount
  // (after auth resolves) so navigating back to the page or sharing
  // the URL drops you right back into the live result panel.
  const resumedRef = useRef(false);
  useEffect(() => {
    if (authState !== 'authenticated') return;
    if (resumedRef.current) return;
    const urlRunId = getUrlRunId();
    if (!urlRunId) return;
    resumedRef.current = true;
    stopPolling();
    setMode('batch');
    setBatchState({ ...initialBatchState, phase: 'polling', runId: urlRunId });
    startPollingRun(urlRunId);
  }, [authState, startPollingRun]);

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
      if (m === 'generate' || m === 'expand') {
        // Both Generate and Expand now route through /pipeline/dispatch.
        // Expand passes the parent code as merchant_code so Track B can
        // resolve / disambiguate against the merchant-supplied prefix in
        // parallel with Track A's blind classification.
        if (m === 'expand' && !parentCode) {
          throw new Error('Parent code required for Expand mode.');
        }
        const dispatchRes = await api.dispatch({
          description,
          value_amount: extras?.valueAmount,
          currency_code: extras?.currencyCode,
          ...(m === 'expand' && parentCode ? { merchant_code: parentCode } : {}),
        });
        res = dispatchToDescribe(dispatchRes);
      } else {
        // Batch mode submits via Composer's onPickFile callback into
        // handleBatchUpload(); the textarea-form submit path never
        // fires for batch (mode !== 'batch' guards above).
        return;
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
              {/*
                Composer collapser. In batch mode, the moment a file
                upload kicks off (`batchState.phase !== 'idle'`) we
                collapse the entire ModeTabs + Composer block so the
                result panel below gets the full visual weight. The
                wrapper animates max-height + padding + opacity +
                margin-top in lockstep on the same cubic-bezier so the
                page reflow feels intentional, not janky.

                Generate / expand modes never collapse — those flows
                expect the composer to stay editable while results
                render below it.
              */}
              {(() => {
                const composerCollapsed =
                  mode === 'batch' && batchState.phase !== 'idle';
                return (
                  <div
                    className="overflow-hidden"
                    style={{
                      maxHeight: composerCollapsed ? 0 : 720,
                      opacity: composerCollapsed ? 0 : 1,
                      marginTop: composerCollapsed ? 0 : undefined,
                      pointerEvents: composerCollapsed ? 'none' : 'auto',
                      transition:
                        'max-height 0.55s cubic-bezier(0.7, 0, 0.3, 1), opacity 0.3s ease, margin-top 0.3s ease',
                    }}
                    aria-hidden={composerCollapsed}
                  >
                    <div className="flex flex-col items-center">
                      <ModeTabs mode={mode} onModeChange={setMode} />
                      <Composer
                        mode={mode}
                        onSubmit={handleSubmit}
                        onPickFile={handleBatchUpload}
                        loading={
                          mode === 'batch'
                            ? batchState.phase === 'uploading' || batchState.phase === 'polling'
                            : phase === 'classifying'
                        }
                        className="w-full"
                      />
                    </div>
                  </div>
                );
              })()}

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
          {authState === 'authenticated' && (
            <div className="mt-6">
              {/* Single-shot result. Only fills when phase='result' on the active single mode. */}
              {phase === 'result' && (mode === 'generate' || mode === 'expand') && (
                <ResultSingle
                  visible
                  data={response}
                  latencyMs={latencyMs ?? undefined}
                  onRetry={handleRetry}
                  onPickAlternative={handleManualPick}
                />
              )}
              {/* Batch result. Mounts during upload + polling so the user sees progress. */}
              <ResultBatch
                visible={mode === 'batch' && batchState.phase !== 'idle'}
                state={batchState}
                onReset={handleResetBatch}
              />
            </div>
          )}
        </div>
      </main>

      <Footer />
    </>
  );
}
