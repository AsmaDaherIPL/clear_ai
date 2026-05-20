/**
 * Batch results table — prototype-exact design.
 *
 * Column order (left → right):
 *   LINE | MERCHANT DETAILS | VALUE | CLASSIFIED CODE | CONF. |
 *   PLAUSIBILITY | ZATCA DESCRIPTION | DUTY | (eye) | (flag)
 *
 * Eye icon opens a CodeBreakdownModal portal per row.
 * Flag icon appears only on flagged/blocked rows.
 * Confidence column hidden by default; togglable from Columns menu.
 *
 * Filter chip semantics:
 *   "Passed"  = items with a resolved HS code (succeeded + flagged buckets)
 *   "Flagged" = items with FLAG or BLOCK plausibility verdict
 */
import { useMemo, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { type ColumnDef } from '@tanstack/react-table';
import { useT, type TKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { pickLang, type BatchItem } from '@/lib/api';
import { DataTable } from './DataTable';

// ---------------------------------------------------------------------------
// Plausibility verdict helpers
// ---------------------------------------------------------------------------

// Prototype: light-filled pill — subtle tint bg + matching border + muted text
const PLAUSIBILITY_PASS_CLS = 'bg-[oklch(0.93_0.04_140)] border border-[oklch(0.78_0.07_140)] text-[oklch(0.38_0.09_140)]';
const PLAUSIBILITY_FLAG_CLS = 'bg-[oklch(0.94_0.05_55)]  border border-[oklch(0.78_0.09_55)]  text-[oklch(0.46_0.12_55)]';

/**
 * Format a raw HS code string into dot-separated groups for display.
 * Prototype shows: 9617.00.11.00 (groups: 4-2-2-2 for 10-digit codes,
 *                  4-2-2-2-2 for 12-digit codes).
 * Example: "640500000000" → "6405.00.00.00.00"
 *          "961700110000" → "9617.00.11.00.00"
 */
function formatHsCode(raw: string | null | undefined): string {
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 4) return digits;
  const groups: string[] = [digits.slice(0, 4)];
  let i = 4;
  while (i < digits.length) {
    groups.push(digits.slice(i, i + 2));
    i += 2;
  }
  return groups.join('.');
}

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
 *   failed    — item was processed but errored OR produced no resolved_hs_code.
 *   blocked   — sanity_verdict BLOCK.
 *   flagged   — sanity_verdict FLAG.
 *   succeeded — resolved_hs_code present and no FLAG/BLOCK.
 */
function itemBucket(
  item: BatchItem,
  isComplete = false,
): 'succeeded' | 'flagged' | 'blocked' | 'failed' | null {
  const hasError = Boolean(item.error);
  const hasClassificationResult = item.classification_result != null;

  if (!hasError && !hasClassificationResult) return isComplete ? 'failed' : null;

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

interface BreakdownRow {
  code: string;
  label: string;
  abbr: string;
  description: string;
}

function buildBreakdown(finalCode: string | null, pathEn: string | null): BreakdownRow[] {
  if (!finalCode) return [];
  const digits = finalCode.replace(/\D/g, '');
  if (!digits) return [];
  const segments = (pathEn ?? '').split(' > ').map((s) => s.trim()).filter(Boolean);
  const rows: BreakdownRow[] = [];

  if (digits.length >= 2) rows.push({ code: digits.slice(0, 2),  label: 'Chapter',    abbr: 'CH', description: segments[0] ?? '—' });
  if (digits.length >= 4) rows.push({ code: digits.slice(0, 4),  label: 'Heading',    abbr: 'HD', description: segments[1] ?? segments[0] ?? '—' });
  if (digits.length >= 6) rows.push({ code: digits.slice(0, 6),  label: 'Subheading', abbr: 'SH', description: segments[2] ?? segments[1] ?? '—' });
  if (digits.length >= 8) rows.push({ code: digits.slice(0, 8),  label: 'National',   abbr: 'NT', description: segments[3] ?? segments[2] ?? '—' });
  if (digits.length >= 10) rows.push({ code: digits.slice(0, 10), label: 'Statistical', abbr: 'ST', description: segments[4] ?? segments[3] ?? '—' });
  if (digits.length === 12) {
    rows.push({ code: digits, label: 'Tariff', abbr: 'TR', description: segments[segments.length - 1] ?? '—' });
    if (rows.length > 1 && rows[rows.length - 2].code === digits) {
      rows.splice(rows.length - 2, 1);
    }
  } else if (rows.length > 0) {
    rows[rows.length - 1] = {
      ...rows[rows.length - 1],
      label: 'Tariff',
      abbr: 'TR',
      description: segments[segments.length - 1] ?? rows[rows.length - 1].description,
    };
  }
  return rows;
}

// ---------------------------------------------------------------------------
// CodeBreakdownModal — portal modal matching prototype exactly
// ---------------------------------------------------------------------------

interface CodeBreakdownModalProps {
  item: BatchItem;
  lineNumber: number | string;
  onClose: () => void;
}

function CodeBreakdownModal({ item, lineNumber, onClose }: CodeBreakdownModalProps) {
  const t = useT();
  const resolved = item.classification_result?.resolved_hs_code ?? null;
  const pathEn   = pickLang(item.resolved_hs_code_description?.full_hierarchy, 'en');
  const breakdown = useMemo(() => buildBreakdown(resolved, pathEn), [resolved, pathEn]);
  const productName = item.declared_value?.description ?? null;

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const lineLabel = String(lineNumber).padStart(3, '0');

  const modal = (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label={`${t('batch_col_line' as TKey)} ${lineLabel} · ${t('batch_code_breakdown_title' as TKey)}`}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Card */}
      <div
        className={cn(
          'relative z-10 w-[520px] max-w-[calc(100vw-32px)] rounded-[14px]',
          'bg-[var(--surface)] shadow-[0_20px_60px_-10px_rgba(0,0,0,0.22)]',
          'overflow-hidden',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[var(--line-2)]">
          <div>
            <p className="font-mono text-[10.5px] tracking-[0.12em] uppercase text-[var(--ink-3)]">
              {t('batch_col_line' as TKey)} {lineLabel} &middot; {t('batch_code_breakdown_title' as TKey)}
            </p>
            {productName && (
              <p className="mt-1 text-[14px] font-semibold text-[var(--ink)] leading-snug">
                {clampChars(productName, 60)}
              </p>
            )}
            {resolved && (
              <p className="mt-0.5 font-mono text-[18px] font-bold text-[var(--accent-ink)] tracking-[-0.01em]">
                {formatHsCode(resolved)}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('batch_code_breakdown_close' as TKey)}
            className={cn(
              'w-8 h-8 rounded-full flex items-center justify-center',
              'text-[var(--ink-3)] hover:text-[var(--ink)] hover:bg-[var(--line-2)]',
              'transition-colors duration-100 shrink-0 ms-4',
              'font-mono text-[18px] leading-none',
            )}
          >
            &times;
          </button>
        </div>

        {/* Breakdown table */}
        {breakdown.length === 0 ? (
          <div className="px-6 py-8 text-center text-[13px] text-[var(--ink-3)]">
            {resolved ? resolved : '—'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="bg-[oklch(0.97_0.025_55)]">
                  <th className="px-5 py-2.5 text-start font-mono text-[9.5px] uppercase tracking-[0.10em] text-[var(--ink-3)] w-[72px]">
                    Level
                  </th>
                  <th className="px-3 py-2.5 text-start font-mono text-[9.5px] uppercase tracking-[0.10em] text-[var(--ink-3)] w-[110px]">
                    Code
                  </th>
                  <th className="px-3 py-2.5 text-start font-mono text-[9.5px] uppercase tracking-[0.10em] text-[var(--ink-3)]">
                    Description
                  </th>
                </tr>
              </thead>
              <tbody>
                {breakdown.map((b, i) => {
                  const isTariff = i === breakdown.length - 1;
                  return (
                    <tr
                      key={i}
                      className={cn(
                        'border-t border-[var(--line-2)]',
                        isTariff
                          ? 'bg-[oklch(0.97_0.04_55)]'
                          : 'bg-[var(--surface)]',
                      )}
                    >
                      <td className="px-5 py-3">
                        <span
                          className={cn(
                            'inline-block font-mono text-[10px] uppercase tracking-[0.12em] px-1.5 py-0.5 rounded',
                            isTariff
                              ? 'bg-[var(--accent-ink)] text-white'
                              : 'bg-[var(--line-2)] text-[var(--ink-3)]',
                          )}
                        >
                          {b.abbr}
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        <span
                          className={cn(
                            'font-mono text-[13px] tabular-nums whitespace-nowrap',
                            isTariff
                              ? 'text-[var(--accent-ink)] font-semibold'
                              : 'text-[var(--ink)]',
                          )}
                        >
                          {b.code}
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        <span
                          className={cn(
                            'text-[13px] leading-snug',
                            isTariff ? 'text-[var(--ink)] font-medium' : 'text-[var(--ink-2)]',
                          )}
                        >
                          {clampChars(b.description, 55)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Footer */}
        <div className="px-6 py-3 border-t border-[var(--line-2)] flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className={cn(
              'inline-flex items-center px-4 py-2 rounded-[8px] text-[13px] font-medium',
              'bg-[var(--ink)] text-[var(--bg)] hover:opacity-85 transition-opacity',
            )}
          >
            {t('batch_code_breakdown_close' as TKey)}
          </button>
        </div>
      </div>
    </div>
  );

  if (typeof document === 'undefined') return null;
  return createPortal(modal, document.body);
}

// ---------------------------------------------------------------------------
// Cell components
// ---------------------------------------------------------------------------

/**
 * Merged merchant details cell:
 *   Line 1 — product description (wraps freely)
 *   Line 2 — SKU / merchant HS code in smaller muted mono
 */
function MerchantDetailsCell({ item }: { item: BatchItem }) {
  const desc = item.declared_value?.description ?? null;
  const code = item.declared_value?.hs_code ?? null;

  if (!desc && !code) {
    return <span className="text-[var(--ink-3)] text-[12.5px]">—</span>;
  }

  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      {desc && (
        <div className="text-[13px] text-[var(--ink)] leading-[1.5] break-words">
          {desc}
        </div>
      )}
      {code && (
        <div className="font-mono text-[11px] text-[var(--ink-3)] whitespace-nowrap">
          {code}
        </div>
      )}
    </div>
  );
}

/**
 * Value cell — dual-axis per the ZATCA currency rule.
 */
function ValueCell({ item }: { item: BatchItem }) {
  const srcAmount   = item.declared_value?.amount ?? null;
  const srcCurrency = item.declared_value?.currency ?? null;
  const sarAmount   = item.value?.amount?.value ?? null;
  const sarCurrency = item.value?.amount?.currency ?? null;

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

/**
 * Plausibility pill cell — PASS (green) or FLAG (amber) only.
 * Unprocessed rows render nothing; failed/blocked show nothing (not plausibility).
 */
function PlausibilityCell({ item, isComplete }: { item: BatchItem; isComplete: boolean }) {
  const t = useT();
  const bucket = itemBucket(item, isComplete);
  if (bucket === null || bucket === 'failed') return null;

  if (bucket === 'blocked') {
    return (
      <span className="inline-block px-2.5 py-0.5 rounded-full font-mono text-[10.5px] uppercase tracking-[0.04em] bg-[oklch(0.93_0.04_25)] border border-[oklch(0.78_0.08_25)] text-[oklch(0.42_0.12_25)]">
        Blocked
      </span>
    );
  }

  const isFlag = bucket === 'flagged';
  return (
    <span
      className={cn(
        'inline-block px-2.5 py-0.5 rounded-full font-mono text-[10.5px] uppercase tracking-[0.04em]',
        isFlag ? PLAUSIBILITY_FLAG_CLS : PLAUSIBILITY_PASS_CLS,
      )}
    >
      {isFlag ? t('batch_plausibility_flag' as TKey) : t('batch_plausibility_pass' as TKey)}
    </span>
  );
}

/**
 * Duty cell — shows import duty rate or exempted status.
 */
function DutyCell({ item }: { item: BatchItem }) {
  const duty = (item as unknown as Record<string, unknown>).duty_info as {
    rate?: number | null;
    status?: string | null;
  } | null | undefined;

  if (!duty) return <span className="text-[var(--ink-3)] text-[12.5px]">—</span>;

  if (duty.status === 'exempted') {
    return (
      <span className="font-mono text-[11.5px] text-[oklch(0.42_0.12_155)]">Exempt</span>
    );
  }

  if (duty.status?.startsWith('prohibited')) {
    return (
      <span className="font-mono text-[11.5px] text-[oklch(0.40_0.14_25)]">Prohibited</span>
    );
  }

  if (duty.rate != null) {
    return (
      <span className="font-mono text-[12.5px] tabular-nums text-[var(--ink)]">
        {duty.rate}%
      </span>
    );
  }

  return <span className="text-[var(--ink-3)] text-[12.5px]">—</span>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface BatchResultsTableProps {
  expectedRowCount?: number;
  items: BatchItem[];
  className?: string;
  isComplete?: boolean;
  batchId?: string;
}

export default function BatchResultsTable({
  expectedRowCount,
  items,
  className,
  isComplete = false,
  batchId: _batchId,
}: BatchResultsTableProps) {
  const t = useT();

  // Breakdown popup state
  const [breakdownItem, setBreakdownItem] = useState<{ item: BatchItem; line: number | string } | null>(null);

  // Count items per bucket for filter chip counts.
  // "passed" = any item with a resolved HS code (succeeded OR flagged bucket).
  // "flagged" = only items with FLAG/BLOCK plausibility.
  const bucketCounts = useMemo(() => {
    const counts = { all: 0, flagged: 0, passed: 0 };
    for (const item of items) {
      const b = itemBucket(item, isComplete);
      if (b === null) continue;
      counts.all++;
      if (b === 'flagged' || b === 'blocked') {
        counts.flagged++;
        counts.passed++; // flagged items still have a code → also count as "passed"
      } else if (b === 'succeeded') {
        counts.passed++;
      }
    }
    return counts;
  }, [items, isComplete]);

  // ---------------------------------------------------------------------------
  // Column definitions — prototype-exact order
  // ---------------------------------------------------------------------------

  const columns = useMemo<ColumnDef<BatchItem, unknown>[]>(() => [
    // LINE
    {
      id: 'line',
      accessorKey: 'row_index',
      header: t('batch_col_line' as TKey),
      enableSorting: true,
      size: 56,
      minSize: 40,
      maxSize: 96,
      cell: ({ getValue }) => (
        <span className="font-mono text-[12px] text-[var(--ink-2)] tabular-nums">
          {String(getValue()).padStart(3, '0')}
        </span>
      ),
    },

    // MERCHANT DETAILS (merged code + description)
    {
      id: 'merchant_details',
      header: t('batch_col_merchant_details' as TKey),
      enableSorting: false,
      accessorFn: (row) =>
        [row.declared_value?.description ?? '', row.declared_value?.hs_code ?? ''].join(' '),
      size: 260,
      minSize: 180,
      maxSize: 480,
      cell: ({ row }) => <MerchantDetailsCell item={row.original} />,
    },

    // VALUE
    {
      id: 'value',
      header: t('batch_col_value' as TKey),
      enableSorting: true,
      accessorFn: (row) => row.value?.amount?.value ?? 0,
      size: 120,
      minSize: 90,
      maxSize: 200,
      cell: ({ row }) => <ValueCell item={row.original} />,
    },

    // CLASSIFIED CODE
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
        const bucket = itemBucket(row.original, isComplete);
        const isFlagRow = bucket === 'flagged' || bucket === 'blocked';
        return (
          <span className="font-mono text-[13px] font-semibold text-[var(--accent-ink)] whitespace-nowrap tabular-nums">
            {formatHsCode(fc)}
            {isFlagRow && (
              <span className="ms-1.5 text-[oklch(0.52_0.14_60)] text-[11px]" aria-hidden> ▲</span>
            )}
          </span>
        );
      },
    },

    // CONF. (hidden by default)
    {
      id: 'confidence',
      header: t('batch_col_confidence' as TKey),
      enableSorting: true,
      accessorFn: (row) => row.classification_result?.classification_confidence ?? null,
      size: 80,
      minSize: 64,
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
          <span className="font-mono text-[12px] tabular-nums" style={{ color: tone }}>
            {pct}%
          </span>
        );
      },
    },

    // PLAUSIBILITY (visible by default)
    {
      id: 'plausibility',
      header: t('batch_col_plausibility' as TKey),
      enableSorting: true,
      accessorFn: (row) => itemBucket(row, isComplete),
      size: 110,
      minSize: 90,
      maxSize: 160,
      filterFn: (row, _id, value) => {
        const b = itemBucket(row.original, isComplete);
        // "flagged" chip = only plausibility FLAG/BLOCK rows
        if (value === 'flagged') return b === 'flagged' || b === 'blocked';
        // "passed" chip = any row that has a resolved HS code (succeeded + flagged)
        if (value === 'passed') return b === 'succeeded' || b === 'flagged' || b === 'blocked';
        return true;
      },
      cell: ({ row }) => <PlausibilityCell item={row.original} isComplete={isComplete} />,
    },

    // ZATCA DESCRIPTION
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

    // DUTY
    {
      id: 'duty',
      header: t('batch_col_duty' as TKey),
      enableSorting: false,
      size: 80,
      minSize: 60,
      maxSize: 120,
      cell: ({ row }) => <DutyCell item={row.original} />,
    },

    // ACTIONS — eye icon always, flag icon for flagged rows
    {
      id: 'actions',
      header: '',
      enableSorting: false,
      size: 64,
      minSize: 48,
      maxSize: 80,
      cell: ({ row }) => {
        const rowItem = row.original;
        const bucket = itemBucket(rowItem, isComplete);
        const lineNum = (rowItem.row_index as number | string | undefined) ?? row.index + 1;
        const isFlagged = bucket === 'flagged' || bucket === 'blocked';
        const hasCode = Boolean(rowItem.classification_result?.resolved_hs_code);

        return (
          <div className="flex items-center gap-1.5">
            {/* Eye icon — HS code breakdown popup */}
            {hasCode && (
              <button
                type="button"
                onClick={() => setBreakdownItem({ item: rowItem, line: lineNum })}
                title="View HS code breakdown"
                className={cn(
                  'w-7 h-7 rounded-md flex items-center justify-center',
                  'text-[var(--ink-3)] hover:text-[var(--ink)] hover:bg-[var(--line-2)]',
                  'transition-colors duration-100',
                )}
              >
                <span
                  className="material-symbols-outlined"
                  style={{
                    fontSize: 16,
                    fontVariationSettings: "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 16",
                    lineHeight: 1,
                  }}
                  aria-hidden="true"
                >
                  visibility
                </span>
              </button>
            )}

            {/* Flag icon — flagged/blocked rows */}
            {isFlagged && (
              <span
                title="Flagged — needs review"
                className="w-7 h-7 rounded-md flex items-center justify-center text-[oklch(0.52_0.14_60)]"
              >
                <span
                  className="material-symbols-outlined"
                  style={{
                    fontSize: 15,
                    fontVariationSettings: "'FILL' 1, 'wght' 500, 'GRAD' 0, 'opsz' 16",
                    lineHeight: 1,
                  }}
                  aria-hidden="true"
                >
                  flag
                </span>
              </span>
            )}
          </div>
        );
      },
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [t, isComplete]);

  // Skeleton row — single full-width pulse bar
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
        tableId="batch-results-v9"
        // confidence hidden by default; plausibility visible
        defaultColumnVisibility={{ confidence: false }}
        data={items}
        columns={columns}
        expectedRowCount={expectedRowCount}
        renderSkeletonRow={renderSkeletonRow}
        enableGlobalSearch
        searchPlaceholder={t('batch_search_placeholder' as TKey)}
        filterChips={{
          columnId: 'plausibility',
          // no label prefix — counts embedded in chips per prototype
          options: [
            { label: 'All',     count: bucketCounts.all },
            { label: 'Flagged', value: 'flagged', count: bucketCounts.flagged },
            { label: 'Passed',  value: 'passed',  count: bucketCounts.passed },
          ],
        }}
        emptyState={t('batch_empty_state' as TKey)}
        className={className}
      />

      {/* HS Code Breakdown portal modal */}
      {breakdownItem && (
        <CodeBreakdownModal
          item={breakdownItem.item}
          lineNumber={breakdownItem.line}
          onClose={() => setBreakdownItem(null)}
        />
      )}
    </>
  );
}
