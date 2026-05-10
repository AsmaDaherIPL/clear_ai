/**
 * Batch results — virtualized presentational table.
 *
 * Replaces the inline <table> block that lived in ResultBatch.tsx.
 * Polling stays where it is in ClassifyApp; this component is a pure
 * read of the (state.summary, state.items) the parent already owns.
 *
 * Columns: Line | Code Breakdown | Confidence | Submission (AR) | Status
 *   - "Code Breakdown" is the new ~90px-tall multi-row hierarchy cell
 *     (Chapter / Heading / Subheading / Tariff) plus an optional
 *     pill (Valid / Override applied) and a merchant→final diff.
 *   - "Error" column is gone — run-level error renders as a single
 *     banner below the table.
 *
 * Row height: fixed at 90px so virtualizer windowing is stable
 * regardless of how many breakdown rows actually render. Skeleton
 * rows are the same height so the swap is layout-shift-free.
 */
import { useMemo } from 'react';
import { type ColumnDef } from '@tanstack/react-table';
import { cn } from '@/lib/utils';
import { type DeclarationRunItem } from '@/lib/api';
import { DataTable } from './DataTable';

const ROW_HEIGHT = 90;

const STATUS_BADGE: Record<string, string> = {
  pending: 'bg-[var(--line-2)] text-[var(--ink-3)]',
  classifying: 'bg-[var(--line-2)] text-[var(--ink-3)]',
  succeeded: 'bg-[oklch(0.92_0.06_140)] text-[oklch(0.35_0.10_140)]',
  flagged: 'bg-[oklch(0.93_0.10_60)] text-[oklch(0.40_0.15_60)]',
  blocked: 'bg-[oklch(0.92_0.07_25)] text-[oklch(0.40_0.12_25)]',
  failed: 'bg-[oklch(0.92_0.07_25)] text-[oklch(0.40_0.12_25)]',
};

const CONFIDENCE_BADGE: Record<string, { cls: string; label: string }> = {
  certain: { cls: 'bg-[oklch(0.88_0.08_140)] text-[oklch(0.30_0.12_140)]', label: 'Certain' },
  high:    { cls: 'bg-[oklch(0.90_0.06_160)] text-[oklch(0.32_0.10_160)]', label: 'High' },
  medium:  { cls: 'bg-[oklch(0.93_0.08_220)] text-[oklch(0.35_0.12_220)]', label: 'Medium' },
  low:     { cls: 'bg-[oklch(0.93_0.10_60)]  text-[oklch(0.40_0.15_60)]',  label: 'Low' },
  none:    { cls: 'bg-[var(--line-2)] text-[var(--ink-3)]',                 label: 'None' },
};

/**
 * Forward-compat extension of DeclarationRunItem. The backend doesn't
 * yet ship `raw_merchant_code` / `codebook_state` / `override_applied`
 * / `confidence_band` on every item — once it does, this table picks
 * them up automatically. Until then the cell renders without the
 * merchant→final diff and without the optional pill.
 */
type ItemExtras = {
  raw_merchant_code?: string | null;
  codebook_state?: string | null;
  override_applied?: boolean;
  confidence_band?: string | null;
};
type Item = DeclarationRunItem & ItemExtras;

interface BuildBreakdownRow {
  code: string;
  label: string;
  description: string;
}

/**
 * Slice a 12-digit final code into the 4 hierarchy levels and pair
 * each with its description from the catalog path. Falls back to the
 * deepest available description when the path is shorter than 4
 * segments (truncated paths still render the same shape).
 */
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

/**
 * Code Breakdown cell — JUST the 4 hierarchy rows.
 *
 * v3.1: dropped both pills (Valid pill removed entirely per operator
 * feedback; Override pill relocated to the Merchant column) and
 * dropped the merchant→final diff (the eye does the diff naturally
 * now that Final Code and Merchant sit in adjacent columns).
 */
function CodeBreakdownCell({ item }: { item: Item }) {
  const breakdown = useMemo(
    () => buildBreakdown(item.final_code, item.catalog_path_en),
    [item.final_code, item.catalog_path_en],
  );

  if (breakdown.length === 0) {
    return <span className="text-[var(--ink-3)] text-[12.5px]">—</span>;
  }

  return (
    <div className="flex flex-col gap-0.5 text-[12.5px] leading-[1.3]">
      {breakdown.map((b, i) => (
        <div key={i} className="flex items-baseline gap-2">
          <div className="font-mono text-[var(--ink)] tabular-nums whitespace-nowrap min-w-[88px]">
            <span>{b.code}</span>
            <span className="text-[var(--ink-3)] text-[10px] font-normal ms-1.5 uppercase tracking-[0.04em]">
              {b.label}
            </span>
          </div>
          <div
            className="flex-1 min-w-0 text-[var(--ink-2)] truncate"
            title={b.description}
          >
            {b.description}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Merchant column cell — what the merchant submitted.
 *
 * v3.1: NEW dedicated column. Renders raw_merchant_code (font-mono,
 * ink-3) plus the "Override applied" pill inline when applicable.
 * Falls to a second line if the column is too narrow for both.
 */
function MerchantCell({ item }: { item: Item }) {
  const merchantCode = item.raw_merchant_code ?? null;
  if (!merchantCode) {
    return <span className="text-[var(--ink-3)] text-[12.5px]">—</span>;
  }
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="font-mono text-[12.5px] text-[var(--ink-3)] whitespace-nowrap">
        {merchantCode}
      </span>
      {item.override_applied && (
        <span className="inline-flex items-center px-1.5 py-[1px] rounded-full text-[9.5px] font-mono uppercase tracking-[0.06em] bg-[oklch(0.92_0.06_240)] text-[oklch(0.32_0.12_240)] whitespace-nowrap">
          Override applied
        </span>
      )}
    </div>
  );
}

interface BatchResultsTableProps {
  /** Total expected row count once the run completes — drives skeleton tail length. */
  expectedRowCount?: number;
  items: Item[];
  className?: string;
}

export default function BatchResultsTable({
  expectedRowCount,
  items,
  className,
}: BatchResultsTableProps) {
  // v3.1 column order: Line | Final Code | Code Breakdown | Confidence | Submission (AR) | Merchant | Status
  // Final Code sits second so the resolved answer is the first thing
  // a reviewer scans. Merchant lives just before Status so the eye
  // can compare it against the breakdown / final code without looking
  // backwards across the row.
  //
  // Memoize so TanStack doesn't re-build internal state on every
  // parent render (polling triggers this every 2s).
  const columns = useMemo<ColumnDef<Item, unknown>[]>(() => [
    {
      id: 'line',
      accessorKey: 'row_index',
      header: 'Line',
      size: 56,
      enableSorting: true,
      cell: ({ getValue }) => (
        <span className="font-mono text-[12px] text-[var(--ink-2)]">{String(getValue())}</span>
      ),
    },
    {
      id: 'final_code',
      header: 'Final Code',
      size: 140,
      enableSorting: true,
      accessorFn: (row) => row.final_code ?? '',
      cell: ({ row }) => {
        const fc = row.original.final_code;
        if (!fc) return <span className="text-[var(--ink-3)] text-[12.5px]">—</span>;
        return (
          <span className="font-mono text-[14px] font-medium text-[var(--accent-ink)] whitespace-nowrap tabular-nums">
            {fc}
          </span>
        );
      },
    },
    {
      id: 'code_breakdown',
      header: 'Code Breakdown',
      size: 340,
      enableSorting: false,
      // Filter on the final_code so the global-search hits the digits.
      accessorFn: (row) => row.final_code ?? '',
      cell: ({ row }) => <CodeBreakdownCell item={row.original} />,
    },
    {
      id: 'confidence',
      header: 'Confidence',
      size: 110,
      enableSorting: true,
      accessorFn: (row) => row.confidence_band ?? '',
      cell: ({ row }) => {
        const band = row.original.confidence_band;
        const b = band ? CONFIDENCE_BADGE[band] : null;
        return b ? (
          <span className={cn('inline-block px-2 py-0.5 rounded-full font-mono text-[10.5px] uppercase tracking-[0.04em]', b.cls)}>
            {b.label}
          </span>
        ) : (
          <span className="text-[var(--ink-3)] text-[12px]">—</span>
        );
      },
    },
    {
      id: 'submission_ar',
      header: 'Submission (AR)',
      size: 220,
      enableSorting: false,
      accessorFn: (row) => row.submission_description_ar ?? '',
      cell: ({ row }) => {
        const ar = row.original.submission_description_ar;
        return (
          <div
            dir="rtl"
            className="text-[12.5px] text-[var(--ink-2)] line-clamp-3 break-words"
            style={{ fontFamily: "'IBM Plex Sans Arabic', sans-serif" }}
            title={ar ?? undefined}
          >
            {ar ?? <span className="text-[var(--ink-3)]" dir="ltr">—</span>}
          </div>
        );
      },
    },
    {
      id: 'merchant',
      header: 'Merchant',
      size: 160,
      enableSorting: false,
      accessorFn: (row) => row.raw_merchant_code ?? '',
      cell: ({ row }) => <MerchantCell item={row.original} />,
    },
    {
      id: 'status',
      header: 'Status',
      size: 110,
      enableSorting: true,
      accessorKey: 'status',
      // Custom filter so the chip values land correctly: chip value is
      // a string ("succeeded", "flagged", etc.); row value is the same.
      filterFn: (row, _id, value) => row.original.status === value,
      cell: ({ getValue }) => {
        const status = String(getValue() ?? 'pending');
        return (
          <span
            className={cn(
              'inline-block px-2 py-0.5 rounded-full font-mono text-[10.5px] uppercase tracking-[0.04em]',
              STATUS_BADGE[status] ?? STATUS_BADGE.pending,
            )}
          >
            {status}
          </span>
        );
      },
    },
  ], []);

  // Memoize rendered skeleton — the skeleton is structurally identical
  // every render, so re-creating it 7,400 times during fast polling
  // would torch the main thread.
  //
  // v3.1 grid: Line | Final Code | Code Breakdown | Confidence | Submission AR | Merchant | Status
  const renderSkeletonRow = useMemo(() => {
    return () => (
      <div
        className="grid items-center gap-3.5 px-3.5"
        style={{
          height: ROW_HEIGHT,
          gridTemplateColumns: '56px 140px 340px 110px 220px 160px 110px',
        }}
      >
        {/* Line */}
        <span className="h-3 w-6 bg-[var(--line-2)] animate-pulse rounded" />
        {/* Final Code — slightly thicker pulse to mirror the 14px text. */}
        <span className="h-3.5 w-[120px] bg-[var(--line-2)] animate-pulse rounded" />
        {/* Code Breakdown — 4 stacked skeleton lines mirroring the real cell rhythm. */}
        <div className="flex flex-col gap-1.5 py-1">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="h-2.5 w-[88px] bg-[var(--line-2)] animate-pulse rounded" />
              <span className="h-2.5 flex-1 bg-[var(--line-2)] animate-pulse rounded" />
            </div>
          ))}
        </div>
        {/* Confidence */}
        <span className="h-4 w-16 bg-[var(--line-2)] animate-pulse rounded-full" />
        {/* Submission AR */}
        <span className="h-3 w-3/4 bg-[var(--line-2)] animate-pulse rounded" />
        {/* Merchant — placeholder for the merchant code only (no override pill until known). */}
        <span className="h-3 w-[100px] bg-[var(--line-2)] animate-pulse rounded" />
        {/* Status — render the actual pending badge so skeleton → real swap is layout-shift-free. */}
        <span className={cn('inline-block px-2 py-0.5 rounded-full font-mono text-[10.5px] uppercase tracking-[0.04em] w-fit', STATUS_BADGE.pending)}>
          pending
        </span>
      </div>
    );
  }, []);

  return (
    <DataTable
      data={items}
      columns={columns}
      estimatedRowHeight={ROW_HEIGHT}
      expectedRowCount={expectedRowCount}
      renderSkeletonRow={renderSkeletonRow}
      enableGlobalSearch
      searchPlaceholder="Search description, code, or error…"
      filterChips={{
        columnId: 'status',
        label: 'Status',
        options: [
          { label: 'All' },
          { label: 'Succeeded', value: 'succeeded' },
          { label: 'Flagged', value: 'flagged' },
          { label: 'Failed', value: 'failed' },
        ],
      }}
      maxHeight="max-h-[640px]"
      emptyState="No items processed."
      className={className}
    />
  );
}
