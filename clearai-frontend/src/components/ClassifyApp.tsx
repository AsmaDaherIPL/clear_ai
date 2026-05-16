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
  pickLang,
  type DescribeResponse,
  type DispatchItem,
  type DeclarationRunSummary,
  type DeclarationRunItem,
  type AlternativeLine,
  type AnchoredPickOutput,
  type AnchoredCandidateSummary,
} from '@/lib/api';

/**
 * Adapt the new `/pipeline/dispatch` response shape into the legacy
 * `DescribeResponse` envelope the existing `ResultSingle` renderer expects.
 * Plan B step 3 will replace this with a purpose-built renderer for the
 * cleaner trace shape.
 */
function dispatchToDescribe(d: DispatchItem): DescribeResponse {
  const resolved = d.classification_result?.resolved_hs_code ?? null;
  const sanity = d.classification_result?.sanity_verdict ?? null;
  const accepted = resolved !== null && sanity !== 'BLOCK';

  const submissionAr = pickLang(d.resolved_hs_code_description?.zatca_submission_description, 'ar');
  const submissionEn = pickLang(d.resolved_hs_code_description?.zatca_submission_description, 'en');

  // Pull the sanity rationale directly from the trace when FLAG/BLOCK.
  // This gives the user the value-too-low / value-too-high reason inline.
  const sanityRationale: string | null = (() => {
    if (!d.trace || !sanity || sanity === 'PASS') return null;
    const sanityStage = (d.trace.stages ?? []).find((s) => s.stage === 'sanity');
    const sanityAction = sanityStage?.actions?.[0];
    return (sanityAction?.output as { rationale?: string } | undefined)?.rationale ?? null;
  })();

  // Detect pipeline architecture from trace summary.
  const arch = d.trace?.summary?.pipeline_architecture ?? 'legacy';
  const meta = d.trace?.meta;

  let alternatives: AlternativeLine[] = [];
  let anchoredCandidateSummary: AnchoredCandidateSummary | null = null;
  let retrievalQuery: string | null = d.resolved_hs_code_description?.retrieval_query ?? null;

  if (arch === 'v2') {
    // v2 (PR 13): aggregate counts from pick action output AND
    // per-candidate verdicts from annotated_candidates (added with the
    // fix that surfaces the picker's per-row judgement). retrieval_query
    // sourced from identify.canonical.
    const classifyStage = (d.trace?.stages ?? []).find((s) => s.stage === 'classify');
    const pickAction = classifyStage?.actions?.find((a) => a.action === 'pick');
    const pickOut = pickAction?.output as
      | (AnchoredPickOutput & {
          annotated_candidates?: Array<{
            code: string;
            description_en?: string | null;
            description_ar?: string | null;
            fit?: 'fits' | 'partial' | 'does_not_fit';
            rationale?: string;
            source_arm?: 'merchant_prefix' | 'family_chapter' | 'unconstrained' | 'lexical_tokens';
            rerank_score?: number;
          }>;
        })
      | undefined;

    if (pickOut?.verdict_population) {
      const p = pickOut.verdict_population;
      anchoredCandidateSummary = {
        kind: 'aggregate',
        candidate_count: p.fits + p.partial + p.does_not_fit,
        fits: p.fits,
        partial: p.partial,
        does_not_fit: p.does_not_fit,
        gir_applied: pickOut.gir_applied,
      };
    }

    const identifyAction = classifyStage?.actions?.find((a) => a.action === 'identify');
    const identifyOut = identifyAction?.output as { canonical?: string } | undefined;
    retrievalQuery = identifyOut?.canonical ?? retrievalQuery;

    // Per-candidate alternatives: surface every annotated row EXCEPT
    // the winning final_code. Sorted: fits → partial → does_not_fit by
    // fit severity, then by descending rerank_score within each group.
    // Cap at 6 to keep the sidebar readable; the full list lives in
    // the trace JSON for HITL operators.
    const fitOrder: Record<string, number> = { fits: 0, partial: 1, does_not_fit: 2 };
    alternatives = (pickOut?.annotated_candidates ?? [])
      .filter((c) => c.code !== resolved)
      .sort((a, b) => {
        const fa = fitOrder[a.fit ?? 'does_not_fit'] ?? 3;
        const fb = fitOrder[b.fit ?? 'does_not_fit'] ?? 3;
        if (fa !== fb) return fa - fb;
        return (b.rerank_score ?? 0) - (a.rerank_score ?? 0);
      })
      .slice(0, 6)
      .map<AlternativeLine>((c) => ({
        code: c.code,
        description_en: c.description_en ?? null,
        description_ar: c.description_ar ?? null,
        retrieval_score: typeof c.rerank_score === 'number' ? c.rerank_score : null,
        fit: normaliseFit(c.fit),
        reason: c.rationale,
        source_arm: c.source_arm,
      }));
  } else if (arch === 'anchored') {
    // Anchored: per-candidate verdicts not yet on wire — read aggregate counts
    // from the pick action output inside the classify stage.
    const classifyStage = (d.trace?.stages ?? []).find((s) => s.stage === 'classify');
    const pickAction = classifyStage?.actions?.find((a) => a.action === 'pick');
    const pickOut = pickAction?.output as AnchoredPickOutput | undefined;

    if (pickOut?.verdict_population) {
      const p = pickOut.verdict_population;
      anchoredCandidateSummary = {
        kind: 'aggregate',
        candidate_count: p.fits + p.partial + p.does_not_fit,
        fits: p.fits,
        partial: p.partial,
        does_not_fit: p.does_not_fit,
        gir_applied: pickOut.gir_applied,
      };
    }

    // Retrieval query = identify.canonical under anchored.
    const identifyAction = classifyStage?.actions?.find((a) => a.action === 'identify');
    const identifyOut = identifyAction?.output as { canonical?: string } | undefined;
    retrievalQuery = identifyOut?.canonical ?? retrievalQuery;

    // alternatives[] stays empty — no per-candidate data on the wire yet.
    alternatives = [];
  } else {
    // Legacy: union track_a + track_b candidates, top 3 each, chosen code excluded.
    const trackA = (meta?.track_a?.annotated_candidates ?? [])
      .filter((c) => c.code !== resolved)
      .slice(0, 3)
      .map<AlternativeLine>((c) => ({
        code: c.code,
        description_en: c.description_en ?? null,
        description_ar: c.description_ar ?? null,
        retrieval_score: typeof c.rrf_score === 'number' ? c.rrf_score : null,
        fit: normaliseFit(c.fit),
        reason: c.rationale,
        track: 'track_a',
      }));
    const trackB = (meta?.track_b?.subtree_candidates ?? [])
      .filter((c) => c.code !== resolved)
      .slice(0, 3)
      .map<AlternativeLine>((c) => ({
        code: c.code,
        description_en: c.description_en ?? null,
        description_ar: c.description_ar ?? null,
        retrieval_score: typeof c.rrf_score === 'number' ? c.rrf_score : null,
        fit: normaliseFit(c.fit),
        reason: c.rationale,
        track: 'track_b',
      }));
    alternatives = [...trackA, ...trackB];
  }

  // Map pick.fit to a decision_reason so ResultSingle shows the right pill.
  // 'fits' → strong_match, 'partial' → heading_level_match (family), else strong_match.
  const pickFitReason = (() => {
    if (!accepted) return 'ambiguous_top_candidates' as const;
    const classifyStageForFit = (d.trace?.stages ?? []).find((s) => s.stage === 'classify');
    const pickActionFit = classifyStageForFit?.actions?.find((a) => a.action === 'pick');
    const fit = (pickActionFit?.output as { fit?: string } | undefined)?.fit;
    if (fit === 'partial') return 'heading_level_match' as const;
    return 'strong_match' as const;
  })();

  const confidence = d.classification_result?.classification_confidence ?? null;

  // v2 verifier signal — pulled from the trace summary when present.
  // Surfacing on the envelope lets ResultSingle render the operator-review
  // banner alongside the sanity banner without re-walking the trace.
  const verifierResult = d.trace?.summary?.verifier_result ?? null;
  const verifierRules = d.trace?.summary?.verifier_rules_triggered ?? null;

  return {
    request_id: d.id,
    decision_status: accepted ? 'accepted' : 'needs_clarification',
    decision_reason: pickFitReason,
    classification_status: d.classification_result?.classification_status ?? undefined,
    // Only propagate FLAG/BLOCK to the UI — PASS is a no-op for display.
    sanity_verdict: (sanity === 'FLAG' || sanity === 'BLOCK') ? sanity : null,
    sanity_rationale: sanityRationale,
    alternatives,
    anchored_candidate_summary: anchoredCandidateSummary,
    retrieval_query: retrievalQuery,
    verifier_result: verifierResult,
    verifier_rules_triggered: verifierRules,
    result: accepted
      ? {
          code: resolved as string,
          description_en: null,
          description_ar: submissionAr,
          // Catalog hierarchy breadcrumbs for the result card.
          path_en: pickLang(d.resolved_hs_code_description?.full_hierarchy, 'en'),
          path_ar: pickLang(d.resolved_hs_code_description?.full_hierarchy, 'ar'),
          classification_confidence: confidence,
          duty: d.duty_info ?? null,
          procedures: d.procedures ?? [],
        }
      : undefined,
    submission_description: submissionAr
      ? {
          description_ar: submissionAr,
          description_en: submissionEn ?? '',
          rationale: '',
          differs_from_catalog: true,
          source: 'llm',
        }
      : undefined,
    model: { embedder: 'text-embedding-3-large', llm: null },
  };
}

/**
 * Map upstream fit strings to the AlternativeLine fit enum. The dispatch
 * payload emits 'fits' | 'partial' | 'does_not_fit'; legacy code uses
 * 'excludes' as a synonym for does_not_fit. Returns undefined for unknown
 * values so the sidebar pill is omitted rather than rendering raw text.
 */
function normaliseFit(raw?: string): AlternativeLine['fit'] | undefined {
  if (!raw) return undefined;
  const lc = raw.toLowerCase();
  if (lc === 'fits') return 'fits';
  if (lc === 'partial') return 'partial';
  if (lc === 'does_not_fit' || lc === 'excludes') return 'does_not_fit';
  return undefined;
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

// One items fetch per tick — no summary call during active polling.
// Summary is fetched once at run start (for row_count / skeleton sizing)
// and once at terminal (for official final counts + timestamps).
// Between those two points, counts are derived client-side from the
// items array so we cut per-tick API calls from 2 → 1.
const POLL_INTERVAL_MS = 8000;
// Polling ceiling: 5 min for small batches, 15 min for large ones (>=100 rows).
const POLL_TIMEOUT_MS_SMALL = 5 * 60 * 1000;
const POLL_TIMEOUT_MS_LARGE = 15 * 60 * 1000;
const LARGE_BATCH_THRESHOLD = 100;
function pollTimeoutMs(rowCount: number | null | undefined): number {
  return (rowCount ?? 0) >= LARGE_BATCH_THRESHOLD
    ? POLL_TIMEOUT_MS_LARGE
    : POLL_TIMEOUT_MS_SMALL;
}

/**
 * Derive succeeded/flagged/blocked/failed/pending counts from the items
 * we already have in state. Used to patch the summary during active
 * polling so the header chips stay live without a separate summary GET.
 *
 * pending = rows we haven't seen yet (row_count - items.length).
 * Mirrors itemBucket() in BatchResultsTable exactly.
 */
function deriveCountsFromItems(
  items: DeclarationRunItem[],
  rowCount: number,
): { succeeded: number; flagged: number; blocked: number; failed: number; pending: number } {
  let succeeded = 0, flagged = 0, blocked = 0, failed = 0, processedInArray = 0;
  for (const item of items) {
    const hasError = Boolean(item.error);
    const hasClassificationResult = item.classification_result != null;

    // Item returned by the API but not yet processed — no error and no result.
    // Count it toward pending rather than failed.
    if (!hasError && !hasClassificationResult) continue;

    processedInArray++;
    // Check verdict before the no-code guard — BLOCK items may have no
    // resolved_hs_code but must still count as blocked, not failed.
    const sanity = item.classification_result?.sanity_verdict?.toUpperCase();
    if (sanity === 'BLOCK') { blocked++; continue; }
    if (sanity === 'FLAG')  { flagged++; continue; }
    const hasCode = Boolean(item.classification_result?.resolved_hs_code);
    if (hasError || !hasCode) { failed++; continue; }
    succeeded++;
  }
  // pending = rows not yet returned at all + rows returned but not yet processed
  const notYetReturned = Math.max(0, rowCount - items.length);
  const returnedButUnprocessed = items.length - processedInArray;
  const pending = notYetReturned + returnedButUnprocessed;
  return { succeeded, flagged, blocked, failed, pending };
}
const PAGE_SIZE = 200; // page size when fetching classifications; max is 500 server-side
const MAX_PAGES = 10;  // hard cap on auto-paging: 200 * 10 = 2000 items per run

/**
 * Parse "Rate limit exceeded, retry in 18 seconds" (APIM 429 message
 * format) into a millisecond delay. Returns null if the message doesn't
 * match. Used to back off honourably when APIM throttles us rather than
 * hammering and tripping the rate-limit cooldown indefinitely.
 */
function parseRetryAfterMs(message: string | null | undefined): number | null {
  if (!message) return null;
  const m = message.match(/retry in (\d+) seconds?/i);
  if (!m) return null;
  const seconds = Number(m[1]);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 600) return null;
  return seconds * 1000;
}

/**
 * Fetch just the FIRST page of classifications. Used during active
 * polling — the table fills in row-by-row from this page's items merged
 * by id into existing state, so we don't refetch the whole run on every
 * 3-second tick. For a 500-item batch this drops the per-tick call rate
 * from 3 (3 pages) to 1.
 *
 * Trade-off: items past offset PAGE_SIZE that flip mid-run won't show
 * until the next page is fetched. Acceptable because items past 200
 * settle in the final terminal fetch via fetchAllClassifications.
 */
async function fetchFirstPageClassifications(runId: string): Promise<{
  items: DeclarationRunItem[];
  classification_phase?: 'pending' | 'running' | 'completed' | 'failed';
  total: number;
}> {
  const first = await api.getDeclarationRunClassifications(runId, { limit: PAGE_SIZE, offset: 0 });
  return {
    items: first.items,
    total: first.total ?? first.items.length,
    ...(first.classification_phase ? { classification_phase: first.classification_phase } : {}),
  };
}

/**
 * Fetch ALL classification items for a run, auto-paging until the
 * server's `total` is satisfied or MAX_PAGES is hit. Only called at
 * terminal (classification_phase = completed | failed) to assemble the
 * final reconciled table. Bounded to prevent a runaway loop.
 *
 * 429-aware: if a mid-pagination page hits APIM rate limit, waits the
 * advertised retry-after duration before continuing. Doesn't restart
 * from page 0 — previously-fetched pages survive the wait.
 */
async function fetchAllClassifications(runId: string): Promise<{
  items: DeclarationRunItem[];
  classification_phase?: 'pending' | 'running' | 'completed' | 'failed';
}> {
  const first = await api.getDeclarationRunClassifications(runId, { limit: PAGE_SIZE, offset: 0 });
  const total = first.total ?? first.items.length;
  const all = [...first.items];
  let page = 1;
  while (all.length < total && page < MAX_PAGES) {
    try {
      const next = await api.getDeclarationRunClassifications(runId, {
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      all.push(...next.items);
      if (next.items.length === 0) break;
      page += 1;
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        // Wait out APIM's cooldown, then retry the same page. The
        // already-fetched pages stay in `all` so we don't redo work.
        const retryMs = parseRetryAfterMs(err.message) ?? 30_000;
        await new Promise((resolve) => setTimeout(resolve, retryMs));
        continue;
      }
      throw err;
    }
  }
  return {
    items: all,
    ...(first.classification_phase ? { classification_phase: first.classification_phase } : {}),
  };
}

/**
 * Merge incoming items into an existing array, keyed by id. New items
 * append; existing ids get replaced with the latest server state. Used
 * during active polling so a partial first-page response doesn't
 * temporarily blank out items past page 1 that we'd already loaded.
 */
function mergeItemsById(
  prev: DeclarationRunItem[],
  incoming: DeclarationRunItem[],
): DeclarationRunItem[] {
  if (prev.length === 0) return incoming;
  const byId = new Map<string, DeclarationRunItem>();
  for (const item of prev) byId.set(item.id, item);
  for (const item of incoming) byId.set(item.id, item);
  // Preserve row_index order — server returns in that order; the map
  // may have shuffled it. Sort to be safe.
  return Array.from(byId.values()).sort((a, b) => (a.row_index ?? 0) - (b.row_index ?? 0));
}

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

/**
 * Mirror the single-shot classification id to the URL as ?id=… so the
 * user can copy/share the result page or come back to it from history.
 * Single-shot doesn't currently resume from URL on page load (a follow-up
 * GET endpoint is needed for that); the URL is informational + shareable.
 */
function syncClassificationIdToUrl(id: string | null): void {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  if (id) {
    params.set('id', id);
  } else {
    params.delete('id');
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
  // True once the URL-resume effect has already fired for the current
  // session. Reset on sign-out so a fresh sign-in re-triggers resume,
  // and reset on poll error so the user can retry by reloading.
  const resumedRef = useRef(false);
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

  // Keep ?id=<classification_id> in sync with single-shot results.
  // Only mirrors when the current mode is generate/expand and there's
  // a response — batch mode owns the URL via ?run= (above), so we don't
  // want both params fighting. Clears when the user wipes the result.
  useEffect(() => {
    if (mode === 'batch') return;
    const id = cur.response?.request_id ?? null;
    syncClassificationIdToUrl(id);
  }, [mode, cur.response]);

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
   * reaches a terminal state.
   *
   * Call-volume notes:
   *   - One API call per tick (classifications endpoint only). It returns
   *     `classification_phase` + items + pagination, which is everything
   *     needed during active classification.
   *   - The run-summary endpoint is hit ONCE at the start (for row_count
   *     so the skeleton table knows how many lines to draw) and ONCE at
   *     terminal (for final per-status counts). This keeps APIM happy —
   *     polling both endpoints every 2 seconds tripped a rate limit.
   *   - On 429, parses the APIM "retry in N seconds" message and waits
   *     that long instead of hammering through.
   */
  const startPollingRun = useCallback((runId: string) => {
    const startedAt = Date.now();
    // row_count tracked locally: seeded by the one-time start summary fetch,
    // used for ceiling calculation and pending count derivation.
    let knownRowCount: number | null = null;

    const poll = async (): Promise<void> => {
      const ceiling = pollTimeoutMs(knownRowCount);
      if (Date.now() - startedAt > ceiling) {
        // Before giving up, do one final summary check — the backend may
        // have finished in the window after our last tick.
        try {
          const summary = await api.getDeclarationRun(runId);
          if (summary.status === 'completed' || summary.status === 'failed') {
            const finalCls = await fetchAllClassifications(runId);
            setBatchState((s) => ({
              ...s,
              phase: 'done',
              summary,
              items: mergeItemsById(s.items, finalCls.items),
              errorMessage: null,
            }));
            return;
          }
        } catch {
          // Recovery fetch failed — fall through to timeout message.
        }
        const minutesCeiling = Math.round(ceiling / 60_000);
        setBatchState((s) => ({
          ...s,
          phase: 'error',
          errorMessage: `Run still in progress after ${minutesCeiling} minutes — check the run page later.`,
        }));
        return;
      }

      try {
        // --- FIRST TICK ONLY: fetch summary to seed row_count ---
        // row_count drives the skeleton row count before items arrive.
        // After the first tick we derive counts from items, not from
        // a second summary call per tick.
        if (knownRowCount === null) {
          try {
            const summary = await api.getDeclarationRun(runId);
            knownRowCount = summary.row_count ?? null;
            setBatchState((s) => ({ ...s, summary }));
          } catch {
            // Non-fatal: skeleton won't know the expected count but
            // items will still render as they arrive.
          }
        }

        // Fetch one page of items. The classification_phase on this
        // response is the authoritative stop signal.
        const firstPage = await fetchFirstPageClassifications(runId);
        const classificationPhase = firstPage.classification_phase;

        // Merge items and patch summary counts from the new item set.
        setBatchState((s) => {
          const merged = mergeItemsById(s.items, firstPage.items);
          const rowCount = knownRowCount ?? firstPage.total ?? merged.length;
          const derived = deriveCountsFromItems(merged, rowCount);
          const patchedSummary = s.summary
            ? { ...s.summary, ...derived }
            : null;
          return { ...s, items: merged, summary: patchedSummary };
        });

        if (classificationPhase === 'completed' || classificationPhase === 'failed') {
          // Terminal: fetch all pages for a complete final table, then
          // get the authoritative summary (official counts + timestamps).
          try {
            const finalCls = await fetchAllClassifications(runId);
            setBatchState((s) => ({ ...s, items: mergeItemsById(s.items, finalCls.items) }));
          } catch {
            /* swallow — keep whatever's in state */
          }
          try {
            const finalSummary = await api.getDeclarationRun(runId);
            setBatchState((s) => ({ ...s, summary: finalSummary }));
          } catch {
            /* non-fatal — counts from items are still visible */
          }
          setBatchState((s) => ({ ...s, phase: 'done' }));
          return;
        }

        pollTimerRef.current = window.setTimeout(poll, POLL_INTERVAL_MS);
      } catch (err) {
        if (err instanceof ApiError && err.status === 429) {
          const retryMs = parseRetryAfterMs(err.message) ?? 30_000;
          pollTimerRef.current = window.setTimeout(poll, retryMs);
          return;
        }
        let msg: string;
        if (err instanceof ApiError) {
          if (err.status === 404) {
            msg = `Run ${runId} not found. It may have been deleted, or you may not have access.`;
          } else if (err.status === 401 || err.status === 403) {
            msg = `You don't have access to run ${runId}. Sign in with the account that created it.`;
          } else if (err.status === 503) {
            pollTimerRef.current = window.setTimeout(poll, POLL_INTERVAL_MS * 2);
            return;
          } else {
            msg = `${err.status}: ${err.message}`;
          }
        } else if (err instanceof Error) {
          msg = err.message;
        } else {
          msg = 'Polling failed.';
        }
        resumedRef.current = false;
        setBatchState((s) => ({ ...s, phase: 'error', errorMessage: msg }));
      }
    };

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
      const created = await api.createBatch({
        file,
        mode: 'classify_and_declare',
      });
      const runId = created.batch_id;
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

  // Resume a batch run from ?run=<id> in the URL. Runs once after auth
  // resolves so navigating back to the page or sharing the URL drops
  // you right back into the live result panel. The poll loop handles
  // error surfacing — if the run doesn't exist or the user doesn't
  // have access, phase flips to 'error' with a message.
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

  // When auth flips from authenticated → unauthenticated (sign-out,
  // token expiry), reset the resume latch so a subsequent sign-in
  // re-runs the URL resume. Without this, sign-out + sign-in in the
  // same tab leaves the resumedRef permanently set and the URL ?run=
  // param stops triggering a resume.
  useEffect(() => {
    if (authState === 'unauthenticated') {
      resumedRef.current = false;
    }
  }, [authState]);

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
  ): Promise<void> => {
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
        if (m === 'expand' && !parentCode) {
          throw new Error('Parent code required for Expand mode.');
        }
        if (!extras) {
          throw new Error('Value and currency are required.');
        }
        const dispatchRes = await api.dispatch(
          {
            description,
            value_amount: extras.valueAmount,
            currency_code: extras.currencyCode,
            ...(m === 'expand' && parentCode ? { merchant_code: parentCode } : {}),
          },
          { includeTrace: true },
        );
        res = dispatchToDescribe(dispatchRes.item);
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
        Responsive page column. Width tracks viewport up to a 1180px
        ceiling — clamp keeps it from sprawling on ultrawide monitors
        while honouring narrower laptop screens. The inner wrapper
        used to be capped at 760px so the composer felt prose-style,
        but the form was visually narrower than the result cards
        below it. They now share the same 1080px ceiling so the
        composer and result panel align edge-to-edge.
      */}
      <main className="w-full max-w-[min(95vw,1180px)] mx-auto px-7 pt-20 pb-12">
        <div className="w-full max-w-[1080px] mx-auto">
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
                ModeTabs stays mounted ALWAYS — even during a live batch run.
                Hiding the mode pills during batch processing trapped the
                user inside batch view with no visible way to pivot back
                to Generate / Expand. Tabs are short and unobtrusive; the
                result panel below still gets visual weight because only
                the composer (the heavy textarea + dropzone block) collapses.
              */}
              <div className="flex flex-col items-center">
                <ModeTabs mode={mode} onModeChange={setMode} />
              </div>

              {/*
                Composer collapser. In batch mode, the moment a file
                upload kicks off (`batchState.phase !== 'idle'`) we
                collapse just the Composer so the result panel below
                gets the full visual weight. The wrapper animates
                max-height + opacity + margin-top in lockstep on the
                same cubic-bezier so the page reflow feels intentional.

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
              {/*
                Batch result. Mounts during upload + polling so the user
                sees progress. Breaks out of the <main>'s 1180px constraint
                via the classic full-bleed pattern (w-[85vw] + left:50% +
                -translate-x-1/2 relative to its anchor) so the wide table
                gets the room it needs without affecting Generate/Expand
                layouts above. Capped at max-w-[1600px] so it doesn't
                sprawl on ultrawide monitors.
              */}
              {mode === 'batch' && batchState.phase !== 'idle' && (
                <div className="relative left-1/2 -translate-x-1/2 w-[85vw] max-w-[1600px]">
                  <ResultBatch
                    visible
                    state={batchState}
                    onReset={handleResetBatch}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      <Footer />
    </>
  );
}
