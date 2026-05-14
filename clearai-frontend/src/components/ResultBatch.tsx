import { useEffect, useRef, useState } from 'react';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { api, ApiError, type DownloadLinks } from '@/lib/api';
import type { BatchState } from './ClassifyApp';
import BatchResultsTable from './BatchResultsTable';

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
  // Per-file in-flight state. Lets us disable + spinner the right row when
  // the user clicks one file while another is still streaming.
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
      const links = await api.getDeclarationRunDownloadLinks(runId);
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
      const blob = await api.getDeclarationRunFile(state.runId, fileName);
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
      <div className="relative px-[22px] py-[20px] border-b border-[var(--line-2)]">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            {/* Eyebrow crumb */}
            <div className="font-mono text-[11px] text-[var(--ink-3)] tracking-[0.12em] uppercase flex items-center gap-2">
              <span>Batch</span>
              <span className="text-[var(--line)]">·</span>
              <span>Run</span>
            </div>

            {/* Big title + muted phase suffix */}
            <h2 className="m-0 mt-2 text-[21px] leading-tight font-medium tracking-[-0.015em] text-[var(--ink)]">
              {phase.title}
              {phase.suffix && (
                <span className="text-[var(--ink-3)] font-normal ms-1.5">{phase.suffix}</span>
              )}
            </h2>

            {/* Run ID — copyable */}
            {state.runId && (
              <button
                type="button"
                className="mt-1.5 font-mono text-[13px] text-[var(--ink-2)] hover:text-[var(--ink)] transition-colors cursor-copy select-all text-start tracking-[0.005em]"
                title="Click to copy run ID"
                onClick={() => navigator.clipboard.writeText(state.runId!)}
              >
                {state.runId}
              </button>
            )}

            {/* Stats row */}
            {summary && (
              <div className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12.5px]">
                <Stat value={summary.row_count} label="rows" />
                <span className="text-[var(--line)]">·</span>
                <Stat value={summary.succeeded} label="succeeded" tone="ok" />
                <span className="text-[var(--line)]">·</span>
                <Stat value={summary.flagged} label="flagged" tone="warn" />
                <span className="text-[var(--line)]">·</span>
                <Stat value={(summary.blocked ?? 0) + (summary.failed ?? 0)} label="failed" tone="bad" />
                {summary.pending > 0 && (
                  <>
                    <span className="text-[var(--line)]">·</span>
                    <Stat value={summary.pending} label="pending" tone="pend" />
                  </>
                )}
              </div>
            )}

            {state.errorMessage && (
              <p className="text-[13px] text-[var(--accent-ink)] mt-2 m-0" role="alert">
                {state.errorMessage}
              </p>
            )}
          </div>

          {/*
            Right rail — status pill + spinner + (when terminal) the
            "Start a new batch" reset button. Placing the reset action
            here (instead of below the panel) means the user can pivot
            to a new run without scrolling past the entire result table.
            Only shown when the run has reached terminal so an in-flight
            run can't be accidentally binned.
          */}
          <div className="flex items-center gap-2 shrink-0">
            {pillKind && <StatusPill kind={pillKind} />}
            {isPolling && (
              <div
                className="w-[22px] h-[22px] rounded-full border-2 border-[var(--line)] border-t-[var(--accent)] animate-spin"
                aria-hidden
              />
            )}
            {canReset && onReset && (
              <button
                type="button"
                onClick={onReset}
                className={cn(
                  'inline-flex items-center gap-2 px-3.5 py-1.5 rounded-[10px]',
                  'border border-[var(--line)] bg-[var(--surface)]',
                  'text-[13px] text-[var(--ink-2)] hover:text-[var(--ink)] hover:border-[var(--ink-3)]',
                  'transition-colors duration-150',
                  'animate-[fadeUp_0.35s_ease_both]',
                )}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                  className="rtl:scale-x-[-1]"
                >
                  <path d="M21 12a9 9 0 1 1-3-6.7" />
                  <path d="M21 4v5h-5" />
                </svg>
                {t('batch_start_new')}
              </button>
            )}
          </div>
        </div>

        {/*
          Indeterminate progress strip — only while polling. A narrow
          accent gradient slides across a neutral track at the bottom edge
          of the header, giving the panel a continuous "this is live" cue
          even when the row counts haven't ticked.
        */}
        {isPolling && (
          <div
            className="absolute inset-x-0 bottom-0 h-[2px] bg-[var(--line-2)] overflow-hidden"
            aria-hidden
          >
            <div
              className="h-full w-1/3 animate-[slide_1.4s_linear_infinite]"
              style={{
                background:
                  'linear-gradient(90deg, transparent, var(--accent), transparent)',
              }}
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
      />

      {(() => {
        const runError = state.summary?.error ?? null;
        const itemErrors = items.filter((i) => !!i.error);
        const escalations = itemErrors.filter((i) => {
          const e = i.error ?? '';
          return e.includes('escalated to HITL') || e.includes('LOW_INFORMATION');
        });
        const realErrors = itemErrors.filter((i) => !escalations.includes(i));

        if (!runError && itemErrors.length === 0) return null;

        // Real run-level crash or per-item exception — red banner.
        if (runError || realErrors.length > 0) {
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
        }

        // Only HITL escalations — informational amber banner.
        return (
          <div
            className="px-[22px] py-3 border-t border-[var(--line-2)] bg-[oklch(0.95_0.08_75)] text-[13px] text-[oklch(0.36_0.13_75)]"
            role="status"
          >
            <div className="font-medium mb-1">
              {escalations.length === 1
                ? '1 item needs manual review'
                : `${escalations.length} items need manual review`}
            </div>
            <div className="text-[12.5px]">
              Sent to the HITL queue — open the review tab to resolve.
            </div>
          </div>
        );
      })()}

      {/*
        Footer strip: latency on the left, optional file-list status
        on the right. The "Refresh file list" button is gone — the
        list now auto-fetches the moment the run reaches a terminal
        state with at least one usable item (see useEffect above).
      */}
      <div className="flex items-center justify-between gap-3 px-[22px] py-3.5 border-t border-[var(--line-2)] bg-[var(--line-2)]">
        <div className="text-[12.5px] text-[var(--ink-3)]">
          {summary?.completed_at && summary.started_at && (
            <>
              <b className="text-[var(--ink-2)] font-medium">{t('meta_latency')}</b>{' '}
              {Math.round(
                (new Date(summary.completed_at).getTime() -
                  new Date(summary.started_at).getTime()) /
                  1000,
              )}
              s
            </>
          )}
        </div>
        {downloadLoading && (
          <div className="flex items-center gap-2 text-[12.5px] text-[var(--ink-3)]">
            <span
              className="w-3 h-3 rounded-full border-2 border-[var(--line)] border-t-[var(--accent)] animate-spin"
              aria-hidden
            />
            <span>Preparing files…</span>
          </div>
        )}
      </div>

      {downloadError && (
        <div className="px-[22px] py-2 text-[13px] text-[var(--accent-ink)] border-t border-[var(--line-2)]" role="alert">
          {downloadError}
        </div>
      )}

      {downloadLinks && (
        <div className="px-[22px] py-3 border-t border-[var(--line-2)]">
          <ul className="m-0 p-0 list-none flex flex-col gap-1">
            {downloadLinks.files
              // Hide the internal JSON artefacts (run-index.json,
              // classifications.json) from the operator-facing file
              // list. They're useful for debugging via direct GET but
              // not for the broker downloading invoice declarations.
              .filter((f) => {
                const base = f.name.split('/').pop() ?? f.name;
                return base !== 'run-index.json' && base !== 'classifications.json';
              })
              .map((f) => {
              const fetching = !!fileFetching[f.name];
              return (
                <li key={f.name} className="flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => handleDownloadFile(f.name)}
                    disabled={fetching}
                    className="text-[13px] font-mono text-[var(--accent-ink)] hover:underline truncate disabled:opacity-60 disabled:cursor-progress text-left"
                  >
                    {fetching ? 'Downloading…' : f.name}
                  </button>
                  {f.size_bytes !== null && (
                    <span className="text-[11.5px] text-[var(--ink-3)] font-mono whitespace-nowrap">
                      {(f.size_bytes / 1024).toFixed(1)} KB
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>

    </>
  );
}
