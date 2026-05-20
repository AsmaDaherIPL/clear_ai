/**
 * ReviewQueue — paginated list of classification rows awaiting human review.
 *
 * URL: /review?batch_id=<uuid>
 * Reads `?batch_id=` on mount. Shows pending items only.
 * Clicking a row navigates to /review/{id}?batch_id={batch_id}.
 */

import { useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { api, ApiError } from '@/lib/api';
import type { ReviewQueueRow, ReviewReason } from '@/lib/api';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffSec = Math.floor(diffMs / 1_000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function reasonLabel(reason: ReviewReason, t: (k: Parameters<ReturnType<typeof useT>>[0]) => string): string {
  switch (reason) {
    case 'verdict_escalate':    return t('review_reason_verdict_escalate');
    case 'sanity_flag':         return t('review_reason_sanity_flag');
    case 'low_information':     return t('review_reason_low_information');
    case 'verifier_uncertain':  return t('review_reason_verifier_uncertain');
    default:                    return reason;
  }
}

function reasonBadgeClass(reason: ReviewReason): string {
  switch (reason) {
    case 'verdict_escalate':
      return 'bg-[oklch(0.93_0.07_25)] text-[oklch(0.38_0.14_25)]';
    case 'sanity_flag':
      return 'bg-[oklch(0.93_0.06_55)] text-[oklch(0.42_0.12_55)]';
    case 'low_information':
      return 'bg-[var(--line-2)] text-[var(--ink-3)]';
    case 'verifier_uncertain':
      return 'bg-[oklch(0.93_0.05_260)] text-[oklch(0.38_0.10_260)]';
    default:
      return 'bg-[var(--line-2)] text-[var(--ink-3)]';
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ReasonBadge({ reason, t }: { reason: ReviewReason; t: ReturnType<typeof useT> }) {
  return (
    <span
      className={cn(
        'inline-block font-mono text-[10.5px] tracking-[0.10em] uppercase px-2 py-[3px] rounded-full',
        reasonBadgeClass(reason),
      )}
    >
      {reasonLabel(reason, t)}
    </span>
  );
}

function SkeletonRow() {
  return (
    <tr className="border-b border-[var(--line-2)]">
      {[140, 80, 100, 60, 60].map((w, i) => (
        <td key={i} className="px-4 py-3">
          <span
            className="block h-3 rounded bg-[var(--line-2)] animate-pulse"
            style={{ width: w }}
          />
        </td>
      ))}
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function ReviewQueue() {
  const t = useT();

  const [batchId, setBatchId] = useState<string | null>(null);
  const [rows, setRows] = useState<ReviewQueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Read batch_id from URL on mount (client-side only).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const b = params.get('batch_id');
    setBatchId(b);
  }, []);

  // Fetch review queue once batchId state has settled.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .listReviewQueue({ batch_id: batchId ?? undefined, status: 'pending', limit: 50 })
      .then((data) => {
        if (!cancelled) {
          setRows(data.items);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const msg =
            err instanceof ApiError
              ? `${err.status}: ${err.message}`
              : err instanceof Error
                ? err.message
                : 'Failed to load review queue.';
          setError(msg);
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
    // batchId starts as null (not-yet-read) then switches to string|null once
    // the URL has been read. We want to re-fetch after that flip too.
  }, [batchId]);

  function navigateToDetail(rowId: string) {
    // Static-output Astro build: query-param routing (same pattern as /trace?id=).
    const params = new URLSearchParams({ id: rowId });
    if (batchId) params.set('batch_id', batchId);
    window.location.href = `/review/detail?${params.toString()}`;
  }

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <main className="max-w-[1080px] mx-auto px-6 py-10">
        {/* Page header */}
        <div className="mb-8 flex items-start justify-between gap-4 flex-wrap">
          <div>
            {batchId && (
              <a
                href={`/?run=${encodeURIComponent(batchId)}`}
                className={cn(
                  'inline-flex items-center gap-1.5 mb-3',
                  'font-mono text-[11px] tracking-[0.10em] uppercase',
                  'text-[var(--ink-3)] hover:text-[var(--ink-2)] transition-colors',
                )}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="rtl:scale-x-[-1]">
                  <path d="M19 12H5" />
                  <path d="M12 19l-7-7 7-7" />
                </svg>
                Back to batch
              </a>
            )}
            <h1 className="m-0 text-[26px] font-semibold tracking-[-0.02em] text-[var(--ink)]">
              {t('review_page_title')}
            </h1>
            {batchId && (
              <p className="mt-1.5 m-0 font-mono text-[12.5px] text-[var(--ink-3)] tracking-[0.005em]">
                {batchId}
              </p>
            )}
          </div>

          {!loading && !error && (
            <div className="flex items-center gap-2">
              <span className="font-mono text-[13px] text-[var(--ink-3)]">
                <span className="font-medium text-[var(--ink-2)]">{rows.length}</span>
                {' '}pending
              </span>
            </div>
          )}
        </div>

        {/* Error state */}
        {error && (
          <div
            className="px-5 py-4 rounded-[10px] bg-[oklch(0.95_0.07_25)] border border-[oklch(0.88_0.08_25)] text-[13px] text-[oklch(0.35_0.14_25)]"
            role="alert"
          >
            {error}
          </div>
        )}

        {/* Table */}
        {!error && (
          <div className="bg-[var(--surface)] border border-[var(--line)] rounded-[10px] overflow-hidden shadow-[0_1px_2px_rgba(20,15,5,0.04),0_8px_24px_-16px_rgba(20,15,5,0.10)]">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-[var(--line-2)] bg-[var(--line-2)]">
                  <th className="ps-5 pe-4 py-2.5 text-start font-mono text-[10.5px] tracking-[0.10em] uppercase text-[var(--ink-3)] font-normal">
                    {t('review_col_description')}
                  </th>
                  <th className="px-4 py-2.5 text-start font-mono text-[10.5px] tracking-[0.10em] uppercase text-[var(--ink-3)] font-normal">
                    {t('review_col_reason')}
                  </th>
                  <th className="px-4 py-2.5 text-start font-mono text-[10.5px] tracking-[0.10em] uppercase text-[var(--ink-3)] font-normal">
                    {t('review_col_code')}
                  </th>
                  <th className="px-4 py-2.5 text-start font-mono text-[10.5px] tracking-[0.10em] uppercase text-[var(--ink-3)] font-normal">
                    {t('review_col_confidence')}
                  </th>
                  <th className="pe-5 ps-4 py-2.5 text-start font-mono text-[10.5px] tracking-[0.10em] uppercase text-[var(--ink-3)] font-normal">
                    {t('review_col_age')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <>
                    <SkeletonRow />
                    <SkeletonRow />
                    <SkeletonRow />
                    <SkeletonRow />
                    <SkeletonRow />
                  </>
                )}

                {!loading && rows.length === 0 && (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-5 py-14 text-center text-[var(--ink-3)] text-[13px]"
                    >
                      {t('review_queue_empty')}
                    </td>
                  </tr>
                )}

                {!loading &&
                  rows.map((row) => {
                    const description =
                      typeof row.payload?.input === 'string'
                        ? row.payload.input
                        : row.item_id;
                    const conf = row.current_classification_confidence;
                    const confLabel =
                      conf != null ? `${Math.round(conf * 100)}%` : '—';
                    const code = row.current_final_code ?? '—';

                    return (
                      <tr
                        key={row.id}
                        onClick={() => navigateToDetail(row.id)}
                        className={cn(
                          'border-b border-[var(--line-2)] last:border-b-0',
                          'cursor-pointer transition-colors duration-100',
                          'hover:bg-[var(--line-2)]',
                        )}
                      >
                        {/* Description */}
                        <td className="ps-5 pe-4 py-3.5">
                          <span className="block max-w-[340px] truncate text-[var(--ink)] leading-snug">
                            {description}
                          </span>
                        </td>

                        {/* Reason badge */}
                        <td className="px-4 py-3.5">
                          <ReasonBadge reason={row.reason} t={t} />
                        </td>

                        {/* Current code */}
                        <td className="px-4 py-3.5">
                          <span
                            className={cn(
                              'font-mono text-[13.5px] tracking-[0.01em]',
                              code === '—' ? 'text-[var(--ink-3)]' : 'text-[var(--ink)]',
                            )}
                          >
                            {code}
                          </span>
                        </td>

                        {/* Confidence */}
                        <td className="px-4 py-3.5">
                          <span
                            className={cn(
                              'font-mono text-[13px]',
                              conf == null
                                ? 'text-[var(--ink-3)]'
                                : conf >= 0.75
                                  ? 'text-[oklch(0.42_0.13_140)]'
                                  : conf >= 0.5
                                    ? 'text-[oklch(0.50_0.14_60)]'
                                    : 'text-[oklch(0.50_0.18_25)]',
                            )}
                          >
                            {confLabel}
                          </span>
                        </td>

                        {/* Age */}
                        <td className="pe-5 ps-4 py-3.5">
                          <span className="font-mono text-[12.5px] text-[var(--ink-3)]">
                            {relativeTime(row.created_at)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
