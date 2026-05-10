import { useState } from 'react';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { api, ApiError, type DownloadLinks } from '@/lib/api';
import type { BatchState } from './ClassifyApp';
import BatchResultsTable from './BatchResultsTable';

function humanError(raw: string | null | undefined): string {
  if (!raw) return '';
  if (raw.includes('escalated to HITL')) return 'Sent to manual review (HITL queue)';
  return raw;
}

interface ResultBatchProps {
  visible: boolean;
  state: BatchState;
  className?: string;
}

export default function ResultBatch({ visible, state, className }: ResultBatchProps) {
  const t = useT();
  const [downloadLinks, setDownloadLinks] = useState<DownloadLinks | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadLoading, setDownloadLoading] = useState(false);
  // Per-file in-flight state. Lets us disable + spinner the right row when
  // the user clicks one file while another is still streaming.
  const [fileFetching, setFileFetching] = useState<Record<string, boolean>>({});

  if (!visible) return null;

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
  const downloadIsPartial = state.summary?.status === 'failed' && partialOutput;

  const handleDownload = async () => {
    if (!state.runId) return;
    setDownloadError(null);
    setDownloadLoading(true);
    try {
      const links = await api.getDeclarationRunDownloadLinks(state.runId);
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
        <div className="flex gap-2">
          <button
            type="button"
            disabled={!runDone || downloadLoading}
            onClick={handleDownload}
            className={cn(
              'inline-flex items-center gap-1.5 px-4 py-2 rounded-full border-0',
              'bg-[var(--accent)] text-white text-[13px] font-medium',
              'shadow-[0_4px_10px_-3px_rgba(233,123,58,0.4)]',
              'hover:bg-[var(--accent-ink)] transition-colors duration-150',
              'disabled:opacity-50 disabled:pointer-events-none',
            )}
          >
            {downloadLoading
              ? 'Loading…'
              : downloadLinks
                ? 'Refresh file list'
                : downloadIsPartial
                  ? 'Download partial bundle'
                  : t('act_xml_batch')}
          </button>
        </div>
      </div>

      {downloadError && (
        <div className="px-[22px] py-2 text-[13px] text-[var(--accent-ink)] border-t border-[var(--line-2)]" role="alert">
          {downloadError}
        </div>
      )}

      {downloadLinks && (
        <div className="px-[22px] py-3 border-t border-[var(--line-2)]">
          <ul className="m-0 p-0 list-none flex flex-col gap-1">
            {downloadLinks.files.map((f) => {
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
                  {f.sizeBytes !== null && (
                    <span className="text-[11.5px] text-[var(--ink-3)] font-mono whitespace-nowrap">
                      {(f.sizeBytes / 1024).toFixed(1)} KB
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
