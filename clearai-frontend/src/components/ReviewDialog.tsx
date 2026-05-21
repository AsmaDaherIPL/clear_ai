/**
 * ReviewDialog — two-mode review modal matching the prototype exactly.
 *
 * Mode A (flagType === 'hs' or null): "Resolve classification uncertainty"
 *   - Breadcrumb: REVIEW QUEUE > LOW CONFIDENCE
 *   - Merchant details card: image placeholder + name + SKU + category tags
 *   - Current pipeline result: code + confidence % + rationale warning
 *   - Suggested alternatives: selectable rows with match %, Selected/Use this btn
 *   - Manual override input + Reason for change textarea
 *   - Footer: ← Previous · Skip · [Confirm classification]
 *
 * Mode B (flagType === 'value'): "Review declared value"
 *   - Breadcrumb: REVIEW QUEUE > VALUE CHECK
 *   - Product strip: name + merchant code
 *   - Declared value + pipeline code side-by-side
 *   - Sanity warning banner: title + rationale body
 *   - Notes textarea (required 10+ chars for flagging)
 *   - Counter: "N / 10 min for flag"
 *   - Footer: ← Previous · Skip · [Flag value] · [Accept, remove flag]
 *
 * Progress bar: segmented — one segment per queue item.
 *   Completed (< current index) = green. Current = orange. Remaining = grey.
 *
 * Portal + body scroll lock. RTL-safe (logical CSS only). No emojis.
 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { useT } from '@/lib/i18n';
import type { AlternativeLine } from '@/lib/api';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ReviewItem {
  id: string;
  description: string;
  merchantCode?: string | null;
  lineNumber?: number | null;
  value?: { amount: number; currency: string } | null;
  currentCode: string | null;
  currentLabel?: string | null;
  currentConfidence?: number | null;
  verdict?: string | null;
  /** reason from the queue row — drives which UI branch to show */
  reason?: string | null;
  /** can_override from the detail row — gates the override button */
  canOverride?: boolean | null;
  /** @deprecated use reason === 'sanity_flag' instead */
  flagType?: 'hs' | 'value' | null;
  sanityRationale?: string | null;
  alternatives: AlternativeLine[];
}

export interface ReviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: ReviewItem | null;
  queueLength?: number;
  queueIndex?: number;
  reviewedCount?: number;
  onPrev?: () => void;
  onNext?: () => void;
  onSkip?: () => void;
  onAccept: (item: ReviewItem) => void;
  onDismiss: (item: ReviewItem) => void;
  onPick: (item: ReviewItem, chosenCode: string) => void;
  onBlock: (item: ReviewItem, notes: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtAmount(n: number): string {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

/** Derive category tags from a product description heuristically. */
function inferTags(description: string): string[] {
  const lower = description.toLowerCase();
  const tags: string[] = [];
  if (lower.match(/hair|shampoo|conditioner|color|colour|dye|perm|curl/)) tags.push('Hair Care');
  if (lower.match(/skin|cream|lotion|moistur|serum|toner/)) tags.push('Skin Care');
  if (lower.match(/personal|care|beauty|cosmetic|makeup|perfume/)) tags.push('Personal Care');
  if (lower.match(/marker|pen|pencil|stationery|office|school/)) tags.push('Stationery');
  if (lower.match(/electronic|phone|tablet|computer|cable|charger/)) tags.push('Electronics');
  if (lower.match(/food|snack|drink|beverage|oil|sauce/)) tags.push('Food & Beverage');
  if (lower.match(/thermos|flask|bottle|cup|mug/)) tags.push('Drinkware');
  return tags.slice(0, 2);
}

// ---------------------------------------------------------------------------
// Segmented progress bar — one pill per queue item
// ---------------------------------------------------------------------------

function SegmentedProgress({
  total,
  currentIndex,
}: {
  total: number;
  currentIndex: number;
}) {
  if (total <= 0) return null;
  // Cap visible segments at 20 for layout
  const visibleMax = 20;
  const segments = Math.min(total, visibleMax);
  const scale = total / segments; // how many real items each segment represents

  return (
    <div className="flex items-center gap-[3px]" style={{ minWidth: 180 }}>
      {Array.from({ length: segments }, (_, i) => {
        const realIdx = Math.floor(i * scale);
        const isComplete = realIdx < currentIndex;
        const isCurrent = !isComplete && realIdx <= currentIndex && (i + 1) * scale > currentIndex;
        return (
          <div
            key={i}
            className="flex-1 h-[3px] rounded-full transition-colors duration-200"
            style={{
              background: isComplete
                ? 'oklch(0.45 0.15 140)'
                : isCurrent
                ? 'var(--accent)'
                : 'var(--line-2)',
            }}
          />
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mode A — Low Confidence / classification picker
// ---------------------------------------------------------------------------

function LowConfidenceBody({
  item,
  queueLength,
  queueIndex,
  reviewedCount,
  onPrev,
  onSkip,
  onAccept,
  onPick,
  onDismiss,
  onClose,
}: {
  item: ReviewItem;
  queueLength?: number;
  queueIndex?: number;
  reviewedCount?: number;
  onPrev?: () => void;
  onSkip?: () => void;
  onAccept: (item: ReviewItem) => void;
  onPick: (item: ReviewItem, chosenCode: string) => void;
  onDismiss: (item: ReviewItem) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [mode, setMode] = useState<'approve' | 'override' | 'reject' | null>(null);
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [manualCode, setManualCode] = useState('');
  const [manualError, setManualError] = useState('');

  // Reset on item change
  useEffect(() => {
    setMode(null);
    setSelectedCode(null);
    setManualCode('');
    setManualError('');
  }, [item.id]);

  // Keyboard nav
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft') { e.preventDefault(); onPrev?.(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose, onPrev]);

  const tags = useMemo(() => inferTags(item.description), [item.description]);

  const confidencePct = item.currentConfidence != null
    ? Math.round(item.currentConfidence * 100)
    : null;

  // can_override from the fetched detail row; default true for low-confidence reasons
  const canOverride = item.canOverride !== false;

  const handleSubmit = () => {
    if (mode === 'approve') {
      onAccept(item);
    } else if (mode === 'override') {
      const digits = (manualCode.trim() || (selectedCode ?? '')).replace(/\D/g, '');
      if (digits.length !== 12) {
        setManualError('Must be exactly 12 digits');
        return;
      }
      onPick(item, digits);
    } else if (mode === 'reject') {
      onDismiss(item);
    }
  };

  const submitDisabled =
    !mode ||
    (mode === 'override' && !(manualCode.trim() || selectedCode));

  const hasQueue = queueLength != null && queueIndex != null;
  const isFirst = hasQueue && queueIndex === 0;

  return (
    <div className="flex flex-col" style={{ width: 'min(680px, 100%)', maxHeight: 'calc(100dvh - 96px)' }}>

      {/* Header */}
      <div className="flex justify-between items-start gap-3 px-6 pt-5 pb-4 border-b border-[var(--line-2)] shrink-0">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-mono text-[10.5px] text-[var(--ink-3)] tracking-[0.10em] uppercase">
              Review Queue
            </span>
            <span className="text-[var(--ink-3)] text-[10px]">›</span>
            <span className="font-mono text-[10.5px] text-[var(--accent-ink)] tracking-[0.10em] uppercase font-semibold">
              Low Confidence
            </span>
          </div>
          <h3 className="m-0 text-[20px] font-bold tracking-[-0.02em] text-[var(--ink)]">
            Resolve classification uncertainty
          </h3>
        </div>
        <div className="flex items-center gap-4 shrink-0 pt-0.5">
          {hasQueue && (
            <div className="flex flex-col items-end gap-1.5">
              <SegmentedProgress total={queueLength!} currentIndex={queueIndex!} />
              <div className="font-mono text-[11px] text-[var(--ink-3)] tabular-nums">
                {queueIndex! + 1}/{queueLength}
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className={cn(
              'w-8 h-8 rounded-lg grid place-items-center shrink-0',
              'text-[var(--ink-3)] hover:text-[var(--ink)] hover:bg-[var(--line-2)]',
              'transition-all duration-150',
            )}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-5">

        {/* Product description */}
        <section>
          <div className="font-mono text-[10px] uppercase tracking-[0.10em] text-[var(--ink-3)] mb-2">
            {t('review_item_description')}
          </div>
          <div className="flex items-start gap-4 px-4 py-3.5 border border-[var(--line)] rounded-[10px] bg-[var(--surface)]">
            <div className="min-w-0 flex-1">
              <div className="text-[14.5px] font-semibold text-[var(--ink)] leading-snug break-words">
                {item.description || '—'}
              </div>
              {item.merchantCode && (
                <div className="font-mono text-[11.5px] text-[var(--ink-3)] mt-0.5">
                  {t('review_ctx_merchant_code')}: {item.merchantCode}
                </div>
              )}
              {tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {tags.map((tag) => (
                    <span key={tag} className="px-2.5 py-[3px] rounded-md bg-[var(--line-2)] text-[var(--ink-2)] font-mono text-[10px] uppercase tracking-[0.08em]">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Current pipeline result */}
        <section>
          <div className="font-mono text-[10px] uppercase tracking-[0.10em] text-[var(--ink-3)] mb-2">
            {t('review_current_code')}
          </div>
          <div className={cn(
            'px-4 py-3.5 border rounded-[10px]',
            confidencePct != null && confidencePct < 70
              ? 'bg-[oklch(0.97_0.03_25)] border-[oklch(0.85_0.06_25)]'
              : 'bg-[var(--surface)] border-[var(--line)]',
          )}>
            <div className="flex items-start justify-between gap-3">
              <span className="font-mono text-[18px] font-bold tracking-[-0.01em] text-[var(--ink)] tabular-nums">
                {item.currentCode
                  ? item.currentCode.replace(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/, '$1.$2.$3.$4.$5')
                  : '—'}
              </span>
              {confidencePct != null && (
                <div className={cn(
                  'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full',
                  'font-mono text-[10.5px] tracking-[0.08em] uppercase font-semibold shrink-0',
                  confidencePct < 50
                    ? 'bg-[oklch(0.92_0.07_25)] text-[oklch(0.40_0.12_25)]'
                    : confidencePct < 75
                    ? 'bg-[oklch(0.93_0.10_60)] text-[oklch(0.40_0.15_60)]'
                    : 'bg-[oklch(0.92_0.06_140)] text-[oklch(0.30_0.10_140)]',
                )}>
                  {confidencePct}%
                </div>
              )}
            </div>
            {item.currentLabel && (
              <div className="text-[13px] text-[var(--ink-2)] mt-1">{item.currentLabel}</div>
            )}
          </div>
        </section>

        {/* Candidate list — sorted by fit then score */}
        {item.alternatives.length > 0 && (
          <section>
            <div className="font-mono text-[10px] uppercase tracking-[0.10em] text-[var(--ink-3)] mb-2">
              {t('review_candidates_label')}
            </div>
            <div className="flex flex-col gap-2">
              {[...item.alternatives]
                .sort((a, b) => {
                  const fitOrder = { fits: 0, partial: 1, does_not_fit: 2 } as Record<string, number>;
                  const fa = fitOrder[a.fit ?? ''] ?? 1;
                  const fb = fitOrder[b.fit ?? ''] ?? 1;
                  if (fa !== fb) return fa - fb;
                  return (b.retrieval_score ?? 0) - (a.retrieval_score ?? 0);
                })
                .map((alt) => {
                  const isSelected = selectedCode === alt.code;
                  const isCurrent = (alt as { is_current?: boolean }).is_current === true;
                  const score = alt.retrieval_score != null ? Math.round(alt.retrieval_score * 100) : null;
                  const displayCode = alt.code.replace(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/, '$1.$2.$3.$4.$5');
                  return (
                    <div
                      key={alt.code}
                      className={cn(
                        'px-4 py-3.5 border rounded-[10px] transition-colors duration-150 cursor-pointer',
                        isCurrent
                          ? isSelected
                            ? 'bg-[oklch(0.97_0.04_55)] border-[var(--accent)]'
                            : 'bg-[oklch(0.97_0.015_55)] border-[var(--accent)]'
                          : isSelected
                            ? 'bg-[oklch(0.97_0.04_55)] border-[var(--accent)]'
                            : 'bg-[var(--surface)] border-[var(--line)] hover:border-[var(--ink-3)]',
                      )}
                      onClick={() => {
                        if (mode !== 'override') setMode('override');
                        setSelectedCode(isSelected ? null : alt.code);
                        setManualCode('');
                        setManualError('');
                      }}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={cn('font-mono text-[15px] font-bold tabular-nums', isSelected ? 'text-[var(--accent-ink)]' : 'text-[var(--ink)]')}>
                              {displayCode}
                            </span>
                            {isCurrent && (
                              <span className="px-2 py-[2px] rounded-full bg-[var(--accent)] text-white font-mono text-[9.5px] uppercase tracking-[0.08em]">
                                {t('review_cand_current')}
                              </span>
                            )}
                            {score != null && (
                              <span className="font-mono text-[10px] text-[var(--ink-3)]">
                                {t('review_cand_match')} {score}%
                              </span>
                            )}
                          </div>
                          {alt.description_en && (
                            <div className="text-[12.5px] text-[var(--ink-2)] mt-1 leading-snug">{alt.description_en}</div>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (mode !== 'override') setMode('override');
                            setSelectedCode(alt.code);
                            setManualCode('');
                            setManualError('');
                          }}
                          className={cn(
                            'shrink-0 px-3 py-1.5 rounded-[8px] text-[12.5px] font-medium transition-all duration-150',
                            isSelected
                              ? 'bg-[var(--accent)] text-white border border-[var(--accent)]'
                              : 'bg-[var(--surface)] text-[var(--ink-2)] border border-[var(--line)] hover:border-[var(--ink-3)] hover:text-[var(--ink)]',
                          )}
                        >
                          {isSelected ? t('review_action_pick') : t('review_cand_current') === t('review_cand_current') && isCurrent ? t('review_action_pick') : t('review_action_pick')}
                        </button>
                      </div>
                    </div>
                  );
                })}
            </div>
          </section>
        )}

        {/* Force-override: manual code input — shown only when override is selected and canOverride */}
        {mode === 'override' && (
          <section>
            <div className="font-mono text-[10px] uppercase tracking-[0.10em] text-[var(--ink-3)] mb-2">
              {t('review_override_code_label') ?? 'Override code'}
            </div>
            <input
              type="text"
              inputMode="numeric"
              maxLength={12}
              value={manualCode}
              onChange={(e) => { setManualCode(e.target.value.replace(/\D/g, '')); setManualError(''); setSelectedCode(null); }}
              placeholder={t('review_override_code_placeholder') ?? '12-digit HS code'}
              className={cn(
                'w-full max-w-[220px] px-3 py-2.5 rounded-[8px] font-mono text-[13.5px]',
                'border border-[var(--line)] bg-[var(--surface)]',
                'text-[var(--ink)] placeholder:text-[var(--ink-3)]',
                'focus:outline-none focus:border-[var(--ink-3)] transition-colors duration-150',
              )}
            />
            {manualError && (
              <p className="mt-1.5 text-[12px] text-[oklch(0.45_0.14_25)]">{manualError}</p>
            )}
          </section>
        )}
      </div>

      {/* Footer — 3 actions: Approve current | Override (if selected) | Reject */}
      <div className="flex items-center justify-between gap-3 flex-wrap px-6 py-3.5 border-t border-[var(--line)] bg-[var(--line-2)] shrink-0">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onPrev}
            disabled={isFirst}
            className={cn(
              'inline-flex items-center gap-1.5 px-3.5 py-2 rounded-[8px] text-[13px]',
              'border border-[var(--line)] bg-[var(--surface)] text-[var(--ink-2)]',
              'transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed',
            )}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="rtl:rotate-180">
              <path d="M19 12H5M12 5l-7 7 7 7"/>
            </svg>
            {t('review_action_prev')}
          </button>
          <button
            type="button"
            onClick={onSkip}
            className={cn(
              'px-3.5 py-2 rounded-[8px] text-[13px]',
              'border border-[var(--line)] bg-[var(--surface)] text-[var(--ink-2)]',
              'hover:border-[var(--ink-3)] hover:text-[var(--ink)] transition-all duration-150',
            )}
          >
            {t('review_action_skip')}
          </button>
        </div>
        <div className="flex items-center gap-2">
          {/* Reject */}
          <button
            type="button"
            onClick={() => { setMode('reject'); setTimeout(() => handleSubmit(), 0); }}
            className={cn(
              'px-4 py-2 rounded-[8px] text-[13px] font-medium',
              'border border-[var(--line)] bg-[var(--surface)] text-[var(--ink-2)]',
              'hover:border-[var(--ink-3)] hover:text-[var(--ink)] transition-all duration-150',
            )}
          >
            {t('review_action_reject')}
          </button>
          {/* Override — only shown when override mode active */}
          {mode === 'override' && canOverride && (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitDisabled}
              className={cn(
                'px-4 py-2 rounded-[8px] text-[13px] font-semibold',
                'border border-[var(--accent)] bg-[var(--accent)] text-white',
                'hover:brightness-110 transition-all duration-150',
                'disabled:opacity-50 disabled:cursor-not-allowed disabled:brightness-100',
              )}
            >
              {t('review_action_override')}
            </button>
          )}
          {/* Approve current */}
          {mode !== 'override' && (
            <button
              type="button"
              onClick={() => onAccept(item)}
              className={cn(
                'px-5 py-2 rounded-[8px] text-[13.5px] font-semibold',
                'bg-[var(--accent)] text-white border border-[var(--accent)]',
                'hover:brightness-110 transition-all duration-150',
              )}
            >
              {t('review_action_approve')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mode B — Value check
// ---------------------------------------------------------------------------

function ValueCheckBody({
  item,
  queueLength,
  queueIndex,
  onPrev,
  onSkip,
  onAccept,
  onBlock,
  onClose,
}: {
  item: ReviewItem;
  queueLength?: number;
  queueIndex?: number;
  onPrev?: () => void;
  onSkip?: () => void;
  onAccept: (item: ReviewItem) => void;
  onBlock: (item: ReviewItem, notes: string) => void;
  onClose: () => void;
}) {
  const [notes, setNotes] = useState('');
  const [blockConfirmOpen, setBlockConfirmOpen] = useState(false);

  useEffect(() => {
    setNotes('');
    setBlockConfirmOpen(false);
  }, [item.id]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (blockConfirmOpen) { setBlockConfirmOpen(false); return; }
        onClose();
      }
      if (e.key === 'ArrowLeft') { e.preventDefault(); onPrev?.(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [blockConfirmOpen, onClose, onPrev]);

  const canFlag = notes.trim().length >= 10;
  const hasQueue = queueLength != null && queueIndex != null;
  const isFirst = hasQueue && queueIndex === 0;
  const isSingle = queueLength === 1;

  const confidencePct = item.currentConfidence != null
    ? Math.round(item.currentConfidence * 100)
    : null;

  return (
    <>
      <div className="flex flex-col" style={{ width: 'min(680px, 100%)', maxHeight: 'calc(100dvh - 96px)' }}>

        {/* Header */}
        <div className="flex justify-between items-start gap-3 px-6 pt-5 pb-4 border-b border-[var(--line-2)] shrink-0">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="font-mono text-[10.5px] text-[var(--ink-3)] tracking-[0.10em] uppercase">
                Review Queue
              </span>
              <span className="text-[var(--ink-3)] text-[10px]">›</span>
              <span className="font-mono text-[10.5px] text-[var(--accent-ink)] tracking-[0.10em] uppercase font-semibold">
                Value Check
              </span>
            </div>
            <h3 className="m-0 text-[20px] font-bold tracking-[-0.02em] text-[var(--ink)]">
              Review declared value
            </h3>
          </div>
          <div className="flex items-center gap-4 shrink-0 pt-0.5">
            {hasQueue && (
              <div className="flex flex-col items-end gap-1.5">
                <SegmentedProgress total={queueLength!} currentIndex={queueIndex!} />
                <div className="font-mono text-[11px] text-[var(--ink-3)] tabular-nums">
                  {queueIndex! + 1}/{queueLength}
                </div>
              </div>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className={cn(
                'w-8 h-8 rounded-lg grid place-items-center shrink-0',
                'text-[var(--ink-3)] hover:text-[var(--ink)] hover:bg-[var(--line-2)]',
                'transition-all duration-150',
              )}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-5">

          {/* Product strip */}
          <div className="px-4 py-3.5 border border-[var(--line)] rounded-[10px] bg-[var(--surface)]">
            <div className="text-[14.5px] font-semibold text-[var(--ink)] leading-snug break-words">
              {item.description || '—'}
            </div>
            {item.merchantCode && (
              <div className="font-mono text-[12px] text-[var(--ink-3)] mt-0.5">
                Merchant code: {item.merchantCode}
              </div>
            )}
          </div>

          {/* Declared value + pipeline code two-col */}
          <div
            className="grid rounded-[10px] border border-[var(--line)]"
            style={{ gridTemplateColumns: '1fr 1fr', gap: '1px', background: 'var(--line)' }}
          >
            <div className="px-4 py-4 bg-[var(--surface)] rounded-s-[9px]">
              <div className="font-mono text-[10px] uppercase tracking-[0.10em] text-[var(--ink-3)] mb-2">
                Declared Value
              </div>
              {item.value ? (
                <div className="flex items-baseline gap-2 min-w-0">
                  <span className="font-mono text-[26px] font-bold tabular-nums text-[#A3590F] leading-[1.2]">
                    {fmtAmount(item.value.amount)}
                  </span>
                  <span className="font-mono text-[13px] text-[var(--ink-3)] shrink-0">
                    {item.value.currency}
                  </span>
                </div>
              ) : (
                <div className="text-[14px] text-[var(--ink-3)]">—</div>
              )}
            </div>
            <div className="px-4 py-4 bg-[var(--surface)] rounded-e-[9px]">
              <div className="font-mono text-[10px] uppercase tracking-[0.10em] text-[var(--ink-3)] mb-2">
                Pipeline Code
              </div>
              {item.currentCode ? (
                <>
                  <div className="font-mono text-[17px] font-bold tabular-nums text-[var(--accent-ink)] leading-none">
                    {item.currentCode}
                  </div>
                  {confidencePct != null && (
                    <div className="font-mono text-[12px] text-[var(--ink-3)] mt-1.5">
                      {confidencePct}% confidence
                    </div>
                  )}
                </>
              ) : (
                <div className="text-[14px] text-[var(--ink-3)]">—</div>
              )}
            </div>
          </div>

          {/* Sanity warning banner */}
          <div className="flex gap-3 items-start px-4 py-4 rounded-[10px] bg-[oklch(0.97_0.05_60)] border border-[oklch(0.88_0.08_60)]">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className="text-[oklch(0.55_0.15_60)] shrink-0 mt-[1px]" aria-hidden>
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            <div className="min-w-0">
              <div className="text-[13.5px] font-semibold text-[oklch(0.45_0.14_55)] mb-1">
                Sanity check flagged this value
              </div>
              <div className="text-[13px] text-[var(--ink-2)] leading-[1.6]"
                dangerouslySetInnerHTML={{ __html: formatRationale(item.sanityRationale) }}
              />
            </div>
          </div>

          {/* Notes */}
          <div>
            <label className="font-mono text-[10px] text-[var(--ink-3)] tracking-[0.10em] uppercase block mb-1.5">
              Notes
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Add context for the review decision…"
              className={cn(
                'w-full px-3 py-2.5 rounded-[8px] text-[13px]',
                'border border-[var(--line)] bg-[var(--surface)]',
                'text-[var(--ink)] placeholder:text-[var(--ink-3)]',
                'focus:outline-none focus:border-[var(--ink-3)] transition-colors duration-150',
                'resize-none',
              )}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 flex-wrap px-6 py-3.5 border-t border-[var(--line)] bg-[var(--line-2)] shrink-0">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onPrev}
              disabled={isFirst}
              className={cn(
                'inline-flex items-center gap-1.5 px-3.5 py-2 rounded-[8px] text-[13px]',
                'border border-[var(--line)] bg-[var(--surface)] text-[var(--ink-2)]',
                'hover:not-disabled:border-[var(--ink-3)] hover:not-disabled:text-[var(--ink)]',
                'transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed',
              )}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="rtl:rotate-180">
                <path d="M19 12H5M12 5l-7 7 7 7"/>
              </svg>
              Previous
            </button>
            {!isSingle && (
              <button
                type="button"
                onClick={onSkip}
                className={cn(
                  'px-3.5 py-2 rounded-[8px] text-[13px]',
                  'border border-[var(--line)] bg-[var(--surface)] text-[var(--ink-2)]',
                  'hover:border-[var(--ink-3)] hover:text-[var(--ink)] transition-all duration-150',
                )}
              >
                Skip
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => { if (canFlag) setBlockConfirmOpen(true); }}
              disabled={!canFlag}
              title={!canFlag ? 'Add a note (10+ chars) to flag' : undefined}
              className={cn(
                'px-4 py-2 rounded-[8px] text-[13.5px] font-medium',
                'border border-[var(--line)] bg-[var(--surface)] text-[var(--ink-2)]',
                'hover:not-disabled:border-[var(--ink-3)] hover:not-disabled:text-[var(--ink)]',
                'transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed',
              )}
            >
              Flag value
            </button>
            <button
              type="button"
              onClick={() => onAccept(item)}
              className={cn(
                'px-5 py-2 rounded-[8px] text-[13.5px] font-semibold',
                'bg-[var(--accent)] text-white border border-[var(--accent)]',
                'hover:brightness-110 transition-all duration-150',
              )}
            >
              Accept, remove flag
            </button>
          </div>
        </div>
      </div>

      {/* Block confirmation */}
      {blockConfirmOpen && (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center px-6"
          style={{ background: 'rgba(10,8,5,0.45)' }}
          onClick={(e) => { if (e.target === e.currentTarget) setBlockConfirmOpen(false); }}
        >
          <div
            className="bg-[var(--surface)] border border-[var(--line)] rounded-[14px] shadow-[0_24px_60px_-20px_rgba(20,15,5,0.36)] w-full max-w-[440px] overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b border-[var(--line-2)]">
              <p className="font-mono text-[10.5px] text-[oklch(0.45_0.14_25)] tracking-[0.12em] uppercase mb-1">
                Confirm action
              </p>
              <h3 className="m-0 text-[17px] font-semibold text-[var(--ink)]">
                Flag this declared value?
              </h3>
            </div>
            <div className="px-6 py-4">
              <p className="text-[13.5px] text-[var(--ink-2)] leading-[1.6] m-0">
                This row will be{' '}
                <strong className="text-[var(--ink)]">blocked from customs submission</strong>{' '}
                and excluded from the declaration XML.{' '}
                <span className="text-[oklch(0.45_0.14_25)] font-medium">Cannot be undone.</span>
              </p>
            </div>
            <div className="flex justify-end gap-2 px-6 py-4 border-t border-[var(--line-2)] bg-[var(--line-2)]">
              <button
                type="button"
                onClick={() => setBlockConfirmOpen(false)}
                className={cn(
                  'px-4 py-2 rounded-[8px] text-[13px]',
                  'border border-[var(--line)] bg-[var(--surface)] text-[var(--ink-2)]',
                  'hover:border-[var(--ink-3)] hover:text-[var(--ink)] transition-all duration-150',
                )}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => { onBlock(item, notes.trim()); setBlockConfirmOpen(false); }}
                className={cn(
                  'px-4 py-2 rounded-[8px] text-[13px] font-medium',
                  'bg-[oklch(0.50_0.18_25)] text-white border border-[oklch(0.50_0.18_25)]',
                  'hover:brightness-110 transition-all duration-150',
                )}
              >
                Flag declared value
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// formatRationale — bold key numbers in the rationale text
// ---------------------------------------------------------------------------

function formatRationale(text: string | null | undefined): string {
  if (!text) return 'The declared value is outside the expected range for this product type.';
  // Bold SAR ranges and multipliers
  return text
    .replace(/(\d+[\d,]*[\s–\-]+\d+[\s]*SAR)/g, '<strong>$1</strong>')
    .replace(/(\d+\.?\d*x)/g, '<strong>$1</strong>');
}

// ---------------------------------------------------------------------------
// Exported shell — Portal + body scroll lock
// ---------------------------------------------------------------------------

export default function ReviewDialog({
  open,
  onOpenChange,
  item,
  queueLength,
  queueIndex,
  reviewedCount,
  onPrev,
  onSkip,
  onAccept,
  onDismiss,
  onPick,
  onBlock,
}: ReviewDialogProps) {
  const handleClose = useCallback(() => onOpenChange(false), [onOpenChange]);

  // Lock body scroll
  useEffect(() => {
    if (open) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = prev; };
    }
  }, [open]);

  if (typeof document === 'undefined') return null;
  if (!open && !item) return null;

  // Prefer the explicit reason field; fall back to legacy flagType for backwards compat
  const isValueCheck =
    item?.reason === 'sanity_flag' ||
    (item?.reason == null && item?.flagType === 'value');

  const overlay = (
    <div
      role="presentation"
      className={cn(
        'fixed inset-0 z-[90] overflow-y-auto',
        'flex justify-center items-start pt-[72px] pb-8 px-4',
        'bg-black/[0.18] backdrop-blur-[2px]',
        'transition-opacity duration-200',
        open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none',
      )}
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={isValueCheck ? 'Review declared value' : 'Resolve classification uncertainty'}
        className={cn(
          'bg-[var(--surface)] border border-[var(--line)] rounded-[16px]',
          'shadow-[0_32px_80px_-20px_rgba(20,15,5,0.30),0_2px_4px_rgba(20,15,5,0.06)]',
          'overflow-hidden flex flex-col w-full',
          'transition-transform duration-[250ms]',
          open ? 'translate-y-0 scale-100' : 'translate-y-2 scale-[0.985]',
        )}
        style={{ maxWidth: '680px', maxHeight: 'calc(100dvh - 96px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {item && (
          isValueCheck ? (
            <ValueCheckBody
              item={item}
              queueLength={queueLength}
              queueIndex={queueIndex}
              onPrev={onPrev}
              onSkip={onSkip}
              onAccept={onAccept}
              onBlock={onBlock}
              onClose={handleClose}
            />
          ) : (
            <LowConfidenceBody
              item={item}
              queueLength={queueLength}
              queueIndex={queueIndex}
              reviewedCount={reviewedCount}
              onPrev={onPrev}
              onSkip={onSkip}
              onAccept={onAccept}
              onPick={onPick}
              onDismiss={onDismiss}
              onClose={handleClose}
            />
          )
        )}
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
