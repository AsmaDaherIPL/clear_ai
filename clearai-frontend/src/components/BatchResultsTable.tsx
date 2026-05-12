/**
 * Batch results — virtualized presentational table.
 *
 * v3.3 changes (on top of v3.2):
 *   - Wires `tableId="batch-results-v1"` so column prefs persist in localStorage.
 *   - Column widths moved entirely to TanStack `size` / `minSize` on each column
 *     def. The old Tailwind width utilities on meta.cellClassName are gone —
 *     they were a static-layout workaround that is incompatible with
 *     user-resizable columns. meta.cellClassName / meta.headerClassName are
 *     now used only for non-width appearance classes (text colour, alignment,
 *     font variant, etc.).
 *
 * v3.2 column order (left → right):
 *   Line | Merchant code | Merchant description | Classified code |
 *   Classified code breakdown | Classification status | ZATCA declaration |
 *   Value plausibility verdict
 */
import { useMemo } from 'react';
import { type ColumnDef } from '@tanstack/react-table';
import { useT, type TKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { type DeclarationRunItem } from '@/lib/api';
import { DataTable } from './DataTable';

const ROW_HEIGHT = 90;

const CLASSIFICATION_BADGE: Record<string, { cls: string; key: TKey }> = {
  AGREEMENT:   { cls: 'bg-[oklch(0.90_0.06_160)] text-[oklch(0.32_0.10_160)]', key: 'classification_status_agreement' as TKey },
  DRIFT:       { cls: 'bg-[oklch(0.93_0.10_60)]  text-[oklch(0.40_0.15_60)]',  key: 'classification_status_drift' as TKey },
  ZERO_SIGNAL: { cls: 'bg-[oklch(0.92_0.07_25)]  text-[oklch(0.40_0.12_25)]',  key: 'classification_status_zero_signal' as TKey },
};

const VERDICT_BADGE: Record<string, string> = {
  pass:    'bg-[oklch(0.92_0.06_140)] text-[oklch(0.30_0.10_140)]',
  fail:    'bg-[oklch(0.92_0.07_25)] text-[oklch(0.40_0.12_25)]',
  warn:    'bg-[oklch(0.93_0.10_60)] text-[oklch(0.40_0.15_60)]',
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

/**
 * Read the sanity verdict off the item's classification_result blob.
 * Accepts three backend shapes so future schema changes don't silently
 * break the column:
 *   1. classification_result.sanity_verdict  (current dispatch shape)
 *   2. classification_result.verdict          (flat alias)
 *   3. classification_result.sanity.verdict   (nested form)
 */
function readVerdict(item: DeclarationRunItem): string | null {
  const cr = item.classification_result;
  if (!cr || typeof cr !== 'object') return null;

  const topSanity = (cr as { sanity_verdict?: unknown }).sanity_verdict;
  if (typeof topSanity === 'string' && topSanity.length > 0) return topSanity;

  const topVerdict = (cr as { verdict?: unknown }).verdict;
  if (typeof topVerdict === 'string' && topVerdict.length > 0) return topVerdict;

  const sanity = (cr as { sanity?: unknown }).sanity;
  if (sanity && typeof sanity === 'object') {
    const v = (sanity as { verdict?: unknown }).verdict;
    if (typeof v === 'string' && v.length > 0) return v;
  }

  return null;
}

function normaliseVerdict(raw: string): 'pass' | 'fail' | 'warn' | 'skipped' | 'unknown' {
  const lc = raw.toLowerCase();
  if (lc === 'pass') return 'pass';
  if (lc === 'fail' || lc === 'block') return 'fail';
  if (lc === 'warn' || lc === 'flag') return 'warn';
  if (lc === 'skipped' || lc === 'skip') return 'skipped';
  return 'unknown';
}

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
 * Code breakdown cell — four-row hierarchy showing how the 12-digit code
 * decomposes into Chapter / Heading / Subheading / Tariff with the
 * matching catalog description on each row.
 *
 * Layout (matches the Landing Page batch reference):
 *   [code (mono, tabular)]  [LEVEL (small caps)]  [description (truncated)]
 *
 * The Tariff row (last) is the "answer" row, so its code AND its level
 * label are rendered in the accent-orange ink to draw the eye there
 * first; the upper three rows are subdued so they read as context.
 */
function CodeBreakdownCell({ item }: { item: DeclarationRunItem }) {
  const breakdown = useMemo(
    () => buildBreakdown(item.final_code, item.catalog_path_en),
    [item.final_code, item.catalog_path_en],
  );

  if (breakdown.length === 0) {
    return <span className="text-[var(--ink-3)] text-[12.5px]">—</span>;
  }

  return (
    <div
      className={cn(
        'grid gap-y-1 text-[13px] leading-[1.5]',
        // 3-col inner grid: code · level · text
        // minmax keeps the code column from collapsing when text wraps,
        // and the level column stays a stable width across all four rows
        // so the eye can scan it as a single vertical strip.
      )}
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

function MerchantCodeCell({
  item,
  overridePillLabel,
}: {
  item: DeclarationRunItem;
  overridePillLabel: string;
}) {
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
          {overridePillLabel}
        </span>
      )}
    </div>
  );
}

const MERCHANT_DESC_MAX = 80;

function MerchantDescriptionCell({ item }: { item: DeclarationRunItem }) {
  const desc = item.raw_description ?? null;
  if (!desc) return <span className="text-[var(--ink-3)] text-[12.5px]">—</span>;
  return (
    <div
      className="text-[12.5px] text-[var(--ink-2)] line-clamp-3 break-words"
      title={desc}
    >
      {clampChars(desc, MERCHANT_DESC_MAX)}
    </div>
  );
}

interface BatchResultsTableProps {
  expectedRowCount?: number;
  items: DeclarationRunItem[];
  className?: string;
}

export default function BatchResultsTable({
  expectedRowCount,
  items,
  className,
}: BatchResultsTableProps) {
  const t = useT();

  const columns = useMemo<ColumnDef<DeclarationRunItem, unknown>[]>(() => [
    // Column sizes are proportional hints (the table fills container width
    // via tableLayout:fixed, so what matters is the ratio between sizes,
    // not their absolute pixel values). Approximate ratios at default:
    //   line: 4%, merchant_code: 10%, merchant_description: 16%,
    //   classified_code: 11%, breakdown: 25%, classification: 11%,
    //   submission_ar: 16%, verdict: 11%   (sum ≈ 100%, ~1100px equivalent)
    {
      id: 'line',
      accessorKey: 'row_index',
      header: t('batch_col_line' as TKey),
      enableSorting: true,
      size: 48,
      minSize: 40,
      maxSize: 72,
      cell: ({ getValue }) => (
        <span className="font-mono text-[12px] text-[var(--ink-2)]">{String(getValue())}</span>
      ),
    },
    {
      id: 'merchant_code',
      header: t('batch_col_merchant_code' as TKey),
      enableSorting: false,
      accessorFn: (row) => row.raw_merchant_code ?? '',
      // Bumped to 140/120 so 12-digit codes (e.g. 851830900000) fit without
      // overflow-clipping into the next column.
      size: 140,
      minSize: 120,
      maxSize: 220,
      cell: ({ row }) => (
        <MerchantCodeCell
          item={row.original}
          overridePillLabel={t('batch_pill_override_applied' as TKey)}
        />
      ),
    },
    {
      id: 'merchant_description',
      header: t('batch_col_merchant_description' as TKey),
      enableSorting: false,
      accessorFn: (row) => row.raw_description ?? '',
      size: 180,
      minSize: 140,
      maxSize: 360,
      cell: ({ row }) => <MerchantDescriptionCell item={row.original} />,
    },
    {
      id: 'classified_code',
      header: t('batch_col_classified_code' as TKey),
      enableSorting: true,
      accessorFn: (row) => row.final_code ?? '',
      size: 120,
      minSize: 100,
      maxSize: 180,
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
      id: 'classified_code_breakdown',
      header: t('batch_col_classified_code_breakdown' as TKey),
      enableSorting: false,
      accessorFn: (row) => row.final_code ?? '',
      // Widened: the new 3-column inner grid (code · level · text) needs
      // room for the 72px level strip plus a usable text width on the right.
      size: 340,
      minSize: 280,
      maxSize: 500,
      cell: ({ row }) => <CodeBreakdownCell item={row.original} />,
    },
    {
      id: 'classification_status',
      header: t('batch_col_classification_status' as TKey),
      enableSorting: true,
      accessorFn: (row) => row.classification_status ?? '',
      size: 120,
      minSize: 100,
      maxSize: 180,
      cell: ({ row }) => {
        const status = row.original.classification_status;
        const b = status ? CLASSIFICATION_BADGE[String(status)] : null;
        return b ? (
          <span className={cn('inline-block px-2 py-0.5 rounded-full font-mono text-[10.5px] uppercase tracking-[0.04em]', b.cls)}>
            {t(b.key)}
          </span>
        ) : (
          <span className="text-[var(--ink-3)] text-[12px]">—</span>
        );
      },
    },
    {
      id: 'submission_ar',
      header: t('batch_col_zatca_submission' as TKey),
      enableSorting: false,
      accessorFn: (row) => row.submission_description_ar ?? '',
      size: 180,
      minSize: 140,
      maxSize: 320,
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
      id: 'value_plausibility_verdict',
      header: t('batch_col_value_plausibility_verdict' as TKey),
      enableSorting: true,
      accessorFn: (row) => {
        const raw = readVerdict(row);
        return raw ? normaliseVerdict(raw) : '';
      },
      size: 130,
      minSize: 100,
      maxSize: 200,
      filterFn: (row, _id, value) => {
        const raw = readVerdict(row.original);
        if (!raw) return false;
        return normaliseVerdict(raw) === value;
      },
      cell: ({ row }) => {
        const raw = readVerdict(row.original);
        if (!raw) return <span className="text-[var(--ink-3)] text-[12px]">—</span>;
        const bucket = normaliseVerdict(raw);
        const cls = VERDICT_BADGE[bucket] ?? VERDICT_BADGE.unknown;
        const label =
          bucket === 'pass'    ? t('batch_verdict_pass' as TKey) :
          bucket === 'fail'    ? t('batch_verdict_fail' as TKey) :
          bucket === 'warn'    ? t('batch_verdict_warn' as TKey) :
          bucket === 'skipped' ? t('batch_verdict_skipped' as TKey) :
                                 raw;
        return (
          <span className={cn('inline-block px-2 py-0.5 rounded-full font-mono text-[10.5px] uppercase tracking-[0.04em]', cls)}>
            {label}
          </span>
        );
      },
    },
  ], [t]);

  // Skeleton row spans full colSpan so it is unaffected by column resizing.
  // The 8-column internal grid is intentionally dropped — a full-width pulse
  // bar is layout-shift-free and avoids having to keep a duplicate grid in
  // sync with the resizable column widths.
  const renderSkeletonRow = useMemo(() => {
    return (_i: number) => (
      <div className="flex items-center gap-3.5 px-3.5" style={{ height: ROW_HEIGHT }}>
        <span className="h-3 w-8 bg-[var(--line-2)] animate-pulse rounded shrink-0" />
        <span className="h-3 w-[100px] bg-[var(--line-2)] animate-pulse rounded shrink-0" />
        <span className="h-3 w-[160px] bg-[var(--line-2)] animate-pulse rounded" />
        <span className="h-3.5 w-[120px] bg-[var(--line-2)] animate-pulse rounded shrink-0" />
        <div className="flex flex-col gap-1.5 py-1 flex-1">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="h-2.5 w-[88px] bg-[var(--line-2)] animate-pulse rounded shrink-0" />
              <span className="h-2.5 flex-1 bg-[var(--line-2)] animate-pulse rounded" />
            </div>
          ))}
        </div>
        <span className="h-4 w-16 bg-[var(--line-2)] animate-pulse rounded-full shrink-0" />
        <span className="h-3 w-[120px] bg-[var(--line-2)] animate-pulse rounded shrink-0" />
        <span className="h-4 w-14 bg-[var(--line-2)] animate-pulse rounded-full shrink-0" />
      </div>
    );
  }, []);

  return (
    <DataTable
      tableId="batch-results-v1"
      data={items}
      columns={columns}
      estimatedRowHeight={ROW_HEIGHT}
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
  );
}
