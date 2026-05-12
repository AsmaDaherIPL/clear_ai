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
  const runFinished =
    state.summary?.status === 'completed' || state.summary?.status === 'failed';
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

  const phaseLabel = (() => {
    switch (state.phase) {
      case 'uploading': return 'Uploading…';
      case 'polling': return summary
        ? `Processing — ${summary.status} (Phase 1: ${summary.classification_status})`
        : 'Processing…';
      case 'done': return summary?.status === 'completed' ? 'Completed' : `Run ${summary?.status ?? 'finished'}`;
      case 'error': return 'Error';
      default: return 'Idle';
    }
  })();

  return (
    <>
    <div
      className={cn(
        'bg-[var(--surface)] border border-[var(--line)] rounded-[var(--radius-lg)] overflow-hidden',
        'animate-[fadeUp_0.35s_ease_both]',
        className,
      )}
    >
      <div className="px-[22px] py-[18px] flex items-start justify-between gap-4 border-b border-[var(--line-2)]">
        <div>
          <div className="font-mono text-[11px] text-[var(--ink-3)] tracking-[0.06em] uppercase mb-1.5">
            {t('res_batch')}
          </div>
          <p className="text-[14px] text-[var(--ink)] m-0">
            {phaseLabel}
          </p>
          {state.runId && (
            <button
              type="button"
              className="mt-1 font-mono text-[11px] text-[var(--ink-3)] hover:text-[var(--ink-2)] transition-colors cursor-copy select-all text-start"
              title="Click to copy run ID"
              onClick={() => navigator.clipboard.writeText(state.runId!)}
            >
              {state.runId}
            </button>
          )}
          {summary && (
            <p className="text-[12.5px] text-[var(--ink-3)] mt-1 m-0">
              {summary.row_count} rows ·{' '}
              <span className="text-[oklch(0.40_0.10_140)]">{summary.succeeded} succeeded</span> ·{' '}
              <span className="text-[oklch(0.45_0.15_60)]">{summary.flagged} flagged</span> ·{' '}
              <span className="text-[oklch(0.45_0.12_25)]">{summary.blocked + summary.failed} failed</span>
              {summary.pending > 0 && <> · {summary.pending} pending</>}
            </p>
          )}
          {state.errorMessage && (
            <p className="text-[13px] text-[var(--accent-ink)] mt-2 m-0" role="alert">
              {state.errorMessage}
            </p>
          )}
        </div>
        {isPolling && (
          <div
            className="w-4 h-4 mt-1 rounded-full border-2 border-[var(--line)] border-t-[var(--accent)] animate-spin"
            aria-hidden
          />
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

      {/*
        Run-level error banner. Surfaces a single message below the
        table when EITHER the run carries a top-level error, OR any
        item carries an error. Per spec: per-row Error column is gone.
      */}
      {(state.summary?.error || items.some((i) => i.error)) && (
        <div
          className="px-[22px] py-3 border-t border-[var(--line-2)] bg-[oklch(0.95_0.07_25)] text-[13px] text-[oklch(0.32_0.12_25)]"
          role="alert"
        >
          <div className="font-medium mb-1">Run-level error</div>
          <div className="text-[12.5px]">
            {humanError(state.summary?.error ?? items.find((i) => i.error)?.error)}
          </div>
        </div>
      )}

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

    {/*
      "Start a new batch" reset button. Mirrors the Batch.html mockup:
      a centred secondary pill below the panel, only shown once the run
      has reached a terminal state so the operator can't accidentally
      bin an in-flight run. Clicking it triggers onReset on the parent,
      which clears batchState and un-collapses the composer above.
    */}
    {runFinished && onReset && (
      <div className="flex justify-center mt-[18px] animate-[fadeUp_0.35s_ease_both]">
        <button
          type="button"
          onClick={onReset}
          className={cn(
            'inline-flex items-center gap-2 px-4 py-2 rounded-[10px]',
            'border border-[var(--line)] bg-[var(--surface)]',
            'text-[13px] text-[var(--ink-2)] hover:text-[var(--ink)] hover:border-[var(--ink-3)]',
            'transition-colors duration-150',
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
          >
            <path d="M21 12a9 9 0 1 1-3-6.7" />
            <path d="M21 4v5h-5" />
          </svg>
          {t('batch_start_new')}
        </button>
      </div>
    )}
    </>
  );
}
