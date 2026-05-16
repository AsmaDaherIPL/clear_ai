/**
 * Batch results — non-virtualized table using shadcn/ui primitives via
 * the generic <DataTable />.
 *
 * Column order (left → right):
 *   Line | Merchant code | Merchant description | Value | Classified code |
 *   Classified code breakdown | ZATCA declaration | Value plausibility verdict |
 *   Review (action column, flagged rows only)
 *
 * value_plausibility_verdict ships hidden by default; togglable from the
 * Columns menu in the footer.
 */
import { useMemo, useCallback } from 'react';
import { type ColumnDef } from '@tanstack/react-table';
import { useT, type TKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { pickLang, type DeclarationRunItem } from '@/lib/api';
import { DataTable } from './DataTable';

// ---------------------------------------------------------------------------
// Pill colour maps + helpers
// ---------------------------------------------------------------------------

const VERDICT_BADGE: Record<string, string> = {
  succeeded: 'bg-[oklch(0.92_0.06_140)] text-[oklch(0.30_0.10_140)]',
  flagged:   'bg-[oklch(0.93_0.10_60)]  text-[oklch(0.40_0.15_60)]',
  blocked:   'bg-[oklch(0.92_0.07_25)]  text-[oklch(0.40_0.12_25)]',
  failed:    'bg-[oklch(0.90_0.08_25)]  text-[oklch(0.35_0.14_25)]',
};

function clampChars(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

/**
 * Derive the filter/sort bucket for a row.
 *
 *   null      — item has not been processed yet (no error, no classification_result).
 *               Callers should treat null as "pending" and render a skeleton row.
 *   failed    — item was processed but errored OR produced no resolved_hs_code
 *               (HITL escalation, pipeline error, unclassifiable description)
 *   blocked   — sanity_verdict BLOCK (value implausible; code assigned but
 *               submission hard-stopped)
 *   flagged   — sanity_verdict FLAG (soft review flag; code assigned)
 *   succeeded — resolved_hs_code present and no FLAG/BLOCK
 *
 * IMPORTANT: returning null for unprocessed items prevents them from being
 * counted as "failed" in the filter chips during active polling.
 */
function itemBucket(
  item: DeclarationRunItem,
  isComplete = false,
): 'succeeded' | 'flagged' | 'blocked' | 'failed' | null {
  const hasError = Boolean(item.error);
  const hasClassificationResult = item.classification_result != null;

  // No error and no classification_result:
  //   - During active polling → null (pending, not yet processed)
  //   - On a completed run  → 'failed' (pipeline never produced a result)
  if (!hasError && !hasClassificationResult) return isComplete ? 'failed' : null;

  // Check sanity verdict BEFORE the no-code guard. BLOCK items may have
  // no resolved_hs_code (submission hard-stopped), but they are still
  // 'blocked', not 'failed'. Checking verdict first ensures the bucket
  // matches the backend's BatchItemStatus exactly.
  const sanity = item.classification_result?.sanity_verdict?.toUpperCase();
  if (sanity === 'BLOCK') return 'blocked';
  if (sanity === 'FLAG') return 'flagged';

  const hasCode = Boolean(item.classification_result?.resolved_hs_code);
  if (hasError || !hasCode) return 'failed';
  return 'succeeded';
}

// ---------------------------------------------------------------------------
// Code breakdown — Chapter / Heading / Subheading / Tariff rows
// ---------------------------------------------------------------------------

interface BuildBreakdownRow {
  code: string;
  label: string;
  description: string;
}

function buildBreakdown(finalCode: string | null, pathEn: string | null): BuildBreakdownRow[] {
  if (!finalCode || finalCode.length !== 12) return [];
  const segments = (pathEn ?? '').split(' > ').map((s) => s.trim()).filter(Boolean);
  return [
    { code: finalCode.slice(0, 2), label: 'Chapter',    description: segments[0] ?? '—' },
    { code: finalCode.slice(0, 4), label: 'Heading',    description: segments[1] ?? segments[0] ?? '—' },
    { code: finalCode.slice(0, 6), label: 'Subheading', description: segments[2] ?? segments[1] ?? '—' },
    { code: finalCode,             label: 'Tariff',     description: segments[segments.length - 1] ?? '—' },
  ];
}

const BREAKDOWN_DESC_MAX = 38;

/**
 * Code breakdown cell — four-row hierarchy, three inner columns:
 *   [code (mono tabular)]  [LEVEL (small caps)]  [description (truncated)]
 *
 * Tariff (last) row uses accent ink on the code + label so the eye lands
 * on the answer; upper rows are subdued context.
 */
function CodeBreakdownCell({ item }: { item: DeclarationRunItem }) {
  const resolved = item.classification_result?.resolved_hs_code ?? null;
  const pathEn = pickLang(item.resolved_hs_code_description?.full_hierarchy, 'en');
  const breakdown = useMemo(() => buildBreakdown(resolved, pathEn), [resolved, pathEn]);

  if (breakdown.length === 0) {
    return <span className="text-[var(--ink-3)] text-[12.5px]">—</span>;
  }

  return (
    <div
      className="grid gap-y-1 text-[13px] leading-[1.5]"
      style={{ gridTemplateColumns: 'auto 72px minmax(0, 1fr)' }}
    >
      {breakdown.map((b, i) => {
        const isTariff = i === breakdown.length - 1;
        return (
          <div key={i} className="contents">
            <div
              className={cn(
                'font-mono text-[11.5px] tabular-nums whitespace-nowrap pe-3',
                isTariff ? 'text-[var(--accent-ink)] font-medium' : 'text-[var(--ink)]',
              )}
            >
              {b.code}
            </div>
            <div
              className={cn(
                'font-mono text-[9.5px] uppercase tracking-[0.10em] self-center',
                isTariff ? 'text-[var(--accent-ink)]' : 'text-[var(--ink-3)]',
              )}
            >
              {b.label}
            </div>
            <div
              className={cn(
                'min-w-0 truncate',
                isTariff ? 'text-[var(--ink)]' : 'text-[var(--ink-2)]',
              )}
              title={b.description}
            >
              {clampChars(b.description, BREAKDOWN_DESC_MAX)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Simple cells
// ---------------------------------------------------------------------------

function MerchantCodeCell({ item }: { item: DeclarationRunItem }) {
  const merchantCode = item.declared_value?.hs_code ?? null;
  if (!merchantCode) {
    return <span className="text-[var(--ink-3)] text-[12.5px]">—</span>;
  }
  return (
    <span className="font-mono text-[12.5px] text-[var(--ink-3)] whitespace-nowrap">
      {merchantCode}
    </span>
  );
}

/**
 * Merchant description — verbatim declared_value.description, full text,
 * wraps freely. No truncation; the row grows to fit.
 */
function MerchantDescriptionCell({ item }: { item: DeclarationRunItem }) {
  const desc = item.declared_value?.description ?? null;
  if (!desc) return <span className="text-[var(--ink-3)] text-[12.5px]">—</span>;
  return (
    <div className="text-[13px] text-[var(--ink-2)] leading-[1.5] break-words whitespace-pre-wrap">
      {desc}
    </div>
  );
}

/**
 * Value cell — SAR-denominated amount + currency code from value.amount.
 * 2-decimal formatting with thousands separators; mono tabular for vertical
 * alignment across rows; muted small-caps currency.
 */
function ValueCell({ item }: { item: DeclarationRunItem }) {
  const amount = item.value?.amount?.value ?? null;
  const currency = item.value?.amount?.currency ?? null;
  if (amount === null || amount === undefined || !Number.isFinite(amount)) {
    return <span className="text-[var(--ink-3)] text-[12.5px]">—</span>;
  }
  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="font-mono text-[13px] tabular-nums text-[var(--ink)] whitespace-nowrap">
        {formatted}
      </span>
      {currency && (
        <span className="font-mono text-[10.5px] uppercase tracking-[0.10em] text-[var(--ink-3)]">
          {currency}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Manual review CTA button
// ---------------------------------------------------------------------------

function ManualReviewButton({
  pendingReview,
  reviewedCount,
  onClick,
}: {
  pendingReview: number;
  reviewedCount: number;
  onClick: () => void;
}) {
  const t = useT();
  const hasPending = pendingReview > 0;
  const isDisabled = pendingReview === 0 && reviewedCount === 0;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isDisabled}
      title={
        hasPending
          ? `${pendingReview} items need review`
          : 'All flagged items reviewed'
      }
      className={cn(
        'inline-flex items-center gap-[10px] px-[14px] py-[8px] rounded-[9px]',
        'border bg-[var(--surface)]',
        'text-[13.5px] font-medium tracking-[-0.005em]',
        'cursor-pointer transition-all duration-150',
        'disabled:opacity-40 disabled:cursor-not-allowed disabled:border-[var(--line)] disabled:text-[var(--ink-3)]',
        hasPending
          ? 'border-[var(--accent)] text-[var(--ink)] hover:bg-[var(--accent)] hover:text-white'
          : 'border-[var(--ink)] text-[var(--ink)] hover:bg-[var(--ink)] hover:text-white',
      )}
    >
      {t('review_manual_cta' as TKey)}
      <span
        className={cn(
          'inline-flex items-center justify-center min-w-[20px] h-[20px] px-[6px] rounded-full',
          'font-mono text-[11px] tabular-nums tracking-[0.02em]',
          'transition-all duration-150',
          hasPending
            ? 'bg-[var(--accent)] text-white'
            : 'bg-[var(--ink)] text-white',
        )}
      >
        {hasPending ? pendingReview : '✓'}
      </span>
      <span
        className={cn(
          'font-mono text-[12px] opacity-55 transition-transform duration-150',
          'group-hover:opacity-100 group-hover:translate-x-[2px]',
        )}
        aria-hidden
      >
        →
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface BatchResultsTableProps {
  expectedRowCount?: number;
  items: DeclarationRunItem[];
  className?: string;
  /**
   * True when the run has reached a terminal state (completed or failed).
   * Affects how unresolved items (no classification_result, no error) are
   * bucketed: pending during polling, failed once the run is complete.
   */
  isComplete?: boolean;
  /**
   * The batch/run ID. When present and the batch is complete, the "Needs
   * review" CTA navigates to /review?batch_id=<batchId>&status=pending
   * instead of opening an inline dialog.
   */
  batchId?: string;
}

/**
 * Derive whether a row needs operator review.
 * FLAG and BLOCK verdicts need review; PASS does not.
 * Items with no resolved code also need review regardless of verdict.
 */
function needsReview(item: DeclarationRunItem): boolean {
  // Unprocessed items (no classification_result yet) are not reviewable —
  // they haven't been classified; wait for the result before queuing for review.
  if (item.classification_result == null && !item.error) return false;
  const verdict = item.classification_result?.sanity_verdict?.toUpperCase();
  const hasCode = Boolean(item.classification_result?.resolved_hs_code);
  if (!hasCode) return true;
  if (verdict === 'FLAG' || verdict === 'BLOCK') return true;
  return false;
}

export default function BatchResultsTable({
  expectedRowCount,
  items,
  className,
  isComplete = false,
  batchId,
}: BatchResultsTableProps) {
  const t = useT();

  // Count items that need review — used for the badge on the CTA button.
  const reviewCount = useMemo(() => items.filter(needsReview).length, [items]);

  // Navigate to the review queue page scoped to this batch.
  const handleOpenManualReview = useCallback(() => {
    if (!batchId) return;
    const params = new URLSearchParams({ batch_id: batchId, status: 'pending' });
    window.location.href = `/review?${params.toString()}`;
  }, [batchId]);

  const columns = useMemo<ColumnDef<DeclarationRunItem, unknown>[]>(() => [
    // size = initial pixel width consumed by TanStack columnSizing state.
    // Users can drag the column edge to override; their widths persist
    // to localStorage. minSize/maxSize clamp the drag.
    {
      id: 'line',
      accessorKey: 'row_index',
      header: t('batch_col_line' as TKey),
      enableSorting: true,
      size: 56,
      minSize: 40,
      maxSize: 96,
      cell: ({ getValue }) => (
        <span className="font-mono text-[12px] text-[var(--ink-2)]">{String(getValue())}</span>
      ),
    },
    {
      id: 'merchant_code',
      header: t('batch_col_merchant_code' as TKey),
      enableSorting: false,
      accessorFn: (row) => row.declared_value?.hs_code ?? '',
      size: 140,
      minSize: 120,
      maxSize: 240,
      cell: ({ row }) => <MerchantCodeCell item={row.original} />,
    },
    {
      id: 'merchant_description',
      header: t('batch_col_merchant_description' as TKey),
      enableSorting: false,
      accessorFn: (row) => row.declared_value?.description ?? '',
      size: 260,
      minSize: 160,
      maxSize: 600,
      cell: ({ row }) => <MerchantDescriptionCell item={row.original} />,
    },
    {
      id: 'value',
      header: t('batch_col_value' as TKey),
      enableSorting: true,
      accessorFn: (row) => row.value?.amount?.value ?? 0,
      size: 130,
      minSize: 100,
      maxSize: 220,
      cell: ({ row }) => <ValueCell item={row.original} />,
    },
    {
      id: 'classified_code',
      header: t('batch_col_classified_code' as TKey),
      enableSorting: true,
      accessorFn: (row) => row.classification_result?.resolved_hs_code ?? '',
      size: 130,
      minSize: 100,
      maxSize: 200,
      cell: ({ row }) => {
        const fc = row.original.classification_result?.resolved_hs_code ?? null;
        if (!fc) return <span className="text-[var(--ink-3)] text-[12.5px]">—</span>;
        return (
          <span className="font-mono text-[14px] font-medium text-[var(--accent-ink)] whitespace-nowrap tabular-nums">
            {fc}
          </span>
        );
      },
    },
    {
      id: 'confidence',
      header: t('batch_col_confidence' as TKey),
      enableSorting: true,
      accessorFn: (row) => row.classification_result?.classification_confidence ?? null,
      size: 90,
      minSize: 70,
      maxSize: 120,
      cell: ({ row }) => {
        const raw = row.original.classification_result?.classification_confidence ?? null;
        if (raw == null) return <span className="text-[var(--ink-3)] text-[12px]">—</span>;
        const pct = Math.round(raw * 100);
        const tone =
          pct >= 80 ? 'oklch(0.42_0.12_155)' :
          pct >= 60 ? 'oklch(0.42_0.13_60)' :
                      'oklch(0.42_0.14_25)';
        return (
          <span
            className="font-mono text-[12px] tabular-nums"
            style={{ color: tone }}
          >
            {pct}%
          </span>
        );
      },
    },
    {
      id: 'classified_code_breakdown',
      header: t('batch_col_classified_code_breakdown' as TKey),
      enableSorting: false,
      accessorFn: (row) => row.classification_result?.resolved_hs_code ?? '',
      size: 340,
      minSize: 240,
      maxSize: 560,
      cell: ({ row }) => <CodeBreakdownCell item={row.original} />,
    },
    {
      id: 'submission_ar',
      header: t('batch_col_zatca_submission' as TKey),
      enableSorting: false,
      accessorFn: (row) =>
        pickLang(row.resolved_hs_code_description?.zatca_submission_description, 'ar') ?? '',
      size: 200,
      minSize: 140,
      maxSize: 360,
      cell: ({ row }) => {
        const ar = pickLang(
          row.original.resolved_hs_code_description?.zatca_submission_description,
          'ar',
        );
        return (
          <div
            dir="rtl"
            className="text-[12.5px] text-[var(--ink-2)] leading-[1.6] break-words"
            style={{ fontFamily: "'IBM Plex Sans Arabic', sans-serif" }}
            title={ar ?? undefined}
          >
            {ar ?? <span className="text-[var(--ink-3)]" dir="ltr">—</span>}
          </div>
        );
      },
    },
    {
      id: 'value_plausibility_verdict',
      header: t('batch_col_value_plausibility_verdict' as TKey),
      enableSorting: true,
      accessorFn: (row) => itemBucket(row, isComplete),
      size: 140,
      minSize: 100,
      maxSize: 220,
      filterFn: (row, _id, value) => itemBucket(row.original, isComplete) === value,
      cell: ({ row }) => {
        const bucket = itemBucket(row.original, isComplete);
        // Unprocessed item — no verdict yet, show nothing (row renders as skeleton)
        if (bucket === null) return null;
        const labelKey = (
          bucket === 'succeeded' ? 'batch_verdict_succeeded' :
          bucket === 'flagged'   ? 'batch_verdict_flagged' :
          bucket === 'blocked'   ? 'batch_verdict_blocked' :
                                   'batch_verdict_failed'
        ) as TKey;
        const cls = VERDICT_BADGE[bucket];
        return (
          <span className={cn('inline-block px-2 py-0.5 rounded-full font-mono text-[10.5px] uppercase tracking-[0.04em]', cls)}>
            {t(labelKey)}
          </span>
        );
      },
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [t]);

  // Simple skeleton row — single full-width pulse bar. Avoids encoding any
  // specific column geometry so it survives column show/hide automatically.
  const renderSkeletonRow = useMemo(() => {
    return (_i: number) => (
      <div className="px-[18px] py-[18px] flex items-center gap-3">
        <span className="h-3 w-1/3 bg-[var(--line-2)] animate-pulse rounded" />
        <span className="h-3 w-1/4 bg-[var(--line-2)] animate-pulse rounded" />
        <span className="h-3 flex-1 bg-[var(--line-2)] animate-pulse rounded" />
      </div>
    );
  }, []);

  // Manual review CTA — only shown once the batch is fully complete, there are
  // reviewable items, and we have a batchId to navigate to. Hidden during polling
  // to avoid confusing partial counts.
  const manualReviewCta = isComplete && reviewCount > 0 && !!batchId ? (
    <ManualReviewButton
      pendingReview={reviewCount}
      reviewedCount={0}
      onClick={handleOpenManualReview}
    />
  ) : null;

  return (
    <DataTable
      // v6 because column resizing came back; storage shape now includes
      // columnSizing again. Bumping the key invalidates v5 prefs (visibility
      // only) so returning users start with the new default widths once.
      tableId="batch-results-v7"
      // value_plausibility_verdict ships hidden by default — togglable
      // from the Columns menu in the footer. confidence is visible by default.
      defaultColumnVisibility={{ value_plausibility_verdict: false }}
      data={items}
      columns={columns}
      expectedRowCount={expectedRowCount}
      renderSkeletonRow={renderSkeletonRow}
      enableGlobalSearch
      searchPlaceholder={t('batch_search_placeholder' as TKey)}
      filterChips={{
        columnId: 'value_plausibility_verdict',
        label: t('batch_filter_verdict_label' as TKey),
        options: [
          { label: t('batch_filter_verdict_all' as TKey) },
          { label: t('batch_filter_verdict_succeeded' as TKey), value: 'succeeded' },
          { label: t('batch_filter_verdict_flagged' as TKey),   value: 'flagged' },
          { label: t('batch_filter_verdict_blocked' as TKey),   value: 'blocked' },
          { label: t('batch_filter_verdict_failed' as TKey),    value: 'failed' },
        ],
      }}
      filterExtra={manualReviewCta}
      emptyState={t('batch_empty_state' as TKey)}
      className={className}
    />
  );
}
