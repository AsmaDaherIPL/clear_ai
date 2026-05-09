import { useState } from 'react';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { api, ApiError, type DownloadLinks } from '@/lib/api';
import type { BatchState } from './ClassifyApp';

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

const STATUS_BADGE: Record<string, string> = {
  pending: 'bg-[var(--line-2)] text-[var(--ink-3)]',
  classifying: 'bg-[var(--line-2)] text-[var(--ink-3)]',
  succeeded: 'bg-[oklch(0.92_0.06_140)] text-[oklch(0.35_0.10_140)]',
  flagged: 'bg-[oklch(0.93_0.10_60)] text-[oklch(0.40_0.15_60)]',
  blocked: 'bg-[oklch(0.92_0.07_25)] text-[oklch(0.40_0.12_25)]',
  failed: 'bg-[oklch(0.92_0.07_25)] text-[oklch(0.40_0.12_25)]',
};

export default function ResultBatch({ visible, state, className }: ResultBatchProps) {
  const t = useT();
  const [downloadLinks, setDownloadLinks] = useState<DownloadLinks | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadLoading, setDownloadLoading] = useState(false);

  if (!visible) return null;

  const summary = state.summary;
  const items = state.items;
  const isPolling = state.phase === 'uploading' || state.phase === 'polling';
  const runDone = state.summary?.status === 'completed';

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

      <div className="max-h-[480px] overflow-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="sticky top-0 bg-[var(--line-2)]">
              {[
                { key: 'line', label: 'Line' },
                { key: 'path_en', label: 'Description (EN)' },
                { key: 'code', label: 'HS code' },
                { key: 'submission_ar', label: 'Submission (AR)' },
                { key: 'status', label: 'Status' },
                { key: 'error', label: 'Error' },
              ].map((c) => (
                <th
                  key={c.key}
                  className="text-start px-3.5 py-3 border-b border-[var(--line-2)] font-mono text-[11px] font-medium text-[var(--ink-3)] tracking-[0.06em] uppercase"
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3.5 py-6 text-[13px] text-[var(--ink-3)] italic text-center">
                  {isPolling
                    ? 'Items will appear once Phase 1 (classification) completes.'
                    : summary?.status === 'failed' && summary.succeeded === 0
                      ? 'No items processed.'
                      : 'No items.'}
                </td>
              </tr>
            ) : (
              items.map((item) => (
                <tr key={item.id} className="border-b border-[var(--line-2)]">
                  <td className="px-3.5 py-2.5 font-mono text-[12px] text-[var(--ink-2)] align-top">
                    {item.row_index}
                  </td>
                  <td className="px-3.5 py-2.5 text-[13px] text-[var(--ink-2)] max-w-[320px] align-top break-words">
                    {item.catalog_path_en ?? '—'}
                  </td>
                  <td className="px-3.5 py-2.5 font-mono text-[12.5px] text-[var(--ink-2)] align-top whitespace-nowrap">
                    {item.final_code ?? '—'}
                  </td>
                  <td
                    className="px-3.5 py-2.5 text-[13px] text-[var(--ink-2)] max-w-[260px] align-top break-words"
                    dir="rtl"
                  >
                    {item.submission_description_ar ?? '—'}
                  </td>
                  <td className="px-3.5 py-2.5 text-[12px] align-top">
                    <span
                      className={cn(
                        'inline-block px-2 py-0.5 rounded-full font-mono uppercase tracking-[0.04em]',
                        STATUS_BADGE[item.status] ?? STATUS_BADGE.pending,
                      )}
                    >
                      {item.status}
                    </span>
                  </td>
                  <td className="px-3.5 py-2.5 text-[12px] text-[var(--accent-ink)] max-w-[280px] align-top break-words">
                    {humanError(item.error)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

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
            {downloadLoading ? 'Loading…' : downloadLinks ? 'Refresh links' : t('act_xml_batch')}
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
          <p className="text-[12px] text-[var(--ink-3)] m-0 mb-2">
            Links expire at {new Date(downloadLinks.expiresAt).toLocaleTimeString()}.
          </p>
          <ul className="m-0 p-0 list-none flex flex-col gap-1">
            {downloadLinks.files.map((f) => (
              <li key={f.name} className="flex items-center justify-between gap-3">
                <a
                  href={f.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[13px] font-mono text-[var(--accent-ink)] hover:underline truncate"
                >
                  {f.name}
                </a>
                {f.sizeBytes !== null && (
                  <span className="text-[11.5px] text-[var(--ink-3)] font-mono whitespace-nowrap">
                    {(f.sizeBytes / 1024).toFixed(1)} KB
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
