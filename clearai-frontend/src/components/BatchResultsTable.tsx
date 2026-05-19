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
import { useMemo, useCallback, useState } from 'react';
import { type ColumnDef } from '@tanstack/react-table';
import { useT, type TKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { pickLang, type BatchItem, type ReviewQueueRow, type AlternativeLine, ApiError } from '@/lib/api';
import { api } from '@/lib/api';
import ReviewDialog, { type ReviewItem } from './ReviewDialog';
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
  item: BatchItem,
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
  if (!finalCode) return [];
  // Strip non-digits; render at the code's natural length — never pad.
  // (Project rule: trailing zeros are semantic granularity indicators.)
  const digits = finalCode.replace(/\D/g, '');
  if (!digits) return [];
  const segments = (pathEn ?? '').split(' > ').map((s) => s.trim()).filter(Boolean);
  const rows: BuildBreakdownRow[] = [];
  // Progressive fill: emit only the levels the code actually carries.
  if (digits.length >= 2) rows.push({ code: digits.slice(0, 2), label: 'Chapter',    description: segments[0] ?? '—' });
  if (digits.length >= 4) rows.push({ code: digits.slice(0, 4), label: 'Heading',    description: segments[1] ?? segments[0] ?? '—' });
  if (digits.length >= 6) rows.push({ code: digits.slice(0, 6), label: 'Subheading', description: segments[2] ?? segments[1] ?? '—' });
  if (digits.length >= 8) rows.push({ code: digits.slice(0, 8), label: 'National',   description: segments[3] ?? segments[2] ?? '—' });
  if (digits.length >= 10) rows.push({ code: digits.slice(0, 10), label: 'Statistical', description: segments[4] ?? segments[3] ?? '—' });
  if (digits.length === 12) {
    // Only add Tariff row distinct from Statistical when fully 12-digit
    rows.push({ code: digits, label: 'Tariff', description: segments[segments.length - 1] ?? '—' });
    // Remove the preceding level if it would be a duplicate code
    if (rows.length > 1 && rows[rows.length - 2].code === digits) {
      rows.splice(rows.length - 2, 1);
    }
  } else if (rows.length > 0) {
    // Re-label the deepest row as Tariff for < 12-digit codes
    rows[rows.length - 1] = {
      ...rows[rows.length - 1],
      label: 'Tariff',
      description: segments[segments.length - 1] ?? rows[rows.length - 1].description,
    };
  }
  return rows;
}

const BREAKDOWN_DESC_MAX = 38;

/**
 * Code breakdown cell — four-row hierarchy, three inner columns:
 *   [code (mono tabular)]  [LEVEL (small caps)]  [description (truncated)]
 *
 * Tariff (last) row uses accent ink on the code + label so the eye lands
 * on the answer; upper rows are subdued context.
 */
function CodeBreakdownCell({ item }: { item: BatchItem }) {
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

function MerchantCodeCell({ item }: { item: BatchItem }) {
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
function MerchantDescriptionCell({ item }: { item: BatchItem }) {
  const desc = item.declared_value?.description ?? null;
  if (!desc) return <span className="text-[var(--ink-3)] text-[12.5px]">—</span>;
  return (
    <div className="text-[13px] text-[var(--ink-2)] leading-[1.5] break-words whitespace-pre-wrap">
      {desc}
    </div>
  );
}

/**
 * Value cell — dual-axis per the ZATCA currency rule:
 *   Source axis: declared_value.amount + declared_value.currency (invoice currency)
 *   SAR axis:    value.amount.value + value.amount.currency (canonical SAR, used for HV/LV)
 * Both are shown. If source == SAR (or no rate available) only the SAR row renders.
 * The 1000 SAR HV/LV threshold is applied to the SAR axis only.
 */
function ValueCell({ item }: { item: BatchItem }) {
  // Source axis — what the merchant declared on the invoice
  const srcAmount = item.declared_value?.amount ?? null;
  const srcCurrency = item.declared_value?.currency ?? null;

  // SAR axis — canonical converted amount used for pipeline decisions
  const sarAmount = item.value?.amount?.value ?? null;
  const sarCurrency = item.value?.amount?.currency ?? null; // should always be 'SAR'

  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

  const hasSrc = srcAmount !== null && Number.isFinite(srcAmount) && srcCurrency;
  const hasSar = sarAmount !== null && Number.isFinite(sarAmount);
  const srcIsSar = srcCurrency?.toUpperCase() === 'SAR';

  if (!hasSrc && !hasSar) {
    return <span className="text-[var(--ink-3)] text-[12.5px]">—</span>;
  }

  return (
    <div className="flex flex-col gap-0.5">
      {/* Source axis (invoice currency) — only when different from SAR */}
      {hasSrc && !srcIsSar && (
        <div className="flex items-baseline gap-1.5">
          <span className="font-mono text-[12.5px] tabular-nums text-[var(--ink)] whitespace-nowrap">
            {fmt(srcAmount!)}
          </span>
          <span className="font-mono text-[10px] uppercase tracking-[0.10em] text-[var(--ink-3)]">
            {srcCurrency}
          </span>
        </div>
      )}
      {/* SAR axis — canonical; always shown when available */}
      {hasSar && (
        <div className="flex items-baseline gap-1.5">
          <span className="font-mono text-[12.5px] tabular-nums text-[var(--ink)] whitespace-nowrap">
            {fmt(sarAmount!)}
          </span>
          <span className="font-mono text-[10px] uppercase tracking-[0.10em] text-[var(--ink-3)]">
            {sarCurrency ?? 'SAR'}
          </span>
        </div>
      )}
      {/* If only source available and it is SAR, show once */}
      {hasSrc && !hasSar && srcIsSar && (
        <div className="flex items-baseline gap-1.5">
          <span className="font-mono text-[12.5px] tabular-nums text-[var(--ink)] whitespace-nowrap">
            {fmt(srcAmount!)}
          </span>
          <span className="font-mono text-[10px] uppercase tracking-[0.10em] text-[var(--ink-3)]">
            SAR
          </span>
        </div>
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
// Map a ReviewQueueRow (from the review API) to a ReviewItem (for the dialog)
// ---------------------------------------------------------------------------

function queueRowToReviewItem(
  row: ReviewQueueRow,
  /** The matching BatchItem from the batch — used to pull declared value. */
  matchedItem?: BatchItem,
): ReviewItem {
  // Description: prefer payload.input (free-text from the trace), then the
  // matched batch item's declared description, then fall back to item_id.
  const payloadInput =
    (row.payload as Record<string, unknown> | undefined)?.input as string | undefined;
  const declaredDesc = matchedItem?.declared_value?.description ?? undefined;
  const description = payloadInput ?? declaredDesc ?? row.item_id;

  // Map ReviewCandidate[] → AlternativeLine[]
  const alternatives = (row.candidates ?? []).map((c) => ({
    code: c.code,
    description_en: c.description_en,
    description_ar: c.description_ar,
    retrieval_score: c.rerank_score,
    source_arm: c.source_arm as AlternativeLine['source_arm'],
  }));

  // sanity_flag → value-audit UX; all other reasons → code-flag/candidate UX.
  const flagType: 'value' | 'hs' = row.reason === 'sanity_flag' ? 'value' : 'hs';

  // Pull declared value amount from:
  //   1. matched batch item's declared_value (most reliable — same row)
  //   2. matched batch item's canonical value (SAR-converted)
  //   3. payload.declared_value if available
  let value: ReviewItem['value'] = null;
  if (matchedItem?.declared_value?.amount != null && matchedItem.declared_value.currency) {
    value = {
      amount: matchedItem.declared_value.amount,
      currency: matchedItem.declared_value.currency,
    };
  } else if (matchedItem?.value?.amount?.value != null && matchedItem.value.amount.currency) {
    value = {
      amount: matchedItem.value.amount.value,
      currency: matchedItem.value.amount.currency,
    };
  } else {
    // Try payload.declared_value as last resort
    const pd = (row.payload as Record<string, unknown> | undefined)
      ?.declared_value as Record<string, unknown> | undefined;
    if (pd?.amount != null && pd?.currency) {
      value = { amount: Number(pd.amount), currency: String(pd.currency) };
    }
  }

  return {
    // Use the review queue row's id as the ReviewItem id so callbacks can
    // call PATCH /classifications/review/:id.
    id: row.id,
    description,
    value,
    merchantCode: matchedItem?.declared_value?.hs_code ?? null,
    currentCode: row.current_final_code ?? null,
    currentConfidence: row.current_classification_confidence ?? null,
    verdict: row.current_sanity_verdict ?? null,
    // Pull sanity rationale from the queue row for display in the value-flag banner.
    sanityRationale: row.current_sanity_rationale ?? null,
    flagType,
    alternatives,
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface BatchResultsTableProps {
  expectedRowCount?: number;
  items: BatchItem[];
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
 * Only sanity FLAG verdict rows require review — these are value-plausibility
 * flags where the reviewer approves or blocks. PASS rows, failed rows, and
 * rows with no code are not surfaced in this inline queue.
 */
function needsReview(item: BatchItem): boolean {
  if (item.classification_result == null) return false;
  const verdict = item.classification_result.sanity_verdict?.toUpperCase();
  return verdict === 'FLAG';
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

  // ---------------------------------------------------------------------------
  // Review dialog state — queue is fetched lazily when the dialog opens.
  // ---------------------------------------------------------------------------
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewQueue, setReviewQueue] = useState<ReviewItem[]>([]);
  const [reviewIdx, setReviewIdx] = useState(0);
  const [reviewedCount, setReviewedCount] = useState(0);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  const reviewTarget = reviewQueue[reviewIdx] ?? null;

  const handleOpenManualReview = useCallback(async () => {
    if (!batchId) return;
    setReviewLoading(true);
    setReviewError(null);
    try {
      // Fetch the pending review queue for this batch. For each row we then
      // call GET /classifications/review/:id to get full candidates — the list
      // endpoint only returns a subset of fields.
      const listRes = await api.listReviewQueue({
        batch_id: batchId,
        status: 'pending',
        reason: 'sanity_flag',
        limit: 50,
      });

      // Enrich each row with the full detail (candidates are only on the detail endpoint).
      const detailedRows = await Promise.all(
        listRes.items.map((row) => api.getReviewRow(row.id)),
      );

      // Match each queue row back to the batch item so we can pull declared value.
      const queue = detailedRows.map((row) => {
        const matched = items.find((it) => it.id === row.item_id);
        return queueRowToReviewItem(row, matched);
      });
      setReviewQueue(queue);
      setReviewIdx(0);
      setReviewedCount(0);
      setReviewOpen(true);
    } catch (err: unknown) {
      const msg =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
          ? err.message
          : 'Failed to load review queue.';
      setReviewError(msg);
    } finally {
      setReviewLoading(false);
    }
  }, [batchId]);

  // ---------------------------------------------------------------------------
  // Dialog action handlers — call the real PATCH endpoint, advance the queue.
  // ---------------------------------------------------------------------------

  const handleAdvanceQueue = useCallback(() => {
    setReviewedCount((n) => n + 1);
    setReviewQueue((q) => {
      // Remove the decided item from the queue.
      const next = q.filter((_, i) => i !== reviewIdx);
      // Keep reviewIdx in bounds.
      setReviewIdx((idx) => Math.min(idx, Math.max(0, next.length - 1)));
      if (next.length === 0) {
        // Close and fully reset dialog state so no stale overlay lingers.
        setReviewOpen(false);
      }
      return next;
    });
  }, [reviewIdx]);

  const handleAccept = useCallback(
    async (item: ReviewItem) => {
      try {
        await api.submitReviewDecision(item.id, { decision: 'approve' });
      } catch {
        // Silent — item stays in queue; reviewer can try again.
        return;
      }
      handleAdvanceQueue();
    },
    [handleAdvanceQueue],
  );

  const handleDismiss = useCallback(
    async (item: ReviewItem) => {
      // "Dismiss" in the dialog maps to "reject" on the API — "I can't decide
      // on this row". The pipeline code stays untouched, row is dismissed.
      try {
        await api.submitReviewDecision(item.id, { decision: 'reject' });
      } catch {
        return;
      }
      handleAdvanceQueue();
    },
    [handleAdvanceQueue],
  );

  const handlePick = useCallback(
    async (item: ReviewItem, chosenCode: string) => {
      try {
        await api.submitReviewDecision(item.id, {
          decision: 'override',
          reviewer_code: chosenCode,
        });
      } catch (err: unknown) {
        // If the server rejects (e.g. code not in candidates), surface via
        // reviewError so the reviewer sees it without the dialog closing.
        const msg =
          err instanceof ApiError
            ? err.message
            : err instanceof Error
            ? err.message
            : 'Override failed.';
        setReviewError(msg);
        return;
      }
      handleAdvanceQueue();
    },
    [handleAdvanceQueue],
  );

  const handleBlock = useCallback(
    async (item: ReviewItem, notes: string) => {
      try {
        await api.submitReviewDecision(item.id, {
          decision: 'block_from_submission',
          reviewer_notes: notes,
        });
      } catch (err: unknown) {
        const msg =
          err instanceof ApiError
            ? err.message
            : err instanceof Error
            ? err.message
            : 'Block failed.';
        setReviewError(msg);
        return;
      }
      handleAdvanceQueue();
    },
    [handleAdvanceQueue],
  );

  const columns = useMemo<ColumnDef<BatchItem, unknown>[]>(() => [
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
  // reviewable items, and we have a batchId. Hidden during polling to avoid
  // confusing partial counts.
  // Also hidden once the queue has been fully worked through (all reviewed, none pending).
  const pendingInQueue = reviewQueue.length;
  const queueExhausted = !reviewOpen && reviewedCount > 0 && pendingInQueue === 0;
  const manualReviewCta = isComplete && reviewCount > 0 && !!batchId && !queueExhausted ? (
    <div className="flex flex-col items-end gap-[4px]">
      <ManualReviewButton
        pendingReview={reviewOpen ? pendingInQueue : reviewCount}
        reviewedCount={reviewedCount}
        onClick={() => {
          if (reviewOpen) {
            setReviewOpen(false);
          } else {
            void handleOpenManualReview();
          }
        }}
      />
      {reviewLoading && (
        <span className="font-mono text-[11px] text-[var(--ink-3)]">Loading queue…</span>
      )}
      {reviewError && !reviewOpen && (
        <span className="font-mono text-[11px] text-[oklch(0.45_0.14_25)]">{reviewError}</span>
      )}
    </div>
  ) : null;

  return (
    <>
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
            { label: t('batch_filter_verdict_failed' as TKey),    value: 'failed' },
          ],
        }}
        filterExtra={manualReviewCta}
        emptyState={t('batch_empty_state' as TKey)}
        className={className}
      />

      {/* Inline review dialog — mounted via Portal on document.body, independent of table */}
      <ReviewDialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        item={reviewTarget}
        queueLength={reviewQueue.length}
        queueIndex={reviewIdx}
        reviewedCount={reviewedCount}
        onPrev={() => setReviewIdx((i) => Math.max(0, i - 1))}
        onNext={() => setReviewIdx((i) => Math.min(reviewQueue.length - 1, i + 1))}
        onSkip={() => setReviewIdx((i) => Math.min(reviewQueue.length - 1, i + 1))}
        onAccept={handleAccept}
        onDismiss={handleDismiss}
        onPick={handlePick}
        onBlock={handleBlock}
      />
    </>
  );
}
