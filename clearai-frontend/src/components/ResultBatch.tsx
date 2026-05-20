import { useEffect, useRef, useState } from 'react';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { api, ApiError, type BatchFile, type DownloadLinks } from '@/lib/api';
import type { BatchState } from './ClassifyApp';
import BatchResultsTable from './BatchResultsTable';
import { zipSync, strToU8 } from 'fflate';

function humanError(raw: string | null | undefined): string {
  if (!raw) return '';
  if (raw.includes('LOW_INFORMATION')) return 'Description too vague to classify — sent to manual review (HITL queue)';
  if (raw.includes('escalated to HITL')) return 'Sent to manual review (HITL queue)';
  return raw;
}

/**
 * Render the title's phase suffix in plain English.
 * "Processing" → "Processing — phase 1: classifying lines"
 * "Run failed" → "Run failed — stopped at declaration phase"
 * Falls back to a blank suffix when the phase is just "completed" / "idle".
 */
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

/**
 * Status pill — animated dot + uppercase label. Three states:
 *   processing : orange dot, blink animation (run is live)
 *   failed     : red dot, static
 *   done       : green dot, static
 */
function StatusPill({ kind }: { kind: 'processing' | 'failed' | 'done' }) {
  const styles = {
    processing: 'bg-[oklch(0.96_0.025_55)] text-[var(--accent-ink)]',
    failed:     'bg-[oklch(0.92_0.07_25)] text-[oklch(0.40_0.12_25)]',
    done:       'bg-[oklch(0.92_0.06_140)] text-[oklch(0.30_0.10_140)]',
  } as const;
  const dot = {
    processing: 'bg-[var(--accent)] animate-[blink_1.4s_ease-in-out_infinite]',
    failed:     'bg-[oklch(0.55_0.18_25)]',
    done:       'bg-[oklch(0.45_0.15_140)]',
  } as const;
  const label = { processing: 'Processing', failed: 'Failed', done: 'Done' } as const;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5',
        'font-mono text-[10.5px] tracking-[0.12em] uppercase',
        'px-2.5 py-[5px] rounded-full',
        styles[kind],
      )}
    >
      <span className={cn('w-1.5 h-1.5 rounded-full', dot[kind])} aria-hidden />
      {label[kind]}
    </span>
  );
}

/**
 * Colored stat used in the panel header counts row.
 * Renders as `<value> <label>` with a tabular-nums monospace value.
 */
function Stat({
  value,
  label,
  tone,
}: {
  value: number;
  label: string;
  tone?: 'ok' | 'warn' | 'bad' | 'pend';
}) {
  const toneCls = {
    ok:   'text-[oklch(0.45_0.15_140)]',
    warn: 'text-[oklch(0.50_0.16_60)]',
    bad:  'text-[oklch(0.50_0.18_25)]',
    pend: 'text-[var(--accent-ink)]',
  } as const;
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className={cn('font-mono tabular-nums font-medium', tone ? toneCls[tone] : 'text-[var(--ink-2)]')}>
        {value}
      </span>
      <span className="text-[var(--ink-3)]">{label}</span>
    </span>
  );
}

interface ResultBatchProps {
  visible: boolean;
  state: BatchState;
  /**
   * Reset the batch flow back to the upload screen. Wired up by the
   * "Start a new batch" button below the panel; only rendered once
   * the run reaches a terminal state (success OR failure) so the user
   * can't accidentally bin an in-flight run.
   */
  onReset?: () => void;
  className?: string;
}

export default function ResultBatch({ visible, state, onReset, className }: ResultBatchProps) {
  const t = useT();
  const [downloadLinks, setDownloadLinks] = useState<DownloadLinks | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadLoading, setDownloadLoading] = useState(false);
  const [bundleDownloading, setBundleDownloading] = useState(false);
  // Per-file in-flight state (kept for internal use; no longer a visible list).
  const [fileFetching, setFileFetching] = useState<Record<string, boolean>>({});
  // Guards against re-fetching the file list every render once it's
  // already been auto-loaded for the current run. We key on runId so a
  // brand-new run resets the latch.
  const autoFetchedRunRef = useRef<string | null>(null);

  // Derived state — computed before any early return so the effect
  // hook below can depend on them without violating React's rules of
  // hooks (useEffect must run unconditionally on every render).
  const summary = state.summary;
  const items = state.items;
  const isPolling = state.phase === 'uploading' || state.phase === 'polling';
  // v3.1: relaxed gate. Allow download when the run has finished one
  // way or another AND any items succeeded — gives the operator
  // partial output even if Phase 2 (declaration assembly) failed. The
  // download endpoint already returns whatever blobs exist. Keep
  // disabled only when the run failed AND nothing useful landed.
  // canReset gates the "Start a new batch" off-ramp. Shown in any terminal
  // user-perceived state: the run finished normally (completed/failed via
  // the polling path), OR the phase reached the error state (upload itself
  // failed, polling tripped a 5xx, etc.). Without the error branch the user
  // could land on "Upload failed" with no way to dismiss and try again.
  const runFinished =
    state.summary?.status === 'completed' || state.summary?.status === 'failed';
  const canReset = runFinished || state.phase === 'error';
  const partialOutput =
    (state.summary?.succeeded ?? 0) + (state.summary?.flagged ?? 0) > 0;
  const runDone = runFinished && partialOutput;

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

  /**
   * Download all lv/*.xml and hv/*.xml for the run in parallel, pack
   * them into a zip with two top-level folders, and save as
   * "declaration-bundle-<runId>.zip". Uses fflate (sync zip) to avoid
   * a streaming dependency.
   */
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
      // Build the fflate zip input: { 'lv/foo.xml': Uint8Array, ... }
      const zipInput: Record<string, Uint8Array> = {};
      for (const r of results) {
        zipInput[r.name] = r.data;
      }
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

  // Reset all per-run local state the moment we see a new runId (or
  // the run gets cleared back to null). Without this, the previous
  // run's `downloadLinks` survives in component state across runs —
  // when the next run starts, the file list from run #1 stays on screen,
  // and clicking a file fires `getDeclarationRunFile(state.runId, fileName)`
  // where state.runId is run #2 but fileName comes from run #1's listing.
  // Backend returns 404 "declaration_run not found" or "file not found"
  // depending on path shape. Surfaces as the "lv/<uuid>.xml — 404"
  // error banner observed in the field.
  useEffect(() => {
    setDownloadLinks(null);
    setDownloadError(null);
    setFileFetching({});
    autoFetchedRunRef.current = null;
  }, [state.runId]);

  // Auto-fetch the file list once the run reaches a terminal state and
  // there's at least one item to download. Replaces the old "Refresh
  // file list" button — operators expected the list to just appear when
  // processing finished, not have to click again.
  useEffect(() => {
    if (!state.runId || !runDone) return;
    if (autoFetchedRunRef.current === state.runId) return;
    autoFetchedRunRef.current = state.runId;
    void fetchDownloadLinks(state.runId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.runId, runDone]);

  if (!visible) return null;

  // Click handler for an individual file row. Fetches the bytes via the
  // backend stream route (Bearer-authed, no SAS expiry) and triggers a
  // save dialog. Replaces the old <a href={sasUrl}> pattern that broke
  // the moment a SAS URL crossed its 5-minute expiry — the backend stream
  // works no matter how long the user takes to click.
  const handleDownloadFile = async (fileName: string) => {
    if (!state.runId) return;
    if (fileFetching[fileName]) return;
    setDownloadError(null);
    setFileFetching((prev) => ({ ...prev, [fileName]: true }));
    try {
      const blob = await api.getBatchFile(state.runId, fileName);
      // Object URL → anchor click → revoke. Standard "save as" trick that
      // works without prompting in all major browsers.
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      // Strip path components from the suggested file name — the browser
      // sometimes interprets a/b/c.xml as nested directories. The backend
      // stream sets Content-Disposition with the basename already; this
      // is belt-and-braces for browsers that don't honour it.
      a.download = fileName.split('/').pop() ?? fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Browsers need a tick before they finish reading the URL.
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

  return (
    <>
    <div
      className={cn(
        'bg-[var(--surface)] border border-[var(--line)] rounded-[var(--radius-lg)] overflow-hidden',
        'shadow-[0_1px_2px_rgba(20,15,5,0.04),0_8px_24px_-16px_rgba(20,15,5,0.12)]',
        'animate-[fadeUp_0.35s_ease_both]',
        className,
      )}
    >
      {/*
        Panel header — the "what's happening" hero of the batch view.
        Layout: eyebrow breadcrumb · big title with muted phase suffix ·
        copyable run id · stats row · status pill + spinner on the right.
        While polling, an indeterminate progress strip slides across the
        bottom edge of the header so the user always sees motion.
      */}
      {/* ---- Panel header — prototype design ---- */}
      <div className="relative px-6 pt-6 pb-5 border-b border-[var(--line-2)]">
        {/* Eyebrow + title row */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            {/* Eyebrow crumb */}
            <div className="text-[11px] font-semibold tracking-[0.08em] text-[var(--accent-ink)] uppercase mb-2">
              {state.runId
                ? `${t('batch_results_eyebrow_prefix')} #${state.runId.slice(0, 10).toUpperCase()} · ${phase.title.toUpperCase()}`
                : phase.title.toUpperCase()
              }
            </div>

            {/* Big title */}
            <h2 className="m-0 text-[30px] leading-tight font-bold tracking-[-0.02em] text-[var(--ink)]">
              {t('batch_results_title')}
            </h2>

            {/* Subtitle — filename + item count + hint */}
            {summary && (
              <p className="m-0 mt-1.5 text-[14px] text-[var(--ink-2)]">
                {(summary as any).file_name && <>{(summary as any).file_name} · </>}
                {summary.row_count} {summary.row_count === 1 ? 'item' : 'items'} · {t('batch_results_subtitle_suffix')}
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
            {/* Declaration bundle button — only when download ready */}
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

        {/* Stat cards row — 5 cards matching prototype */}
        {summary && (
          <div className="mt-5 grid grid-cols-5 gap-3">
            {/* Items */}
            <div className="rounded-[10px] border border-[var(--line)] bg-[var(--surface)] px-4 py-3">
              <div className="text-[10px] font-semibold tracking-[0.10em] uppercase text-[var(--ink-3)] mb-1">{t('batch_stat_items')}</div>
              <div className="text-[26px] font-bold tracking-[-0.02em] text-[var(--ink)] leading-none">
                {summary.row_count ? `${items.filter(i => i.classification_result != null || i.error).length}/${summary.row_count}` : summary.row_count}
              </div>
              <div className={cn('text-[12px] mt-1', isPolling ? 'text-[var(--accent-ink)]' : 'text-[var(--ink-3)]')}>
                {isPolling && summary.row_count
                  ? t('batch_stat_items_sub_partial').replace('{pct}', Math.round((items.filter(i => i.classification_result != null || i.error).length / summary.row_count) * 100).toString())
                  : t('batch_stat_items_sub')}
              </div>
            </div>

            {/* Succeeded */}
            <div className="rounded-[10px] border border-[var(--line)] bg-[var(--surface)] px-4 py-3">
              <div className="text-[10px] font-semibold tracking-[0.10em] uppercase text-[var(--ink-3)] mb-1">{t('batch_stat_succeeded')}</div>
              <div className="text-[26px] font-bold tracking-[-0.02em] text-[oklch(0.42_0.15_140)] leading-none">{summary.succeeded ?? 0}</div>
              <div className="text-[12px] text-[var(--ink-3)] mt-1">{t('batch_stat_succeeded_sub')}</div>
            </div>

            {/* Flagged */}
            <div className="rounded-[10px] border border-[var(--line)] bg-[var(--surface)] px-4 py-3">
              <div className="text-[10px] font-semibold tracking-[0.10em] uppercase text-[var(--ink-3)] mb-1">{t('batch_stat_flagged')}</div>
              <div className="text-[26px] font-bold tracking-[-0.02em] text-[oklch(0.50_0.16_60)] leading-none">{summary.flagged ?? 0}</div>
              <div className="text-[12px] text-[var(--ink-3)] mt-1">{t('batch_stat_flagged_sub')}</div>
            </div>

            {/* Est. Duty — derived from items */}
            {(() => {
              const totalDuty = items.reduce((sum, item) => {
                const ratePercent = item.duty_info?.rate_percent ?? null;
                const val = item.value?.amount?.value ?? null;
                if (ratePercent == null || val == null) return sum;
                return sum + val * (ratePercent / 100);
              }, 0);
              return (
                <div className="rounded-[10px] border border-[var(--line)] bg-[var(--surface)] px-4 py-3">
                  <div className="text-[10px] font-semibold tracking-[0.10em] uppercase text-[var(--ink-3)] mb-1">{t('batch_stat_duty')}</div>
                  <div className="text-[22px] font-bold tracking-[-0.02em] text-[var(--ink)] leading-none font-mono tabular-nums">
                    {totalDuty > 0
                      ? `${new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(totalDuty)} SAR`
                      : '—'}
                  </div>
                  <div className="text-[12px] text-[var(--ink-3)] mt-1">{t('batch_stat_duty_sub')}</div>
                </div>
              );
            })()}

            {/* Generated Bayans — from file listing */}
            {(() => {
              const xmlFiles = (downloadLinks?.files ?? []).filter((f) => f.name.endsWith('.xml'));
              const lvCount = xmlFiles.filter((f) => f.name.startsWith('lv/')).length;
              const hvCount = xmlFiles.filter((f) => f.name.startsWith('hv/')).length;
              return (
                <div className="rounded-[10px] border border-[var(--line)] bg-[var(--surface)] px-4 py-3">
                  <div className="text-[10px] font-semibold tracking-[0.10em] uppercase text-[var(--ink-3)] mb-1">{t('batch_stat_bayans')}</div>
                  <div className="flex items-center gap-2 mt-0.5">
                    {hvCount > 0 && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[oklch(0.93_0.05_30)] text-[oklch(0.40_0.13_30)] text-[13px] font-bold font-mono">
                        {hvCount} <span className="text-[11px] font-semibold">{t('batch_hv_label')}</span>
                      </span>
                    )}
                    {lvCount > 0 && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[oklch(0.93_0.06_140)] text-[oklch(0.35_0.12_140)] text-[13px] font-bold font-mono">
                        {lvCount} <span className="text-[11px] font-semibold">{t('batch_lv_label')}</span>
                      </span>
                    )}
                    {lvCount === 0 && hvCount === 0 && (
                      <span className="text-[22px] font-bold tracking-[-0.02em] text-[var(--ink-3)] leading-none">—</span>
                    )}
                  </div>
                  <div className="text-[12px] text-[var(--ink-3)] mt-1.5">{t('batch_stat_bayans_sub')}</div>
                </div>
              );
            })()}
          </div>
        )}

        {/* Loading skeleton for stats while polling with no summary yet */}
        {!summary && isPolling && (
          <div className="mt-5 grid grid-cols-5 gap-3">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="rounded-[10px] border border-[var(--line)] bg-[var(--surface)] px-4 py-3">
                <div className="h-[10px] w-16 bg-[var(--line-2)] rounded animate-pulse mb-3" />
                <div className="h-[26px] w-12 bg-[var(--line-2)] rounded animate-pulse mb-2" />
                <div className="h-[12px] w-20 bg-[var(--line-2)] rounded animate-pulse" />
              </div>
            ))}
          </div>
        )}

        {/* Review queue banner — dark card, only when there are flagged items and run is done */}
        {!isPolling && (summary?.flagged ?? 0) > 0 && (
          <div className="mt-5 flex items-center gap-4 px-5 py-4 rounded-[12px] bg-[#231915] text-white">
            <div className="w-10 h-10 rounded-[10px] bg-[var(--accent)] flex items-center justify-center shrink-0">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M9 9h6M9 13h4" />
                <path d="M16 16l2 2 4-4" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[10px] font-semibold tracking-[0.10em] uppercase text-[oklch(0.70_0.06_55)] mb-0.5">
                {t('batch_review_queue_label')} · {(summary?.flagged ?? 0)} {t('batch_stat_flagged')}
              </div>
              <div className="text-[16px] font-semibold leading-snug">
                {t('batch_review_queue_below_threshold')}
              </div>
            </div>
            <button
              type="button"
              className={cn(
                'shrink-0 inline-flex items-center gap-2 px-5 py-2.5 rounded-[10px]',
                'bg-[var(--accent)] text-white border-0',
                'text-[14px] font-semibold',
                'hover:brightness-110 transition-all duration-150',
              )}
            >
              {t('batch_review_queue_cta')} →
            </button>
          </div>
        )}

        {/* Error message */}
        {state.errorMessage && (
          <p className="text-[13px] text-[var(--accent-ink)] mt-3 m-0" role="alert">
            {state.errorMessage}
          </p>
        )}

        {/* Indeterminate progress strip — only while polling */}
        {isPolling && (
          <div className="absolute inset-x-0 bottom-0 h-[2px] bg-[var(--line-2)] overflow-hidden" aria-hidden>
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

      {/*
        Virtualized table — replaces the hand-rolled <table> block.
        Skeleton-row tail kicks in while items are still classifying:
        once `summary.row_count` is known (after the upload settles)
        we know how many lines to expect, so the table can show a
        same-shape skeleton row for every line not yet returned.
      */}
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

        // Real run-level crash or per-item non-HITL exception — red banner only.
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

    </>
  );
}
