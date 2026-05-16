/**
 * ReviewDialog — full-screen operator decision modal.
 *
 * Supports two flag views:
 *   flagType === 'hs'    — candidate picker with similarity bars
 *   flagType === 'value' — declared vs. expected value comparison
 *   flagType null/undef  — falls back to candidate picker (legacy behavior)
 *
 * Navigation: prev / next / skip through a review queue.
 * Keyboard: 1-4 pick candidate, Enter confirm, Arrow Left/Right navigate, Esc close.
 *
 * All action callbacks are stub-ready. No real data wiring.
 * RTL: all spacing uses logical CSS properties (ps/pe/ms/me). No ml/mr/pl/pr.
 * No emojis. No coloured side-borders on cards.
 */
import { useState, useEffect, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { useT, type TKey } from '@/lib/i18n';
import type { AlternativeLine } from '@/lib/api';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ReviewItem {
  /** Line identifier (row_index for batch, request_id for single-shot). */
  id: string;
  /** Human-readable description of the item being reviewed. */
  description: string;
  /** Merchant's original HS code prefix if provided. */
  merchantCode?: string | null;
  /** 1-based row number in the invoice. */
  lineNumber?: number | null;
  /** Declared value from invoice. */
  value?: { amount: number; currency: string } | null;
  /**
   * Current AI classification.
   * null  → no code was resolved (ZERO_SIGNAL / degraded).
   * string → a 12-digit HS code the AI picked.
   */
  currentCode: string | null;
  /** Current AI classification label (EN), if available. */
  currentLabel?: string | null;
  /** Sanity verdict from value-plausibility check, e.g. PASS / FLAG / BLOCK. */
  verdict?: string | null;
  /** Which flag view to show. null/undefined falls back to candidate picker. */
  flagType?: 'hs' | 'value' | null;
  /** Value warning details for the 'value' flag view. */
  valueWarning?: {
    expectedMin: number;
    expectedMax: number;
    reasoning: string;
  } | null;
  /** Candidate alternatives the picker considered. */
  alternatives: AlternativeLine[];
}

export interface ReviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: ReviewItem | null;
  // Queue navigation (optional — if not provided, nav buttons hidden)
  queueLength?: number;
  queueIndex?: number;
  reviewedCount?: number;
  onPrev?: () => void;
  onNext?: () => void;
  onSkip?: () => void;
  // Actions
  onAccept: (item: ReviewItem) => void;
  onDismiss: (item: ReviewItem) => void;
  onPick: (item: ReviewItem, chosenCode: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtAmount(amount: number, minimumFractionDigits = 2): string {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits,
    maximumFractionDigits: 2,
  }).format(amount);
}

// ---------------------------------------------------------------------------
// Candidate row (HS flag view)
// ---------------------------------------------------------------------------

function CandidateRow({
  alt,
  index,
  currentCode,
  picked,
  onPick,
}: {
  alt: AlternativeLine;
  index: number;
  currentCode: string | null;
  picked: string | null;
  onPick: (code: string) => void;
}) {
  const selected = picked === alt.code;
  const isCurrent = alt.code === currentCode;
  // retrieval_score is 0-1; multiply by 100 for percentage display
  const simPct = alt.retrieval_score != null ? Math.round(alt.retrieval_score * 100) : null;

  return (
    <button
      type="button"
      onClick={() => onPick(alt.code)}
      aria-pressed={selected}
      className={cn(
        'w-full text-start rounded-[10px] border transition-all duration-150',
        'grid gap-[14px] items-start px-[14px] py-[14px]',
        selected
          ? 'border-[var(--accent)] bg-[oklch(0.99_0.02_55)] shadow-[0_0_0_3px_oklch(0.80_0.12_55_/_0.15)]'
          : 'border-[var(--line)] bg-[var(--surface)] hover:border-[var(--ink-3)] hover:bg-[var(--line-2)]',
      )}
      style={{ gridTemplateColumns: '28px 1fr auto' }}
    >
      {/* Rank number */}
      <div
        className={cn(
          'w-[26px] h-[26px] rounded-[6px] grid place-items-center shrink-0',
          'font-mono text-[11px] font-medium border',
          selected
            ? 'bg-[var(--accent)] text-white border-[var(--accent)]'
            : 'bg-[var(--line-2)] text-[var(--ink-3)] border-[var(--line)]',
        )}
      >
        {index + 1}
      </div>

      {/* Code + descriptions */}
      <div className="min-w-0 flex flex-col gap-[5px]">
        <div className="flex items-center gap-[10px] flex-wrap">
          <span
            className={cn(
              'font-mono text-[15px] font-medium tabular-nums tracking-[0.01em]',
              selected ? 'text-[oklch(0.35_0.14_40)]' : 'text-[var(--ink)]',
            )}
          >
            {alt.code}
          </span>
          {isCurrent && (
            <span className="inline-flex items-center gap-[5px] px-[7px] py-[2px] rounded-[4px] bg-[#E0EEF2] text-[#15607A] font-mono text-[9.5px] tracking-[0.10em] uppercase">
              Current
            </span>
          )}
        </div>
        {alt.description_en && (
          <span className="text-[13px] text-[var(--ink-2)] leading-[1.45]">
            {alt.description_en}
          </span>
        )}
        {alt.description_ar && (
          <span
            dir="rtl"
            lang="ar"
            className="text-[12.5px] text-[var(--ink-3)] leading-[1.6] block text-end"
            style={{ fontFamily: "'IBM Plex Sans Arabic', sans-serif" }}
          >
            {alt.description_ar}
          </span>
        )}
      </div>

      {/* Score */}
      <div className="flex flex-col items-end gap-[5px] shrink-0 min-w-[90px]">
        {simPct != null && (
          <>
            <span
              className={cn(
                'font-mono text-[11.5px] tabular-nums',
                selected ? 'text-[oklch(0.35_0.14_40)]' : 'text-[var(--ink-3)]',
              )}
            >
              {simPct}% match
            </span>
            <div className="w-[80px] h-[3px] bg-[var(--line)] rounded-[2px] overflow-hidden">
              <div
                className={cn(
                  'h-full transition-[width] duration-200',
                  selected ? 'bg-[var(--accent)]' : 'bg-[var(--ink-3)]',
                )}
                style={{ width: `${simPct}%` }}
              />
            </div>
          </>
        )}
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Warning banner
// ---------------------------------------------------------------------------

function WarnBanner({
  type,
  title,
  body,
}: {
  type: 'hs' | 'value';
  title: string;
  body: string;
}) {
  const isHs = type === 'hs';
  return (
    <div
      className={cn(
        'grid gap-[14px] items-start px-[16px] py-[14px] rounded-[10px] mb-[16px]',
        isHs
          ? 'bg-[oklch(0.96_0.04_50)] border border-[oklch(0.87_0.09_55)]'
          : 'bg-[#FDF1DC] border border-[#ECC679]',
      )}
      style={{ gridTemplateColumns: '28px 1fr' }}
    >
      <div
        className={cn(
          'w-[28px] h-[28px] rounded-full grid place-items-center shrink-0',
          'text-white font-mono text-[14px] font-semibold',
          isHs ? 'bg-[var(--accent)]' : 'bg-[#C68A1B]',
        )}
      >
        {isHs ? '?' : '!'}
      </div>
      <div>
        <div
          className={cn(
            'text-[14px] font-medium leading-[1.4] mb-[4px]',
            isHs ? 'text-[oklch(0.35_0.14_40)]' : 'text-[#7A4E11]',
          )}
        >
          {title}
        </div>
        <div className="text-[13px] text-[var(--ink-2)] leading-[1.55]">{body}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Context strip (always shown)
// ---------------------------------------------------------------------------

function ContextStrip({ item }: { item: ReviewItem }) {
  const t = useT();
  const fmtValue = item.value != null ? fmtAmount(item.value.amount) : null;

  return (
    <div
      className="grid gap-[18px] items-start px-[16px] py-[14px] bg-[var(--line-2)] border border-[var(--line)] rounded-[10px] mb-[16px]"
      style={{ gridTemplateColumns: 'auto 1fr auto' }}
    >
      {/* Line number */}
      <div className="font-mono text-[12px] text-[var(--ink-3)] tracking-[0.04em]">
        {t('review_ctx_line' as TKey)}{' '}
        <span className="font-medium text-[var(--ink)] tabular-nums">
          {item.lineNumber ?? '—'}
        </span>
      </div>

      {/* Description + merchant code */}
      <div className="min-w-0">
        <div className="text-[14.5px] text-[var(--ink)] leading-[1.5] break-words">
          {item.description || '—'}
        </div>
        {item.merchantCode && (
          <span className="font-mono text-[11.5px] text-[var(--ink-3)] mt-[3px] block">
            {t('review_ctx_merchant_code' as TKey)}: {item.merchantCode}
          </span>
        )}
      </div>

      {/* Value */}
      {item.value && (
        <div className="text-end shrink-0 tabular-nums">
          <div className="font-mono text-[18px] text-[var(--ink)] font-medium tracking-[0.01em]">
            {fmtValue}
          </div>
          <div className="font-mono text-[10.5px] text-[var(--ink-3)] tracking-[0.08em] mt-[2px]">
            {item.value.currency} · {t('review_ctx_unit_value' as TKey)}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// HS flag body
// ---------------------------------------------------------------------------

function HsBody({
  item,
  picked,
  setPicked,
}: {
  item: ReviewItem;
  picked: string | null;
  setPicked: (code: string) => void;
}) {
  const t = useT();

  // Build candidate list: alternatives come from the item
  // Show up to 4 candidates. The "current" candidate is the one whose code === item.currentCode.
  const candidates: AlternativeLine[] = (() => {
    const seen = new Set<string>();
    const list: AlternativeLine[] = [];

    // Include current code as a candidate if not already in alternatives
    if (item.currentCode) {
      const existsInAlts = item.alternatives.some((a) => a.code === item.currentCode);
      if (!existsInAlts) {
        list.push({
          code: item.currentCode,
          description_en: item.currentLabel ?? null,
          description_ar: null,
          retrieval_score: null,
        });
        seen.add(item.currentCode);
      }
    }

    for (const alt of item.alternatives) {
      if (!seen.has(alt.code) && list.length < 4) {
        list.push(alt);
        seen.add(alt.code);
      }
    }

    return list.slice(0, 4);
  })();

  return (
    <>
      <WarnBanner
        type="hs"
        title={t('review_warn_hs_title' as TKey)}
        body={t('review_warn_hs_body' as TKey)}
      />

      <div className="font-mono text-[10.5px] text-[var(--ink-3)] tracking-[0.12em] uppercase mt-[6px] mb-[10px]">
        {t('review_candidates_sorted' as TKey)}
      </div>

      <div className="flex flex-col gap-[8px]">
        {candidates.map((alt, i) => (
          <CandidateRow
            key={alt.code}
            alt={alt}
            index={i}
            currentCode={item.currentCode}
            picked={picked}
            onPick={setPicked}
          />
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Value flag body
// ---------------------------------------------------------------------------

function ValueBody({ item }: { item: ReviewItem }) {
  const t = useT();
  const w = item.valueWarning;
  const declaredAmt = item.value != null ? fmtAmount(item.value.amount) : '—';

  return (
    <>
      <WarnBanner
        type="value"
        title={t('review_warn_value_title' as TKey)}
        body={w?.reasoning ?? ''}
      />

      <div className="font-mono text-[10.5px] text-[var(--ink-3)] tracking-[0.12em] uppercase mt-[6px] mb-[10px]">
        {t('review_value_section' as TKey)}
      </div>

      <div
        className="bg-[var(--surface)] border border-[var(--line)] rounded-[10px] px-[18px] py-[18px] grid gap-[16px] items-stretch"
        style={{ gridTemplateColumns: '1fr 60px 1fr' }}
      >
        {/* Declared */}
        <div className="flex flex-col gap-[6px]">
          <span className="font-mono text-[10px] text-[var(--ink-3)] tracking-[0.12em] uppercase">
            {t('review_value_declared' as TKey)}
          </span>
          <span className="font-mono text-[28px] font-medium leading-[1.05] tabular-nums tracking-[0.005em] text-[#A3590F]">
            {declaredAmt}
          </span>
          <span className="font-mono text-[10.5px] text-[var(--ink-3)] tracking-[0.08em] -mt-[2px]">
            {item.value?.currency} · {t('review_value_unit' as TKey)}
          </span>
        </div>

        {/* VS separator */}
        <div className="grid place-items-center font-mono text-[18px] text-[var(--ink-3)]">
          vs
        </div>

        {/* Expected range */}
        <div className="flex flex-col gap-[6px]">
          <span className="font-mono text-[10px] text-[var(--ink-3)] tracking-[0.12em] uppercase">
            {t('review_value_expected' as TKey)}
          </span>
          {w ? (
            <span className="font-mono text-[13px] text-[var(--ink-2)] tabular-nums">
              <span className="font-medium text-[oklch(0.35_0.12_140)]">
                {fmtAmount(w.expectedMin, 0)}
              </span>
              {' – '}
              <span className="font-medium text-[oklch(0.35_0.12_140)]">
                {fmtAmount(w.expectedMax, 0)}
              </span>
            </span>
          ) : (
            <span className="font-mono text-[13px] text-[var(--ink-3)]">—</span>
          )}
          <span className="font-mono text-[10.5px] text-[var(--ink-3)] tracking-[0.08em] -mt-[2px]">
            {item.value?.currency} · {t('review_value_unit_catalog' as TKey)}
          </span>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Modal inner (rendered when open + item present)
// ---------------------------------------------------------------------------

function ModalInner({
  item,
  queueLength,
  queueIndex,
  reviewedCount,
  onPrev,
  onNext,
  onSkip,
  onAccept,
  onDismiss,
  onPick,
  onClose,
}: {
  item: ReviewItem;
  queueLength?: number;
  queueIndex?: number;
  reviewedCount?: number;
  onPrev?: () => void;
  onNext?: () => void;
  onSkip?: () => void;
  onAccept: (item: ReviewItem) => void;
  onDismiss: (item: ReviewItem) => void;
  onPick: (item: ReviewItem, code: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const flagType = item.flagType ?? (item.alternatives.length > 0 ? 'hs' : null);

  // Default-select current code for HS view so "Accept" is the default action
  const [picked, setPicked] = useState<string | null>(() => {
    if (flagType === 'hs') {
      return item.currentCode ?? (item.alternatives[0]?.code ?? null);
    }
    return null;
  });

  // Reset picked when item changes
  useEffect(() => {
    if (flagType === 'hs') {
      setPicked(item.currentCode ?? (item.alternatives[0]?.code ?? null));
    } else {
      setPicked(null);
    }
  }, [item.id, flagType, item.currentCode, item.alternatives]);

  const hasQueue = queueLength != null && queueIndex != null;
  const isFirst = hasQueue && queueIndex === 0;
  const isCurrentPicked = flagType === 'hs' && picked === item.currentCode;

  const progressPct =
    hasQueue && queueLength > 0
      ? Math.round(((queueIndex! + 1) / queueLength) * 100)
      : 0;

  const handleAccept = useCallback(() => {
    onAccept(item);
  }, [onAccept, item]);

  const handleApply = useCallback(() => {
    if (picked && picked !== item.currentCode) {
      onPick(item, picked);
    }
  }, [onPick, item, picked]);

  const handleBlock = useCallback(() => {
    onDismiss(item);
  }, [onDismiss, item]);

  const handleSkip = useCallback(() => {
    onSkip?.();
  }, [onSkip]);

  const handlePrev = useCallback(() => {
    onPrev?.();
  }, [onPrev]);

  const handleNext = useCallback(() => {
    onNext?.();
  }, [onNext]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        handleNext();
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        handlePrev();
        return;
      }
      if (flagType === 'hs') {
        const n = parseInt(e.key, 10);
        if (n >= 1 && n <= 4) {
          // Build the same candidates list to find nth
          const seen = new Set<string>();
          const candidates: AlternativeLine[] = [];
          if (item.currentCode) {
            const existsInAlts = item.alternatives.some((a) => a.code === item.currentCode);
            if (!existsInAlts) {
              candidates.push({
                code: item.currentCode,
                description_en: item.currentLabel ?? null,
                description_ar: null,
                retrieval_score: null,
              });
              seen.add(item.currentCode);
            }
          }
          for (const alt of item.alternatives) {
            if (!seen.has(alt.code) && candidates.length < 4) {
              candidates.push(alt);
              seen.add(alt.code);
            }
          }
          const target = candidates[n - 1];
          if (target) {
            setPicked(target.code);
          }
          return;
        }
      }
      if (e.key === 'Enter') {
        if (flagType === 'hs') {
          if (isCurrentPicked) {
            handleAccept();
          } else if (picked) {
            handleApply();
          }
        } else if (flagType === 'value') {
          handleAccept();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [
    flagType,
    isCurrentPicked,
    picked,
    handleAccept,
    handleApply,
    handleNext,
    handlePrev,
    onClose,
    item,
  ]);

  // Build breadcrumb + title
  const breadcrumb =
    flagType === 'value'
      ? `${t('review_queue_label' as TKey)} · ${t('review_flag_value' as TKey)}`
      : `${t('review_queue_label' as TKey)} · ${t('review_flag_hs' as TKey)}`;

  const title =
    flagType === 'value'
      ? t('review_title_value' as TKey)
      : t('review_title_hs' as TKey);

  const candidateCount =
    flagType === 'hs'
      ? Math.min(
          4,
          item.alternatives.length +
            (item.currentCode && !item.alternatives.some((a) => a.code === item.currentCode)
              ? 1
              : 0),
        )
      : 0;

  return (
    <div
      className="flex flex-col"
      style={{ width: 'min(820px, 100%)', maxHeight: 'calc(100vh - 48px)' }}
    >
      {/* Header */}
      <div className="flex justify-between items-start gap-[14px] px-[22px] py-[18px] border-b border-[var(--line-2)] shrink-0">
        <div>
          <div className="font-mono text-[10.5px] text-[var(--ink-3)] tracking-[0.12em] uppercase">
            {breadcrumb}
          </div>
          <h3 className="mt-[6px] text-[18px] font-medium tracking-[-0.01em] text-[var(--ink)] m-0">
            {title}
          </h3>
        </div>
        <div className="flex items-center gap-[14px] shrink-0">
          {hasQueue && (
            <div className="flex flex-col items-end gap-[6px]">
              <div className="font-mono text-[11.5px] text-[var(--ink-3)] tabular-nums">
                <span className="font-medium text-[var(--ink)]">{queueIndex! + 1}</span>
                {' '}{t('review_progress_of' as TKey)}{' '}{queueLength}
                {reviewedCount != null && reviewedCount > 0 && (
                  <span> · {reviewedCount} {t('review_progress_reviewed' as TKey)}</span>
                )}
              </div>
              <div className="w-[140px] h-[3px] bg-[var(--line-2)] rounded-full overflow-hidden">
                <div
                  className="h-full bg-[var(--accent)] transition-[width] duration-[250ms]"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className={cn(
              'w-[32px] h-[32px] rounded-[8px] grid place-items-center',
              'border border-[var(--line)] bg-[var(--surface)]',
              'text-[var(--ink-3)] hover:border-[var(--ink)] hover:text-[var(--ink)]',
              'transition-all duration-150',
            )}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="px-[22px] py-[18px] overflow-y-auto flex-1">
        <ContextStrip item={item} />

        {(flagType === 'hs' || flagType == null) && (
          <HsBody item={item} picked={picked} setPicked={setPicked} />
        )}

        {flagType === 'value' && <ValueBody item={item} />}
      </div>

      {/* Footer */}
      <div
        className="flex justify-between items-center gap-[14px] flex-wrap px-[22px] py-[14px] border-t border-[var(--line)] bg-[var(--line-2)] shrink-0"
      >
        {/* Keyboard hints */}
        <div className="flex gap-[14px] font-mono text-[10.5px] text-[var(--ink-3)] tracking-[0.04em] flex-wrap">
          {flagType === 'hs' && candidateCount > 0 && (
            <span className="inline-flex items-center gap-[5px]">
              <kbd className="inline-block px-[6px] py-[2px] rounded-[4px] bg-[var(--surface)] border border-[var(--line)] font-mono text-[10px] text-[var(--ink-2)] shadow-[0_1px_0_var(--line)] min-w-[14px] text-center">
                1
              </kbd>
              –
              <kbd className="inline-block px-[6px] py-[2px] rounded-[4px] bg-[var(--surface)] border border-[var(--line)] font-mono text-[10px] text-[var(--ink-2)] shadow-[0_1px_0_var(--line)] min-w-[14px] text-center">
                {candidateCount}
              </kbd>
              {t('review_kbd_pick' as TKey)}
            </span>
          )}
          <span className="inline-flex items-center gap-[5px]">
            <kbd className="inline-block px-[6px] py-[2px] rounded-[4px] bg-[var(--surface)] border border-[var(--line)] font-mono text-[10px] text-[var(--ink-2)] shadow-[0_1px_0_var(--line)] min-w-[14px] text-center">
              ↵
            </kbd>
            {t('review_kbd_confirm' as TKey)}
          </span>
          <span className="inline-flex items-center gap-[5px]">
            <kbd className="inline-block px-[6px] py-[2px] rounded-[4px] bg-[var(--surface)] border border-[var(--line)] font-mono text-[10px] text-[var(--ink-2)] shadow-[0_1px_0_var(--line)] min-w-[14px] text-center">
              →
            </kbd>
            {t('review_kbd_next' as TKey)}
          </span>
          <span className="inline-flex items-center gap-[5px]">
            <kbd className="inline-block px-[6px] py-[2px] rounded-[4px] bg-[var(--surface)] border border-[var(--line)] font-mono text-[10px] text-[var(--ink-2)] shadow-[0_1px_0_var(--line)] min-w-[14px] text-center">
              Esc
            </kbd>
            {t('review_kbd_close' as TKey)}
          </span>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-[8px] flex-wrap">
          {hasQueue && (
            <button
              type="button"
              onClick={handlePrev}
              disabled={isFirst}
              className={cn(
                'inline-flex items-center gap-[7px] px-[14px] py-[9px] rounded-[8px]',
                'border border-[var(--line)] bg-[var(--surface)]',
                'text-[13px] text-[var(--ink-2)]',
                'hover:not-disabled:border-[var(--ink-3)] hover:not-disabled:text-[var(--ink)]',
                'transition-all duration-150',
                'disabled:opacity-45 disabled:cursor-not-allowed',
              )}
            >
              ← {t('review_action_prev' as TKey)}
            </button>
          )}

          <button
            type="button"
            onClick={handleSkip}
            className={cn(
              'inline-flex items-center gap-[7px] px-[14px] py-[9px] rounded-[8px]',
              'border border-[var(--line)] bg-[var(--surface)]',
              'text-[13px] text-[var(--ink-2)]',
              'hover:border-[var(--ink-3)] hover:text-[var(--ink)]',
              'transition-all duration-150',
            )}
          >
            {t('review_action_skip' as TKey)}
          </button>

          {(flagType === 'hs' || flagType == null) && (
            <>
              <button
                type="button"
                onClick={handleApply}
                disabled={isCurrentPicked || !picked}
                title={isCurrentPicked ? 'Pick a different code to apply' : 'Apply selected code'}
                className={cn(
                  'inline-flex items-center gap-[7px] px-[14px] py-[9px] rounded-[8px]',
                  'border border-[var(--line)] bg-[var(--surface)]',
                  'text-[13px] text-[var(--ink-2)]',
                  'hover:not-disabled:border-[var(--ink-3)] hover:not-disabled:text-[var(--ink)]',
                  'transition-all duration-150',
                  'disabled:opacity-45 disabled:cursor-not-allowed',
                )}
              >
                {t('review_action_apply' as TKey)}
              </button>
              <button
                type="button"
                onClick={handleAccept}
                className={cn(
                  'inline-flex items-center gap-[7px] px-[14px] py-[9px] rounded-[8px]',
                  'bg-[var(--ink)] text-white border border-[var(--ink)]',
                  'text-[13px]',
                  'hover:bg-black hover:border-black',
                  'transition-all duration-150',
                )}
              >
                {t('review_action_accept_resolved' as TKey)}
                <span className="opacity-70 font-mono text-[10px] px-[5px] py-[1px] border border-current rounded-[3px] tracking-[0.04em]">
                  ↵
                </span>
              </button>
            </>
          )}

          {flagType === 'value' && (
            <>
              <button
                type="button"
                onClick={handleBlock}
                className={cn(
                  'inline-flex items-center gap-[7px] px-[14px] py-[9px] rounded-[8px]',
                  'bg-[var(--surface)] text-[oklch(0.40_0.14_25)] border border-[oklch(0.82_0.06_25)]',
                  'text-[13px]',
                  'hover:bg-[oklch(0.96_0.03_25)] hover:border-[oklch(0.55_0.15_25)]',
                  'transition-all duration-150',
                )}
              >
                {t('review_action_block' as TKey)}
              </button>
              <button
                type="button"
                onClick={handleAccept}
                className={cn(
                  'inline-flex items-center gap-[7px] px-[14px] py-[9px] rounded-[8px]',
                  'bg-[var(--ink)] text-white border border-[var(--ink)]',
                  'text-[13px]',
                  'hover:bg-black hover:border-black',
                  'transition-all duration-150',
                )}
              >
                {t('review_action_accept_value' as TKey)}
                <span className="opacity-70 font-mono text-[10px] px-[5px] py-[1px] border border-current rounded-[3px] tracking-[0.04em]">
                  ↵
                </span>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Exported dialog shell — custom backdrop, no Radix Dialog
// ---------------------------------------------------------------------------

export default function ReviewDialog({
  open,
  onOpenChange,
  item,
  queueLength,
  queueIndex,
  reviewedCount,
  onPrev,
  onNext,
  onSkip,
  onAccept,
  onDismiss,
  onPick,
}: ReviewDialogProps) {
  const handleClose = useCallback(() => onOpenChange(false), [onOpenChange]);

  // Trap focus / scroll lock when open
  useEffect(() => {
    if (open) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = prev; };
    }
  }, [open]);

  if (!open && !item) return null;

  return (
    <div
      role="presentation"
      className={cn(
        'fixed inset-0 z-[90] grid place-items-center p-6',
        'bg-black/30 backdrop-blur-sm',
        'transition-opacity duration-200',
        open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none',
      )}
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Review flagged item"
        className={cn(
          'bg-[var(--surface)] border border-[var(--line)] rounded-[16px]',
          'shadow-[0_24px_60px_-20px_rgba(20,15,5,0.35),0_2px_4px_rgba(20,15,5,0.08)]',
          'overflow-hidden flex flex-col',
          'transition-transform duration-[250ms] cubic-bezier(.2,.8,.2,1)',
          open ? 'translate-y-0 scale-100' : 'translate-y-2 scale-[0.985]',
        )}
        style={{ width: 'min(820px, 100%)', maxHeight: 'calc(100vh - 48px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {item ? (
          <ModalInner
            item={item}
            queueLength={queueLength}
            queueIndex={queueIndex}
            reviewedCount={reviewedCount}
            onPrev={onPrev}
            onNext={onNext}
            onSkip={onSkip}
            onAccept={onAccept}
            onDismiss={onDismiss}
            onPick={onPick}
            onClose={handleClose}
          />
        ) : null}
      </div>
    </div>
  );
}
