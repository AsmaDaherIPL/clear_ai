/**
 * Batch results — virtualized presentational table.
 *
 * v3.2 column order (left → right):
 *   Line | Merchant code | Merchant description | Classified code |
 *   Classified code breakdown | Confidence | ZATCA declaration submission |
 *   Value plausibility verdict
 *
 * Rationale: reviewers want to see what the merchant submitted FIRST
 * (cols 2–3) so they can compare it to the classified answer (cols
 * 4–5) at a glance. Confidence + ZATCA submission give downstream
 * context. The plausibility verdict closes the row — it's the
 * "what does the system say about whether this is plausible" answer
 * that lives at the right edge so the eye lands on it last.
 *
 * Polling stays in ClassifyApp; this component is a pure read of
 * (state.summary, state.items) the parent owns.
 *
 * Sizing: NO hardcoded `size:` numbers on column defs. Every cell
 * picks its own width via Tailwind (`min-w-`/`max-w-`/`w-` utilities)
 * exposed through `meta.cellClassName` / `meta.headerClassName`. Long
 * descriptions are also truncated by character count via clampChars()
 * so a single runaway description can't blow up the row layout.
 *
 * Row height fixed at 90px so virtualizer windowing is stable; the
 * skeleton row uses the same 90px height + same 8-column grid template
 * so the swap is layout-shift-free.
 */
import { useMemo } from 'react';
import { type ColumnDef } from '@tanstack/react-table';
import { useT, type TKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { type DeclarationRunItem } from '@/lib/api';
import { DataTable } from './DataTable';

const ROW_HEIGHT = 90;

const CONFIDENCE_BADGE: Record<string, { cls: string; label: string }> = {
  certain: { cls: 'bg-[oklch(0.88_0.08_140)] text-[oklch(0.30_0.12_140)]', label: 'Certain' },
  high:    { cls: 'bg-[oklch(0.90_0.06_160)] text-[oklch(0.32_0.10_160)]', label: 'High' },
  medium:  { cls: 'bg-[oklch(0.93_0.08_220)] text-[oklch(0.35_0.12_220)]', label: 'Medium' },
  low:     { cls: 'bg-[oklch(0.93_0.10_60)]  text-[oklch(0.40_0.15_60)]',  label: 'Low' },
  none:    { cls: 'bg-[var(--line-2)] text-[var(--ink-3)]',                 label: 'None' },
};

/**
 * Verdict pill colours — keyed off the upstream `verdict` enum
 * surfaced in `item.classification_result`. The dispatch pipeline
 * emits one of `PASS | FLAG | BLOCK`; older test rigs may also emit
 * `WARN | FAIL | SKIPPED`. We normalise everything to a small palette
 * (pass/fail/warn/skipped) inside `normaliseVerdict()` and look up
 * the colour here.
 */
const VERDICT_BADGE: Record<string, string> = {
  pass:    'bg-[oklch(0.92_0.06_140)] text-[oklch(0.30_0.10_140)]',
  fail:    'bg-[oklch(0.92_0.07_25)] text-[oklch(0.40_0.12_25)]',
  warn:    'bg-[oklch(0.93_0.10_60)] text-[oklch(0.40_0.15_60)]',
  skipped: 'bg-[var(--line-2)] text-[var(--ink-3)]',
  unknown: 'bg-[var(--line-2)] text-[var(--ink-3)]',
};

/**
 * Truncate text to N characters at a word boundary when possible.
 * Keeps cell width predictable even when a single description is
 * pathologically long; the full string still surfaces via the cell's
 * title attribute on hover.
 */
function clampChars(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

/**
 * Read the sanity verdict off the item's classification_result blob.
 *
 * The dispatch pipeline ships verdict at the top level as `sanity_verdict`
 * (see `DispatchResponse` in api.ts: 'PASS' | 'FLAG' | 'BLOCK'), but we
 * also accept a few alternative paths so future backend shapes don't
 * silently break the column:
 *
 *   1. `classification_result.sanity_verdict`  (current dispatch shape)
 *   2. `classification_result.verdict`          (flat alias)
 *   3. `classification_result.sanity.verdict`   (nested form)
 *
 * Returns the raw upstream string (caller normalises). Defensive parse
 * because classification_result is typed as Record<string, unknown>.
 */
function readVerdict(item: DeclarationRunItem): string | null {
  const cr = item.classification_result;
  if (!cr || typeof cr !== 'object') return null;

  // 1. Top-level sanity_verdict (dispatch-v1 shape).
  const topSanity = (cr as { sanity_verdict?: unknown }).sanity_verdict;
  if (typeof topSanity === 'string' && topSanity.length > 0) return topSanity;

  // 2. Top-level verdict alias.
  const topVerdict = (cr as { verdict?: unknown }).verdict;
  if (typeof topVerdict === 'string' && topVerdict.length > 0) return topVerdict;

  // 3. Nested sanity.verdict.
  const sanity = (cr as { sanity?: unknown }).sanity;
  if (sanity && typeof sanity === 'object') {
    const v = (sanity as { verdict?: unknown }).verdict;
    if (typeof v === 'string' && v.length > 0) return v;
  }

  return null;
}

/**
 * Map upstream verdict strings to the small {pass|fail|warn|skipped}
 * palette the pill colour map keys off. The dispatch pipeline emits
 * PASS | FLAG | BLOCK; we map FLAG→warn and BLOCK→fail so reviewers
 * see meaningful colour signal without backend schema coordination.
 */
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

const BREAKDOWN_DESC_MAX = 50;

/** Code Breakdown cell — JUST the 4 hierarchy rows. */
function CodeBreakdownCell({ item }: { item: DeclarationRunItem }) {
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
            {clampChars(b.description, BREAKDOWN_DESC_MAX)}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Merchant code cell — what the merchant submitted, with the inline
 * "Override applied" pill when the system substituted a different
 * code. Falls to a second line on narrow widths.
 */
function MerchantCodeCell({ item, overridePillLabel }: { item: DeclarationRunItem; overridePillLabel: string }) {
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

/**
 * Merchant description cell — verbatim raw_description from the input
 * CSV. Backend ships this incrementally; the cell falls back to "—"
 * when missing so older rows render cleanly.
 */
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
  /** Total expected row count once the run completes — drives skeleton tail length. */
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

  // Memoize columns so TanStack doesn't re-build internal state on
  // every parent render (polling triggers this every 2s). Cell + header
  // sizing lives entirely in Tailwind classes via meta — no `size:`
  // numbers on the column defs.
  const columns = useMemo<ColumnDef<DeclarationRunItem, unknown>[]>(() => [
    {
      id: 'line',
      accessorKey: 'row_index',
      header: t('batch_col_line' as TKey),
      enableSorting: true,
      meta: { headerClassName: 'w-[56px]', cellClassName: 'w-[56px]' },
      cell: ({ getValue }) => (
        <span className="font-mono text-[12px] text-[var(--ink-2)]">{String(getValue())}</span>
      ),
    },
    {
      id: 'merchant_code',
      header: t('batch_col_merchant_code' as TKey),
      enableSorting: false,
      accessorFn: (row) => row.raw_merchant_code ?? '',
      meta: { headerClassName: 'min-w-[140px] w-[160px]', cellClassName: 'min-w-[140px] w-[160px]' },
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
      meta: { headerClassName: 'min-w-[180px] max-w-[260px]', cellClassName: 'min-w-[180px] max-w-[260px]' },
      cell: ({ row }) => <MerchantDescriptionCell item={row.original} />,
    },
    {
      id: 'classified_code',
      header: t('batch_col_classified_code' as TKey),
      enableSorting: true,
      accessorFn: (row) => row.final_code ?? '',
      meta: { headerClassName: 'min-w-[140px] w-[150px]', cellClassName: 'min-w-[140px] w-[150px]' },
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
      // Filter on the final_code so the global-search hits the digits.
      accessorFn: (row) => row.final_code ?? '',
      meta: { headerClassName: 'min-w-[300px] w-[340px]', cellClassName: 'min-w-[300px] w-[340px]' },
      cell: ({ row }) => <CodeBreakdownCell item={row.original} />,
    },
    {
      id: 'confidence',
      header: t('batch_col_confidence' as TKey),
      enableSorting: true,
      accessorFn: (row) => row.confidence_band ?? '',
      meta: { headerClassName: 'w-[110px]', cellClassName: 'w-[110px]' },
      cell: ({ row }) => {
        const band = row.original.confidence_band;
        const b = band ? CONFIDENCE_BADGE[String(band)] : null;
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
      header: t('batch_col_zatca_submission' as TKey),
      enableSorting: false,
      accessorFn: (row) => row.submission_description_ar ?? '',
      meta: { headerClassName: 'min-w-[200px] max-w-[260px]', cellClassName: 'min-w-[200px] max-w-[260px]' },
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
      // accessorFn reads the normalised verdict bucket so chip values +
      // sort stay consistent with how the cell renders. PASS/FAIL/WARN
      // and FLAG/BLOCK all collapse into the same small palette.
      accessorFn: (row) => {
        const raw = readVerdict(row);
        return raw ? normaliseVerdict(raw) : '';
      },
      meta: { headerClassName: 'w-[150px]', cellClassName: 'w-[150px]' },
      // Custom filter so chip values land correctly: chip value is the
      // normalised bucket ('pass'/'fail'/'warn').
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
        // i18n: pass / fail / warn / skipped → localised label;
        // unknown falls through to the upstream string verbatim so we
        // never silently swallow a new verdict value.
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

  // v3.2 grid: 8 columns. Skeleton mirrors the real cells' Tailwind
  // sizing exactly so the swap is layout-shift-free. Min-widths inside
  // the grid template match the min-w-/w- utilities on the real cells.
  const renderSkeletonRow = useMemo(() => {
    return () => (
      <div
        className="grid items-center gap-3.5 px-3.5"
        style={{
          height: ROW_HEIGHT,
          gridTemplateColumns:
            '56px minmax(140px, 160px) minmax(180px, 260px) minmax(140px, 150px) minmax(300px, 340px) 110px minmax(200px, 260px) 150px',
        }}
      >
        {/* Line */}
        <span className="h-3 w-6 bg-[var(--line-2)] animate-pulse rounded" />
        {/* Merchant code */}
        <span className="h-3 w-[100px] bg-[var(--line-2)] animate-pulse rounded" />
        {/* Merchant description */}
        <span className="h-3 w-3/4 bg-[var(--line-2)] animate-pulse rounded" />
        {/* Classified code — slightly thicker pulse to mirror the 14px text. */}
        <span className="h-3.5 w-[120px] bg-[var(--line-2)] animate-pulse rounded" />
        {/* Classified code breakdown — 4 stacked skeleton lines. */}
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
        {/* ZATCA submission AR */}
        <span className="h-3 w-3/4 bg-[var(--line-2)] animate-pulse rounded" />
        {/* Verdict — neutral skeleton pill so swap is layout-shift-free. */}
        <span className="inline-block px-2 py-0.5 rounded-full font-mono text-[10.5px] uppercase tracking-[0.04em] bg-[var(--line-2)] text-[var(--ink-3)] w-fit">
          —
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
      maxHeight="max-h-[640px]"
      emptyState={t('batch_empty_state' as TKey)}
      className={className}
    />
  );
}
