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
import { useMemo, useState } from 'react';
import { type ColumnDef } from '@tanstack/react-table';
import { useT, type TKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { pickLang, type DeclarationRunItem } from '@/lib/api';
import { DataTable } from './DataTable';
import ReviewDialog, { type ReviewItem } from './ReviewDialog';

// ---------------------------------------------------------------------------
// Pill colour maps + helpers
// ---------------------------------------------------------------------------

const VERDICT_BADGE: Record<string, string> = {
  pass:    'bg-[oklch(0.92_0.06_140)] text-[oklch(0.30_0.10_140)]',
  fail:    'bg-[oklch(0.92_0.07_25)]  text-[oklch(0.40_0.12_25)]',
  warn:    'bg-[oklch(0.93_0.10_60)]  text-[oklch(0.40_0.15_60)]',
  skipped: 'bg-[var(--line-2)] text-[var(--ink-3)]',
  unknown: 'bg-[var(--line-2)] text-[var(--ink-3)]',
};

function clampChars(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

/** Read the raw sanity verdict string for display — never rewritten. */
function readVerdict(item: DeclarationRunItem): string | null {
  return item.classification_result?.sanity_verdict ?? null;
}

/**
 * Derive the filter/sort bucket for a row from the full item state.
 *
 * Priority:
 *   1. error field set OR no resolved_hs_code → 'fail'
 *      (HITL escalations, pipeline errors — sanity_verdict is null on
 *      these rows, so reading only sanity_verdict made the Fail filter empty)
 *   2. sanity_verdict FLAG or BLOCK → 'warn'
 *   3. sanity_verdict PASS (or any other non-null value) → 'pass'
 *   4. nothing → null (row excluded from all verdict filters)
 */
function itemBucket(item: DeclarationRunItem): 'pass' | 'fail' | 'warn' | null {
  const hasCode = Boolean(item.classification_result?.resolved_hs_code);
  const hasError = Boolean(item.error);
  if (hasError || !hasCode) return 'fail';
  const sanity = item.classification_result?.sanity_verdict?.toUpperCase();
  if (sanity === 'FLAG' || sanity === 'BLOCK') return 'warn';
  if (sanity) return 'pass';
  // resolved_hs_code present but sanity_verdict null — treat as pass
  // (older payloads that predate the sanity check)
  return 'pass';
}

function normaliseVerdict(raw: string): 'pass' | 'fail' | 'warn' | 'skipped' | 'unknown' {
  const lc = raw.toLowerCase();
  if (lc === 'pass') return 'pass';
  if (lc === 'fail' || lc === 'block') return 'fail';
  if (lc === 'warn' || lc === 'flag') return 'warn';
  if (lc === 'skipped' || lc === 'skip') return 'skipped';
  return 'unknown';
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
// Component
// ---------------------------------------------------------------------------

interface BatchResultsTableProps {
  expectedRowCount?: number;
  items: DeclarationRunItem[];
  className?: string;
}

/**
 * Derive whether a row needs operator review.
 * FLAG and BLOCK verdicts need review; PASS does not.
 * Items with no resolved code also need review regardless of verdict.
 */
function needsReview(item: DeclarationRunItem): boolean {
  const verdict = item.classification_result?.sanity_verdict?.toUpperCase();
  const hasCode = Boolean(item.classification_result?.resolved_hs_code);
  if (!hasCode) return true;
  if (verdict === 'FLAG' || verdict === 'BLOCK') return true;
  return false;
}

/** Build a ReviewItem from a DeclarationRunItem for the dialog. */
function toReviewItem(item: DeclarationRunItem): ReviewItem {
  const resolved = item.classification_result?.resolved_hs_code ?? null;
  const submissionAr = pickLang(item.resolved_hs_code_description?.zatca_submission_description, 'ar');
  const submissionEn = pickLang(item.resolved_hs_code_description?.zatca_submission_description, 'en');

  // Candidates: pull from trace if present, else empty. Each pipeline
  // architecture surfaces them differently:
  //   v2 (PR 13 onwards) — meta.pipeline_v2.pick.annotated_candidates
  //                        (the picker's per-row verdicts, INCLUDING the
  //                        chosen code; filter out resolved when rendering)
  //   anchored          — per-candidate not on the wire (aggregate counts only)
  //   legacy            — meta.track_a.annotated_candidates +
  //                       meta.track_b.subtree_candidates
  const meta = (item as any).trace?.meta;
  const v2 = (meta?.pipeline_v2 ?? null) as
    | {
        pick?: {
          annotated_candidates?: Array<{
            code: string;
            description_en?: string | null;
            description_ar?: string | null;
            fit?: string;
            rationale?: string;
            source_arm?: 'merchant_prefix' | 'family_chapter' | 'unconstrained' | 'lexical_tokens';
            rerank_score?: number;
          }>;
        };
      }
    | null;
  const v2Alts = (v2?.pick?.annotated_candidates ?? [])
    .filter((c) => c.code !== resolved)
    .map((c) => ({
      code: c.code,
      description_en: c.description_en ?? null,
      description_ar: c.description_ar ?? null,
      retrieval_score: c.rerank_score ?? null,
      fit: c.fit ?? undefined,
      reason: c.rationale ?? undefined,
      source_arm: c.source_arm,
    }));
  const trackA = (meta?.track_a?.annotated_candidates ?? []).map((c: any) => ({
    code: c.code,
    description_en: c.description_en ?? null,
    description_ar: c.description_ar ?? null,
    retrieval_score: c.rrf_score ?? null,
    fit: c.fit ?? undefined,
    reason: c.rationale ?? undefined,
    track: 'track_a' as const,
  }));
  const trackB = (meta?.track_b?.subtree_candidates ?? []).map((c: any) => ({
    code: c.code,
    description_en: c.description_en ?? null,
    description_ar: c.description_ar ?? null,
    retrieval_score: c.rrf_score ?? null,
    fit: c.fit ?? undefined,
    reason: c.rationale ?? undefined,
    track: 'track_b' as const,
  }));

  return {
    id: item.id ?? String(item.row_index ?? ''),
    description: item.declared_value?.description ?? '',
    currentCode: resolved,
    currentLabel: submissionEn ?? submissionAr ?? null,
    verdict: item.classification_result?.sanity_verdict ?? null,
    alternatives: [...v2Alts, ...trackA, ...trackB],
  };
}

export default function BatchResultsTable({
  expectedRowCount,
  items,
  className,
}: BatchResultsTableProps) {
  const t = useT();

  // Review dialog state — which item (if any) is being reviewed.
  const [reviewTarget, setReviewTarget] = useState<ReviewItem | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);

  // Local override map: row id → { action: 'accepted' | 'dismissed' | 'picked', code?: string }
  // This is the UI-only state; backend wiring goes here later.
  const [reviewOutcomes, setReviewOutcomes] = useState<
    Record<string, { action: 'accepted' | 'dismissed' | 'picked'; code?: string }>
  >({});

  const handleOpenReview = (item: DeclarationRunItem) => {
    setReviewTarget(toReviewItem(item));
    setReviewOpen(true);
  };

  const handleAccept = (item: ReviewItem) => {
    setReviewOutcomes((prev) => ({ ...prev, [item.id]: { action: 'accepted' } }));
    setReviewOpen(false);
    // TODO: POST /reviews { item_id, action: 'accepted' }
  };

  const handleDismiss = (item: ReviewItem) => {
    setReviewOutcomes((prev) => ({ ...prev, [item.id]: { action: 'dismissed' } }));
    setReviewOpen(false);
    // TODO: POST /reviews { item_id, action: 'dismissed' }
  };

  const handlePick = (item: ReviewItem, chosenCode: string) => {
    setReviewOutcomes((prev) => ({ ...prev, [item.id]: { action: 'picked', code: chosenCode } }));
    setReviewOpen(false);
    // TODO: POST /reviews { item_id, action: 'picked', code: chosenCode }
  };

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
      // accessorFn drives sorting and global search — use the bucket so
      // "fail" rows sort/search consistently regardless of sanity_verdict value.
      accessorFn: (row) => itemBucket(row) ?? '',
      size: 140,
      minSize: 100,
      maxSize: 220,
      // filterFn uses itemBucket so "Fail" catches error rows and rows
      // with no resolved_hs_code, not just rows with sanity_verdict='FAIL'.
      filterFn: (row, _id, value) => itemBucket(row.original) === value,
      cell: ({ row }) => {
        const bucket = itemBucket(row.original);
        if (!bucket) return <span className="text-[var(--ink-3)] text-[12px]">—</span>;
        // Display the raw sanity_verdict as-is when present; fall back to
        // the bucket label only for error/no-code rows where there is no
        // sanity_verdict to show (rule: never rewrite a backend value).
        const raw = readVerdict(row.original);
        const displayLabel = raw ?? (
          bucket === 'fail' ? t('batch_verdict_fail' as TKey) : bucket
        );
        const cls = VERDICT_BADGE[bucket] ?? VERDICT_BADGE.unknown;
        return (
          <span className={cn('inline-block px-2 py-0.5 rounded-full font-mono text-[10.5px] uppercase tracking-[0.04em]', cls)}>
            {displayLabel}
          </span>
        );
      },
    },
    {
      id: 'review_action',
      header: '',
      enableSorting: false,
      enableHiding: false,
      accessorFn: () => '',
      size: 90,
      minSize: 72,
      maxSize: 120,
      cell: ({ row }) => {
        const item = row.original;
        const itemId = item.id ?? String(item.row_index ?? '');
        const outcome = reviewOutcomes[itemId];

        // After a review decision, show a compact outcome badge instead of the button.
        if (outcome) {
          const outcomeStyle =
            outcome.action === 'accepted'
              ? 'text-[oklch(0.36_0.13_155)]'
              : outcome.action === 'dismissed'
                ? 'text-[oklch(0.45_0.13_25)]'
                : 'text-[var(--accent)]';
          const outcomeLabel =
            outcome.action === 'accepted'
              ? t('review_outcome_accepted' as TKey)
              : outcome.action === 'dismissed'
                ? t('review_outcome_dismissed' as TKey)
                : outcome.code ?? t('review_outcome_picked' as TKey);
          return (
            <span
              className={cn(
                'font-mono text-[10.5px] uppercase tracking-[0.06em]',
                outcomeStyle,
              )}
              title={outcome.code ? `Picked: ${outcome.code}` : outcome.action}
            >
              {outcomeLabel}
            </span>
          );
        }

        // Only show the Review button on rows that need it.
        if (!needsReview(item)) return null;

        return (
          <button
            type="button"
            onClick={() => handleOpenReview(item)}
            className={cn(
              'inline-flex items-center gap-1 px-2.5 py-1 rounded-md',
              'border border-[var(--line)] bg-[var(--surface)]',
              'font-mono text-[10.5px] font-medium tracking-[0.06em] uppercase',
              'text-[var(--ink-2)] hover:border-[var(--ink-3)] hover:text-[var(--ink)]',
              'transition-colors duration-150 whitespace-nowrap',
            )}
          >
            {t('review_open_button' as TKey)}
          </button>
        );
      },
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [t, reviewOutcomes, handleOpenReview]);

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

  return (
    <>
      <DataTable
        // v6 because column resizing came back; storage shape now includes
        // columnSizing again. Bumping the key invalidates v5 prefs (visibility
        // only) so returning users start with the new default widths once.
        tableId="batch-results-v6"
        // value_plausibility_verdict ships hidden by default — togglable
        // from the Columns menu in the footer.
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
            { label: t('batch_filter_verdict_pass' as TKey), value: 'pass' },
            { label: t('batch_filter_verdict_fail' as TKey), value: 'fail' },
            { label: t('batch_filter_verdict_warn' as TKey), value: 'warn' },
          ],
        }}
        emptyState={t('batch_empty_state' as TKey)}
        className={className}
      />

      {/* Review dialog — mounted once at table level; opened per-row. */}
      <ReviewDialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        item={reviewTarget}
        onAccept={handleAccept}
        onDismiss={handleDismiss}
        onPick={handlePick}
      />
    </>
  );
}
