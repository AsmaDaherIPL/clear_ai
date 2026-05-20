import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { api, ApiError, type BatchFile, type DownloadLinks, type BatchItem } from '@/lib/api';
import type { BatchState } from './ClassifyApp';
import BatchResultsTable from './BatchResultsTable';
import ReviewDialog, { type ReviewItem } from './ReviewDialog';
import { zipSync } from 'fflate';

function humanError(raw: string | null | undefined): string {
  if (!raw) return '';
  if (raw.includes('LOW_INFORMATION')) return 'Description too vague to classify — sent to manual review (HITL queue)';
  if (raw.includes('escalated to HITL')) return 'Sent to manual review (HITL queue)';
  return raw;
}

type PhaseDescriptor = { title: string; suffix: string };
function describePhase(state: {
  phase: 'idle' | 'uploading' | 'polling' | 'done' | 'error';
  summary: { status: string; classification_status: string; succeeded: number } | null;
}): PhaseDescriptor {
  switch (state.phase) {
    case 'uploading':
      return { title: 'Uploading', suffix: '— preparing your invoice' };
    case 'polling': {
      const cls = state.summary?.classification_status;
      if (cls === 'running' || cls === 'pending') {
        return { title: 'Processing', suffix: '— phase 1: classifying lines' };
      }
      if (cls === 'completed') {
        return { title: 'Processing', suffix: '— phase 2: assembling declaration' };
      }
      return { title: 'Processing', suffix: '' };
    }
    case 'done': {
      if (state.summary?.status === 'completed') {
        return { title: 'Run complete', suffix: '' };
      }
      if (state.summary?.status === 'failed' && (state.summary?.succeeded ?? 0) === 0) {
        return { title: 'Run failed', suffix: '— stopped before any item completed' };
      }
      if (state.summary?.status === 'failed') {
        return { title: 'Run failed', suffix: '— stopped at declaration phase' };
      }
      return { title: `Run ${state.summary?.status ?? 'finished'}`, suffix: '' };
    }
    case 'error':
      return { title: 'Error', suffix: '' };
    default:
      return { title: 'Idle', suffix: '' };
  }
}

// ---------------------------------------------------------------------------
// Derive counts from items — mirrors itemBucket() in BatchResultsTable.
//
// "Succeeded" for the stat card = any item that has a resolved HS code,
// whether or not it is also value-flagged. This matches the user rule:
//   "success are all items that got classified, even if flagged for VA"
// "Flagged" = items with sanity_verdict FLAG or BLOCK (value plausibility)
//   — these also count as "succeeded" (they have a code) but are surfaced
//   separately so the operator knows to review.
// ---------------------------------------------------------------------------

function deriveStatCounts(items: BatchItem[], isComplete: boolean) {
  let classifiedWithCode = 0; // succeeded + flagged (has code regardless of plausibility)
  let flagged = 0;            // FLAG or BLOCK — has code but plausibility concern

  for (const item of items) {
    const hasError = Boolean(item.error);
    const hasResult = item.classification_result != null;
    if (!hasError && !hasResult) continue;

    const sanity = item.classification_result?.sanity_verdict?.toUpperCase();
    const hasCode = Boolean(item.classification_result?.resolved_hs_code);

    if (hasCode) {
      classifiedWithCode++;
      if (sanity === 'FLAG' || sanity === 'BLOCK') {
        flagged++;
      }
    }
  }

  return { classifiedWithCode, flagged };
}

interface ResultBatchProps {
  visible: boolean;
  state: BatchState;
  onReset?: () => void;
  className?: string;
}

export default function ResultBatch({ visible, state, onReset, className }: ResultBatchProps) {
  const t = useT();
  const [downloadLinks, setDownloadLinks] = useState<DownloadLinks | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadLoading, setDownloadLoading] = useState(false);
  const [bundleDownloading, setBundleDownloading] = useState(false);
  const [fileFetching, setFileFetching] = useState<Record<string, boolean>>({});
  const autoFetchedRunRef = useRef<string | null>(null);

  // Review queue dialog state
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewQueue, setReviewQueue] = useState<ReviewItem[]>([]);
  const [reviewIndex, setReviewIndex] = useState(0);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewLoadError, setReviewLoadError] = useState<string | null>(null);
  const [reviewedCount, setReviewedCount] = useState(0);

  const summary = state.summary;
  const items = state.items;
  const isPolling = state.phase === 'uploading' || state.phase === 'polling';
  const runFinished =
    state.summary?.status === 'completed' || state.summary?.status === 'failed';
  const canReset = runFinished || state.phase === 'error';
  const partialOutput =
    (state.summary?.succeeded ?? 0) + (state.summary?.flagged ?? 0) > 0;
  const runDone = runFinished && partialOutput;

  // Derive display counts from the live items array so the header
  // reflects the new "succeeded = has code" rule regardless of backend summary.
  const { classifiedWithCode, flagged: flaggedCount } = deriveStatCounts(
    items,
    state.phase === 'done' || state.phase === 'error',
  );

  const fetchDownloadLinks = async (runId: string) => {
    setDownloadError(null);
    setDownloadLoading(true);
    try {
      const links = await api.getBatchFiles(runId);
      setDownloadLinks(links);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? `${err.status}: ${err.message}`
          : err instanceof Error
            ? err.message
            : 'Failed to fetch download links.';
      setDownloadError(msg);
    } finally {
      setDownloadLoading(false);
    }
  };

  const handleDownloadBundle = async (runId: string, xmlFiles: BatchFile[]) => {
    if (bundleDownloading) return;
    setDownloadError(null);
    setBundleDownloading(true);
    try {
      const results = await Promise.all(
        xmlFiles.map(async (f) => {
          const blob = await api.getBatchFile(runId, f.name);
          const buf = await blob.arrayBuffer();
          return { name: f.name, data: new Uint8Array(buf) };
        }),
      );
      const zipInput: Record<string, Uint8Array> = {};
      for (const r of results) zipInput[r.name] = r.data;
      const zipped = zipSync(zipInput);
      const blob = new Blob([zipped], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `declaration-bundle-${runId.slice(0, 8)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? `${err.status}: ${err.message}`
          : err instanceof Error
            ? err.message
            : 'Failed to build declaration bundle.';
      setDownloadError(msg);
    } finally {
      setBundleDownloading(false);
    }
  };

  useEffect(() => {
    setDownloadLinks(null);
    setDownloadError(null);
    setFileFetching({});
    autoFetchedRunRef.current = null;
    // Reset review queue state when run changes
    setReviewQueue([]);
    setReviewIndex(0);
    setReviewedCount(0);
    setReviewLoadError(null);
  }, [state.runId]);

  useEffect(() => {
    if (!state.runId || !runDone) return;
    if (autoFetchedRunRef.current === state.runId) return;
    autoFetchedRunRef.current = state.runId;
    void fetchDownloadLinks(state.runId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.runId, runDone]);

  // ---------------------------------------------------------------------------
  // Review queue: fetch + open
  // ---------------------------------------------------------------------------

  const openResolveQueue = useCallback(async () => {
    if (!state.runId) return;
    setReviewLoadError(null);
    setReviewLoading(true);
    try {
      const res = await api.listReviewQueue({ batch_id: state.runId, status: 'pending', limit: 100 });
      const mapped: ReviewItem[] = res.items.map((row) => {
        // Determine mode: sanity_flag → value check; everything else → low confidence
        const flagType: 'value' | 'hs' = row.reason === 'sanity_flag' ? 'value' : 'hs';
        // Pull description + merchant code from the payload when available
        const payload = row.payload ?? {};
        const description = String(payload['description'] ?? payload['product_description'] ?? '');
        const merchantCode = payload['merchant_code'] != null ? String(payload['merchant_code']) : null;
        const lineNumber = payload['row_index'] != null ? Number(payload['row_index']) : null;
        const valueAmount = payload['value_amount'] != null ? Number(payload['value_amount']) : null;
        const valueCurrency = payload['value_currency'] != null ? String(payload['value_currency']) : 'SAR';
        const candidates = row.candidates ?? [];
        return {
          id: row.id,
          description,
          merchantCode,
          lineNumber,
          value: valueAmount != null ? { amount: valueAmount, currency: valueCurrency } : null,
          currentCode: row.current_final_code ?? null,
          currentConfidence: row.current_classification_confidence ?? null,
          verdict: row.current_sanity_verdict ?? null,
          flagType,
          sanityRationale: row.current_sanity_rationale ?? null,
          alternatives: candidates.map((c) => ({
            code: c.code,
            description_en: c.description_en ?? null,
            description_ar: c.description_ar ?? null,
            retrieval_score: c.rerank_score ?? null,
          })),
        };
      });
      setReviewQueue(mapped);
      setReviewIndex(0);
      setReviewedCount(0);
      setReviewOpen(true);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? `${err.status}: ${err.message}`
          : err instanceof Error
            ? err.message
            : 'Failed to load review queue.';
      setReviewLoadError(msg);
    } finally {
      setReviewLoading(false);
    }
  }, [state.runId]);

  // ---------------------------------------------------------------------------
  // Review queue: decision handlers
  // ---------------------------------------------------------------------------

  const handleReviewAccept = useCallback(async (item: ReviewItem) => {
    try {
      await api.submitReviewDecision(item.id, { decision: 'approve' });
    } catch {
      // Best-effort — move on regardless
    }
    setReviewedCount((n) => n + 1);
    setReviewIndex((i) => {
      const next = i + 1;
      if (next >= reviewQueue.length) setReviewOpen(false);
      return next;
    });
  }, [reviewQueue.length]);

  const handleReviewDismiss = useCallback(async (item: ReviewItem) => {
    try {
      await api.submitReviewDecision(item.id, { decision: 'reject' });
    } catch {
      // Best-effort
    }
    setReviewedCount((n) => n + 1);
    setReviewIndex((i) => {
      const next = i + 1;
      if (next >= reviewQueue.length) setReviewOpen(false);
      return next;
    });
  }, [reviewQueue.length]);

  const handleReviewPick = useCallback(async (item: ReviewItem, chosenCode: string) => {
    try {
      await api.submitReviewDecision(item.id, { decision: 'override', reviewer_code: chosenCode });
    } catch {
      // Best-effort
    }
    setReviewedCount((n) => n + 1);
    setReviewIndex((i) => {
      const next = i + 1;
      if (next >= reviewQueue.length) setReviewOpen(false);
      return next;
    });
  }, [reviewQueue.length]);

  const handleReviewBlock = useCallback(async (item: ReviewItem, notes: string) => {
    try {
      await api.submitReviewDecision(item.id, { decision: 'block_from_submission', reviewer_notes: notes });
    } catch {
      // Best-effort
    }
    setReviewedCount((n) => n + 1);
    setReviewIndex((i) => {
      const next = i + 1;
      if (next >= reviewQueue.length) setReviewOpen(false);
      return next;
    });
  }, [reviewQueue.length]);

  if (!visible) return null;

  const handleDownloadFile = async (fileName: string) => {
    if (!state.runId) return;
    if (fileFetching[fileName]) return;
    setDownloadError(null);
    setFileFetching((prev) => ({ ...prev, [fileName]: true }));
    try {
      const blob = await api.getBatchFile(state.runId, fileName);
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = fileName.split('/').pop() ?? fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? `${err.status}: ${err.message}`
          : err instanceof Error
            ? err.message
            : 'Failed to download file.';
      setDownloadError(`${fileName} — ${msg}`);
    } finally {
      setFileFetching((prev) => {
        const next = { ...prev };
        delete next[fileName];
        return next;
      });
    }
  };

  const phase = describePhase({ phase: state.phase, summary });
  const pillKind: 'processing' | 'failed' | 'done' | null =
    isPolling
      ? 'processing'
      : state.phase === 'done' && summary?.status === 'failed'
        ? 'failed'
        : state.phase === 'done' && summary?.status === 'completed'
          ? 'done'
          : null;

  // Row count for subtitle — use summary.row_count when available, else derive
  const rowCount = summary?.row_count ?? items.length;

  return (
    <>
      {/* No card border/shadow — results sit flat on the page background,
          matching the prototype exactly. */}
      <div
        className={cn(
          'animate-[fadeUp_0.35s_ease_both]',
          className,
        )}
      >
        {/* ----------------------------------------------------------------
            Panel header — matches prototype: big title + subtitle + buttons
        ---------------------------------------------------------------- */}
        <div className="relative pb-5">
          {/* Title row */}
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              {/* Big title — same as prototype "Classification results" */}
              <h2 className="m-0 text-[36px] leading-tight font-bold tracking-[-0.02em] text-[var(--ink)]">
                {t('batch_results_title')}
              </h2>

              {/* Subtitle */}
              {summary && (
                <p className="m-0 mt-1.5 text-[14px] text-[var(--ink-2)]">
                  {(summary as unknown as Record<string, unknown>).file_name != null && (
                    <>{String((summary as unknown as Record<string, unknown>).file_name)} · </>
                  )}
                  {rowCount} {rowCount === 1 ? 'item' : 'items'} · {t('batch_results_subtitle_suffix')}
                </p>
              )}
            </div>

            {/* Right rail — action buttons */}
            <div className="flex items-center gap-2.5 shrink-0 pt-1">
              {canReset && onReset && (
                <button
                  type="button"
                  onClick={onReset}
                  className={cn(
                    'inline-flex items-center gap-2 px-4 py-2 rounded-[10px]',
                    'border border-[var(--line)] bg-[var(--surface)]',
                    'text-[13.5px] font-medium text-[var(--ink-2)]',
                    'hover:border-[var(--ink-3)] hover:text-[var(--ink)]',
                    'transition-colors duration-150',
                  )}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="rtl:scale-x-[-1]">
                    <path d="M21 12a9 9 0 1 1-3-6.7" />
                    <path d="M21 4v5h-5" />
                  </svg>
                  {t('batch_action_new_upload')}
                </button>
              )}

              {/* Declaration bundle button */}
              {runDone && (() => {
                const xmlFiles = (downloadLinks?.files ?? []).filter((f) => f.name.endsWith('.xml'));
                const lvFiles = xmlFiles.filter((f) => f.name.startsWith('lv/'));
                const hvFiles = xmlFiles.filter((f) => f.name.startsWith('hv/'));
                const hasXml = lvFiles.length > 0 || hvFiles.length > 0;
                if (!hasXml) return null;
                return (
                  <button
                    type="button"
                    onClick={() => handleDownloadBundle(state.runId!, [...lvFiles, ...hvFiles])}
                    disabled={bundleDownloading}
                    className={cn(
                      'inline-flex items-center gap-2 px-4 py-2 rounded-[10px]',
                      'bg-[var(--accent)] text-white border border-[var(--accent)]',
                      'text-[13.5px] font-semibold',
                      'hover:brightness-110 active:brightness-95 transition-all duration-150',
                      'disabled:opacity-50 disabled:cursor-progress',
                    )}
                  >
                    {bundleDownloading ? (
                      <span className="w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" aria-hidden />
                    ) : (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" y1="15" x2="12" y2="3" />
                      </svg>
                    )}
                    {t('batch_action_declaration_bundle')}
                  </button>
                );
              })()}

              {isPolling && (
                <div className="w-[22px] h-[22px] rounded-full border-2 border-[var(--line)] border-t-[var(--accent)] animate-spin" aria-hidden />
              )}
            </div>
          </div>

          {/* ----------------------------------------------------------------
              Stat strip — flat, no card borders, prototype-exact.
              4 columns: Items · Succeeded · Flagged · Bayans
              Separated by thin vertical dividers, not box borders.
          ---------------------------------------------------------------- */}
          {summary && (
            <div className="mt-6 flex items-stretch divide-x divide-[var(--line-2)]">
              {/* Items */}
              <div className="pe-8 min-w-[120px]">
                <div className="text-[10px] font-semibold tracking-[0.10em] uppercase text-[var(--ink-3)] mb-1.5">
                  {t('batch_stat_items')}
                </div>
                <div className="text-[28px] font-bold tracking-[-0.02em] text-[var(--ink)] leading-none">
                  {summary.row_count
                    ? `${items.filter((i) => i.classification_result != null || i.error).length}/${summary.row_count}`
                    : rowCount}
                </div>
                <div className={cn('text-[12px] mt-1.5', isPolling ? 'text-[var(--accent-ink)]' : 'text-[var(--ink-3)]')}>
                  {isPolling && summary.row_count
                    ? t('batch_stat_items_sub_partial').replace(
                        '{pct}',
                        Math.round(
                          (items.filter((i) => i.classification_result != null || i.error).length /
                            summary.row_count) * 100,
                        ).toString(),
                      )
                    : t('batch_stat_items_sub')}
                </div>
              </div>

              {/* Succeeded */}
              <div className="px-8 min-w-[120px]">
                <div className="text-[10px] font-semibold tracking-[0.10em] uppercase text-[var(--ink-3)] mb-1.5">
                  {t('batch_stat_succeeded')}
                </div>
                <div className="text-[28px] font-bold tracking-[-0.02em] text-[oklch(0.42_0.15_140)] leading-none">
                  {classifiedWithCode}
                </div>
                <div className="text-[12px] text-[var(--ink-3)] mt-1.5">
                  {t('batch_stat_succeeded_sub')}
                </div>
              </div>

              {/* Flagged */}
              <div className="px-8 min-w-[120px]">
                <div className="text-[10px] font-semibold tracking-[0.10em] uppercase text-[var(--ink-3)] mb-1.5">
                  {t('batch_stat_flagged')}
                </div>
                <div className="text-[28px] font-bold tracking-[-0.02em] text-[oklch(0.50_0.16_60)] leading-none">
                  {flaggedCount}
                </div>
                <div className="text-[12px] text-[var(--ink-3)] mt-1.5">
                  {t('batch_stat_flagged_sub')}
                </div>
              </div>

              {/* Generated Bayans */}
              {(() => {
                const xmlFiles = (downloadLinks?.files ?? []).filter((f) => f.name.endsWith('.xml'));
                const lvCount = xmlFiles.filter((f) => f.name.startsWith('lv/')).length;
                const hvCount = xmlFiles.filter((f) => f.name.startsWith('hv/')).length;
                return (
                  <div className="ps-8 min-w-[140px]">
                    <div className="text-[10px] font-semibold tracking-[0.10em] uppercase text-[var(--ink-3)] mb-1.5">
                      {t('batch_stat_bayans')}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      {hvCount > 0 && (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-[oklch(0.93_0.05_30)] text-[oklch(0.40_0.13_30)] text-[14px] font-bold font-mono">
                          {hvCount} <span className="text-[12px] font-semibold">{t('batch_hv_label')}</span>
                        </span>
                      )}
                      {lvCount > 0 && (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-[oklch(0.93_0.06_140)] text-[oklch(0.35_0.12_140)] text-[14px] font-bold font-mono">
                          {lvCount} <span className="text-[12px] font-semibold">{t('batch_lv_label')}</span>
                        </span>
                      )}
                      {lvCount === 0 && hvCount === 0 && (
                        <span className="text-[24px] font-bold tracking-[-0.02em] text-[var(--ink-3)] leading-none">—</span>
                      )}
                    </div>
                    <div className="text-[12px] text-[var(--ink-3)] mt-1.5">
                      {t('batch_stat_bayans_sub')}
                    </div>
                  </div>
                );
              })()}
            </div>
          )}

          {/* Loading skeleton for stats while polling with no summary yet */}
          {!summary && isPolling && (
            <div className="mt-6 flex items-stretch divide-x divide-[var(--line-2)]">
              {[...Array(4)].map((_, i) => (
                <div key={i} className={cn('py-1', i === 0 ? 'pe-8' : i === 3 ? 'ps-8' : 'px-8')}>
                  <div className="h-[10px] w-16 bg-[var(--line-2)] rounded animate-pulse mb-3" />
                  <div className="h-[28px] w-12 bg-[var(--line-2)] rounded animate-pulse mb-2" />
                  <div className="h-[12px] w-20 bg-[var(--line-2)] rounded animate-pulse" />
                </div>
              ))}
            </div>
          )}

          {/* Thin separator between stat strip and review banner / table */}
          {summary && <div className="mt-6 border-t border-[var(--line-2)]" />}

          {/* ----------------------------------------------------------------
              Review queue banner — prototype-exact dark card with dot pattern.
              Visible when there are flagged items and the run is not actively
              polling (both polling and done states show it once flagged > 0).
          ---------------------------------------------------------------- */}
          {!isPolling && flaggedCount > 0 && (
            <ReviewQueueBanner
              flaggedCount={flaggedCount}
              lowConfCount={0}
              valueFlagCount={flaggedCount}
              loading={reviewLoading}
              loadError={reviewLoadError}
              onOpen={openResolveQueue}
            />
          )}

          {/* Error message */}
          {state.errorMessage && (
            <p className="text-[13px] text-[var(--accent-ink)] mt-3 m-0" role="alert">
              {state.errorMessage}
            </p>
          )}

          {/* Indeterminate progress strip */}
          {isPolling && (
            <div className="mt-4 h-[2px] bg-[var(--line-2)] overflow-hidden rounded-full" aria-hidden>
              <div
                className="h-full w-1/3 animate-[slide_1.4s_linear_infinite]"
                style={{ background: 'linear-gradient(90deg, transparent, var(--accent), transparent)' }}
              />
            </div>
          )}
        </div>

        {summary && summary.status === 'failed' && summary.succeeded === 0 && (
          <div
            className="px-[22px] py-3 border-b border-[var(--line-2)] bg-[oklch(0.95_0.07_25)] text-[13px] text-[oklch(0.32_0.12_25)]"
            role="alert"
          >
            <div className="font-medium mb-1">Run failed before any item completed.</div>
            <div className="text-[12.5px]">
              {summary.error ?? 'No items were classified. Check the run configuration and try again.'}
            </div>
          </div>
        )}

        <BatchResultsTable
          items={items}
          expectedRowCount={summary?.row_count}
          isComplete={state.phase === 'done' || state.phase === 'error'}
          batchId={state.runId ?? undefined}
        />

        {(() => {
          const runError = state.summary?.error ?? null;
          const itemErrors = items.filter((i) => !!i.error);
          const realErrors = itemErrors.filter((i) => {
            const e = i.error ?? '';
            return !e.includes('escalated to HITL') && !e.includes('LOW_INFORMATION');
          });
          if (!runError && realErrors.length === 0) return null;
          return (
            <div
              className="px-[22px] py-3 border-t border-[var(--line-2)] bg-[oklch(0.95_0.07_25)] text-[13px] text-[oklch(0.32_0.12_25)]"
              role="alert"
            >
              <div className="font-medium mb-1">Run-level error</div>
              <div className="text-[12.5px]">
                {humanError(runError ?? realErrors[0]?.error)}
              </div>
            </div>
          );
        })()}

        {downloadError && (
          <div className="px-[22px] py-2 text-[13px] text-[var(--accent-ink)] border-t border-[var(--line-2)]" role="alert">
            {downloadError}
          </div>
        )}
      </div>

      {/* Review queue dialog — rendered inside the fragment so it portals to body */}
      <ReviewDialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        item={reviewQueue[reviewIndex] ?? null}
        queueLength={reviewQueue.length}
        queueIndex={reviewIndex}
        reviewedCount={reviewedCount}
        onPrev={() => setReviewIndex((i) => Math.max(0, i - 1))}
        onNext={() => setReviewIndex((i) => Math.min(reviewQueue.length - 1, i + 1))}
        onSkip={() => setReviewIndex((i) => {
          const next = i + 1;
          if (next >= reviewQueue.length) setReviewOpen(false);
          return next;
        })}
        onAccept={handleReviewAccept}
        onDismiss={handleReviewDismiss}
        onPick={handleReviewPick}
        onBlock={handleReviewBlock}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// ReviewQueueBanner — prototype-exact dark card with repeating dot pattern
// ---------------------------------------------------------------------------

function ReviewQueueBanner({
  flaggedCount,
  lowConfCount,
  valueFlagCount,
  loading,
  loadError,
  onOpen,
}: {
  flaggedCount: number;
  lowConfCount: number;
  valueFlagCount: number;
  loading?: boolean;
  loadError?: string | null;
  onOpen?: () => void;
}) {
  const t = useT();

  return (
    <div
      className="mt-5 relative overflow-hidden rounded-[14px]"
      style={{ background: '#231915' }}
    >
      {/* Dot pattern overlay — matches prototype */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: `radial-gradient(circle, rgba(255,255,255,0.10) 1.5px, transparent 1.5px)`,
          backgroundSize: '18px 18px',
          backgroundPosition: '0 0',
        }}
      />

      {/* Content */}
      <div className="relative flex items-center gap-5 px-6 py-5">
        {/* Orange icon box */}
        <div
          className="shrink-0 w-[52px] h-[52px] rounded-[12px] flex items-center justify-center"
          style={{ background: 'var(--accent)' }}
        >
          {/* Document + checklist icon — matches prototype */}
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
            <rect x="4" y="2" width="12" height="16" rx="2" stroke="white" strokeWidth="1.8" fill="none"/>
            <path d="M8 7h6M8 10h4" stroke="white" strokeWidth="1.8" strokeLinecap="round"/>
            <path d="M14 17l2 2 4-4" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>

        {/* Text block */}
        <div className="flex-1 min-w-0">
          <div
            className="text-[11px] font-semibold tracking-[0.10em] uppercase mb-1"
            style={{ color: 'oklch(0.68 0.06 55)' }}
          >
            {t('batch_review_queue_label')} · {flaggedCount} {t('batch_stat_flagged')}
          </div>
          <div className="text-[17px] font-bold leading-snug text-white">
            {t('batch_review_queue_below_threshold')}
          </div>
          {(lowConfCount > 0 || valueFlagCount > 0) && (
            <div
              className="text-[13px] mt-1"
              style={{ color: 'oklch(0.68 0.06 55)' }}
            >
              {t('batch_review_queue_breakdown')
                .replace('{low_conf}', String(lowConfCount))
                .replace('{value_flag}', String(valueFlagCount))}
            </div>
          )}
        </div>

        {/* CTA button + error inline */}
        <div className="shrink-0 flex flex-col items-end gap-1.5">
          <button
            type="button"
            onClick={onOpen}
            disabled={loading}
            className={cn(
              'inline-flex items-center gap-2 px-5 py-3 rounded-[10px]',
              'text-[14px] font-semibold text-white',
              'transition-all duration-150 hover:brightness-110 active:brightness-95',
              'disabled:opacity-60 disabled:cursor-progress',
            )}
            style={{ background: 'var(--accent)' }}
          >
            {loading ? (
              <span className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" aria-hidden />
            ) : null}
            {t('batch_review_queue_cta')}
            {!loading && <span aria-hidden>→</span>}
          </button>
          {loadError && (
            <p className="text-[11px] text-[oklch(0.75_0.10_25)] m-0 max-w-[200px] text-end">
              {loadError}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
