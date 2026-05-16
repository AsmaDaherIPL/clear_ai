/**
 * ReviewDialog — full-screen operator decision modal, mounted via React Portal
 * so it sits on document.body independent of any scrollable table container.
 *
 * Two flag types, two reviewer UX flows, one PATCH endpoint:
 *
 *   flagType === 'value'  (reason: sanity_flag)
 *     The pipeline's code is fine; the sanity stage found the declared value
 *     implausible. Reviewer makes a finance/ops call: trust the value or block.
 *     Buttons: Approve · Block from submission · Reject (can't decide)
 *     Optionally reveals the candidate list via "Also re-classify" for cross-over
 *     cases where the value problem exposed a code problem.
 *
 *   flagType === 'code'   (reason: verifier_uncertain | verdict_escalate | low_information)
 *     The pipeline is uncertain about which HS code applies. Reviewer picks the
 *     right code from candidates or force-overrides outside the candidate set.
 *     Buttons: Approve current · Override (pick candidate) · Reject · Block
 *
 * Both types share a PATCH /classifications/review/:id endpoint; the presence /
 * absence of reviewer_code in the body is what differs between approve vs override.
 *
 * RTL: all spacing uses logical CSS properties (ps/pe/ms/me). No ml/mr/pl/pr.
 * No emojis. No coloured side-borders on cards.
 */
import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { useT, type TKey } from '@/lib/i18n';
import type { AlternativeLine } from '@/lib/api';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ReviewItem {
  /** hitl_queue.id — used as the PATCH target. */
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
   * Current AI classification code (12 digits).
   * null  → no code resolved (ZERO_SIGNAL / degraded).
   */
  currentCode: string | null;
  /** Current AI classification label (EN), if available. */
  currentLabel?: string | null;
  /** classification_confidence for the current resolved code (0-1). */
  currentConfidence?: number | null;
  /** Sanity verdict text, e.g. PASS / FLAG / BLOCK. */
  verdict?: string | null;
  /**
   * Which review UX to show:
   *   'value' → sanity_flag rows: value-audit screen (approve/block/reject)
   *   'hs'    → code-flag rows: candidate-picker screen (approve/override/reject/block)
   *   null    → falls back to 'hs' if alternatives present
   */
  flagType?: 'hs' | 'value' | null;
  /**
   * Sanity rationale text from current_sanity_rationale — shown in the
   * value-flag banner so the reviewer sees exactly why it was flagged.
   */
  sanityRationale?: string | null;
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
  onBlock: (item: ReviewItem, notes: string) => void;
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
// Candidate row (code-flag view)
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
// Context strip (always shown at the top of both views)
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
// VALUE FLAG body — sanity_flag rows
// Reviewer's question: "Is the merchant's declared value plausible?"
// Actions: Approve (trust it) · Block (pull from XML) · Reject (can't decide)
// ---------------------------------------------------------------------------

function ValueFlagBody({
  item,
  notes,
  setNotes,
  showCodePath,
  onShowCodePath,
}: {
  item: ReviewItem;
  notes: string;
  setNotes: (s: string) => void;
  showCodePath: boolean;
  onShowCodePath: () => void;
}) {
  return (
    <>
      {/* Sanity banner */}
      <div
        className="grid gap-[14px] items-start px-[16px] py-[14px] rounded-[10px] mb-[16px] bg-[#FDF1DC] border border-[#ECC679]"
        style={{ gridTemplateColumns: '28px 1fr' }}
      >
        <div className="w-[28px] h-[28px] rounded-full grid place-items-center shrink-0 bg-[#C68A1B] text-white font-mono text-[14px] font-semibold">
          !
        </div>
        <div>
          <div className="text-[14px] font-medium leading-[1.4] mb-[4px] text-[#7A4E11]">
            Value flagged by sanity check
          </div>
          {item.sanityRationale ? (
            <div className="text-[13px] text-[var(--ink-2)] leading-[1.55]">
              {item.sanityRationale}
            </div>
          ) : (
            <div className="text-[13px] text-[var(--ink-2)] leading-[1.55]">
              The declared value is outside the expected range for this product type.
            </div>
          )}
        </div>
      </div>

      {/* Pipeline code summary */}
      {item.currentCode && (
        <div className="flex items-center gap-3 mb-[16px] px-[14px] py-[12px] rounded-[10px] bg-[var(--surface)] border border-[var(--line)]">
          <span className="font-mono text-[11px] text-[var(--ink-3)] tracking-[0.10em] uppercase shrink-0">
            Pipeline code
          </span>
          <span className="font-mono text-[15px] font-medium text-[var(--accent-ink)] tabular-nums tracking-[0.01em]">
            {item.currentCode}
          </span>
          {item.currentLabel && (
            <span className="text-[13px] text-[var(--ink-2)] truncate">{item.currentLabel}</span>
          )}
          {item.currentConfidence != null && (
            <span className="ms-auto font-mono text-[11.5px] text-[var(--ink-3)] shrink-0">
              {Math.round(item.currentConfidence * 100)}% confidence
            </span>
          )}
        </div>
      )}

      {/* Notes field */}
      <div className="mb-[4px]">
        <label className="font-mono text-[10.5px] text-[var(--ink-3)] tracking-[0.12em] uppercase block mb-[6px]">
          Notes
          <span className="ms-1 text-[var(--ink-3)] normal-case font-normal tracking-normal">
            (required if blocking, optional otherwise)
          </span>
        </label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="Add context for the review decision…"
          className={cn(
            'w-full px-[12px] py-[10px] rounded-[8px]',
            'border border-[var(--line)] bg-[var(--surface)]',
            'text-[13px] text-[var(--ink)] placeholder:text-[var(--ink-3)]',
            'focus:outline-none focus:border-[var(--ink-3)]',
            'resize-none',
            'transition-colors duration-150',
          )}
        />
        {/* Live char counter — visible when block is the intent */}
        <div className="flex justify-end mt-[4px]">
          <span
            className={cn(
              'font-mono text-[11px] tabular-nums',
              notes.trim().length < 10 && notes.length > 0
                ? 'text-[oklch(0.50_0.18_25)]'
                : 'text-[var(--ink-3)]',
            )}
          >
            {notes.trim().length} / 10 min for block
          </span>
        </div>
      </div>

      {/* Also re-classify toggle */}
      {!showCodePath && item.alternatives.length > 0 && (
        <button
          type="button"
          onClick={onShowCodePath}
          className="mt-[8px] text-[13px] text-[var(--ink-3)] hover:text-[var(--ink)] underline decoration-dotted transition-colors duration-150"
        >
          Also fix the HS code →
        </button>
      )}

      {/* If showCodePath, show the candidate list below the value section */}
      {showCodePath && item.alternatives.length > 0 && (
        <div className="mt-[16px]">
          <div className="font-mono text-[10.5px] text-[var(--ink-3)] tracking-[0.12em] uppercase mb-[10px]">
            Candidates — sorted by similarity
          </div>
          <div className="flex flex-col gap-[8px]">
            {item.alternatives.slice(0, 4).map((alt, i) => (
              <div
                key={alt.code}
                className="px-[14px] py-[12px] rounded-[10px] border border-[var(--line)] bg-[var(--surface)]"
              >
                <div className="flex items-center gap-[10px]">
                  <span className="font-mono text-[10.5px] text-[var(--ink-3)] tabular-nums w-[14px] shrink-0">
                    {i + 1}
                  </span>
                  <span className="font-mono text-[14px] font-medium text-[var(--ink)] tabular-nums">
                    {alt.code}
                  </span>
                  {alt.code === item.currentCode && (
                    <span className="px-[7px] py-[2px] rounded-[4px] bg-[#E0EEF2] text-[#15607A] font-mono text-[9.5px] tracking-[0.10em] uppercase">
                      Current
                    </span>
                  )}
                  {alt.retrieval_score != null && (
                    <span className="ms-auto font-mono text-[11.5px] text-[var(--ink-3)]">
                      {Math.round(alt.retrieval_score * 100)}% match
                    </span>
                  )}
                </div>
                {alt.description_en && (
                  <div className="text-[12.5px] text-[var(--ink-2)] mt-[4px] ms-[24px]">
                    {alt.description_en}
                  </div>
                )}
              </div>
            ))}
          </div>
          <p className="mt-[8px] text-[12px] text-[var(--ink-3)]">
            To override the code, use Reject here and re-open this row from the queue to submit an override decision.
          </p>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// CODE FLAG body — verifier_uncertain / verdict_escalate / low_information
// Reviewer's question: "Is the right HS code in the candidate list?"
// Actions: Approve current · Override (pick candidate or force) · Reject · Block
// ---------------------------------------------------------------------------

function CodeFlagBody({
  item,
  picked,
  setPicked,
}: {
  item: ReviewItem;
  picked: string | null;
  setPicked: (code: string) => void;
}) {
  // Build candidate list from alternatives + current code if not already in set.
  const candidates: AlternativeLine[] = (() => {
    const seen = new Set<string>();
    const list: AlternativeLine[] = [];

    if (item.currentCode) {
      const existsInAlts = item.alternatives.some((a) => a.code === item.currentCode);
      if (!existsInAlts) {
        list.push({
          code: item.currentCode,
          description_en: item.currentLabel ?? null,
          description_ar: null,
          retrieval_score: item.currentConfidence ?? null,
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

  const hasLowConf =
    item.currentConfidence != null && item.currentConfidence < 0.6;

  return (
    <>
      {/* Classification warning banner */}
      <div
        className="grid gap-[14px] items-start px-[16px] py-[14px] rounded-[10px] mb-[16px] bg-[oklch(0.96_0.04_50)] border border-[oklch(0.87_0.09_55)]"
        style={{ gridTemplateColumns: '28px 1fr' }}
      >
        <div className="w-[28px] h-[28px] rounded-full grid place-items-center shrink-0 bg-[var(--accent)] text-white font-mono text-[14px] font-semibold">
          ?
        </div>
        <div>
          <div className="text-[14px] font-medium leading-[1.4] mb-[4px] text-[oklch(0.35_0.14_40)]">
            {hasLowConf ? 'Low confidence classification' : 'Classification needs review'}
          </div>
          <div className="text-[13px] text-[var(--ink-2)] leading-[1.55]">
            {hasLowConf
              ? 'The model returned a top match below the auto-accept threshold. Pick the HS code that best fits the merchant description, or accept the current one.'
              : 'The pipeline flagged this row for human review. Approve the current code, pick a better candidate, or reject if you cannot decide.'}
          </div>
        </div>
      </div>

      <div className="font-mono text-[10.5px] text-[var(--ink-3)] tracking-[0.12em] uppercase mt-[6px] mb-[10px]">
        Top candidates · sorted by similarity
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
// Block confirmation modal
// ---------------------------------------------------------------------------

function BlockConfirmModal({
  item,
  notes,
  onConfirm,
  onCancel,
}: {
  item: ReviewItem;
  notes: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center px-6"
      style={{ background: 'rgba(10,8,5,0.40)' }}
    >
      <div
        className="bg-[var(--surface)] border border-[var(--line)] rounded-[14px] shadow-[0_24px_60px_-20px_rgba(20,15,5,0.36)] w-full max-w-[480px] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-[22px] py-[18px] border-b border-[var(--line-2)]">
          <div className="font-mono text-[10.5px] text-[oklch(0.45_0.14_25)] tracking-[0.12em] uppercase mb-[4px]">
            Destructive action
          </div>
          <h3 className="m-0 text-[17px] font-medium text-[var(--ink)]">
            Block from submission?
          </h3>
        </div>
        <div className="px-[22px] py-[18px] flex flex-col gap-[12px]">
          <p className="m-0 text-[13.5px] text-[var(--ink-2)] leading-[1.6]">
            This row will{' '}
            <span className="font-medium text-[var(--ink)]">not be filed with customs</span>.
            It will be marked blocked and excluded from the declaration XML.
            <span className="ms-1 font-medium text-[oklch(0.45_0.14_25)]">
              This action cannot be undone.
            </span>
          </p>
          <div className="rounded-[8px] bg-[var(--line-2)] border border-[var(--line)] px-[14px] py-[12px] flex flex-col gap-[6px]">
            <div className="text-[12.5px] text-[var(--ink-2)] leading-[1.4]">
              {item.description || '—'}
            </div>
            {item.currentCode && (
              <div className="font-mono text-[12px] text-[var(--accent-ink)]">{item.currentCode}</div>
            )}
            {notes.trim() && (
              <div className="text-[12px] text-[var(--ink-3)] mt-[2px] italic">
                "{notes.trim()}"
              </div>
            )}
          </div>
        </div>
        <div className="flex justify-end gap-[8px] px-[22px] py-[14px] border-t border-[var(--line-2)] bg-[var(--line-2)]">
          <button
            type="button"
            onClick={onCancel}
            className={cn(
              'px-[14px] py-[9px] rounded-[8px] text-[13px]',
              'border border-[var(--line)] bg-[var(--surface)] text-[var(--ink-2)]',
              'hover:border-[var(--ink-3)] hover:text-[var(--ink)] transition-all duration-150',
            )}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={cn(
              'px-[14px] py-[9px] rounded-[8px] text-[13px] font-medium',
              'bg-[oklch(0.50_0.18_25)] text-white border border-[oklch(0.50_0.18_25)]',
              'hover:brightness-110 transition-all duration-150',
            )}
          >
            Block from submission
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal inner — orchestrates both flag-type views
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
  onBlock,
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
  onBlock: (item: ReviewItem, notes: string) => void;
  onClose: () => void;
}) {
  const t = useT();

  // Determine flag type: 'value' for sanity_flag, 'code' for everything else.
  // item.flagType is 'hs' (legacy code-flag) or 'value' (sanity_flag).
  const isValueFlag = item.flagType === 'value';

  // Candidate picked state (used in code-flag view).
  const [picked, setPicked] = useState<string | null>(() =>
    isValueFlag ? null : (item.currentCode ?? item.alternatives[0]?.code ?? null),
  );

  // Notes state (shared — required for block, optional elsewhere).
  const [notes, setNotes] = useState('');

  // For value-flag: show the candidate list when reviewer clicks "Also fix the code".
  const [showCodePath, setShowCodePath] = useState(false);

  // Block confirmation modal visibility.
  const [blockConfirmOpen, setBlockConfirmOpen] = useState(false);

  // Reset state when the item changes.
  useEffect(() => {
    const isVal = item.flagType === 'value';
    setPicked(isVal ? null : (item.currentCode ?? item.alternatives[0]?.code ?? null));
    setNotes('');
    setShowCodePath(false);
    setBlockConfirmOpen(false);
  }, [item.id, item.flagType, item.currentCode, item.alternatives]);

  const hasQueue = queueLength != null && queueIndex != null;
  const isFirst = hasQueue && queueIndex === 0;
  const isCurrentPicked = !isValueFlag && picked === item.currentCode;

  const progressPct =
    hasQueue && queueLength > 0
      ? Math.round(((queueIndex! + 1) / queueLength) * 100)
      : 0;

  const handleAccept = useCallback(() => onAccept(item), [onAccept, item]);

  const handleApply = useCallback(() => {
    if (picked && picked !== item.currentCode) onPick(item, picked);
  }, [onPick, item, picked]);

  const handleDismiss = useCallback(() => onDismiss(item), [onDismiss, item]);

  const handleBlock = useCallback(() => {
    if (notes.trim().length < 10) return;
    onBlock(item, notes.trim());
    setBlockConfirmOpen(false);
  }, [onBlock, item, notes]);

  const handleSkip = useCallback(() => onSkip?.(), [onSkip]);
  const handlePrev = useCallback(() => onPrev?.(), [onPrev]);
  const handleNext = useCallback(() => onNext?.(), [onNext]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (blockConfirmOpen) { setBlockConfirmOpen(false); return; }
        onClose();
        return;
      }
      if (e.key === 'ArrowRight') { e.preventDefault(); handleNext(); return; }
      if (e.key === 'ArrowLeft')  { e.preventDefault(); handlePrev(); return; }
      if (!isValueFlag) {
        const n = parseInt(e.key, 10);
        if (n >= 1 && n <= 4) {
          const seen = new Set<string>();
          const cands: AlternativeLine[] = [];
          if (item.currentCode) {
            const inAlts = item.alternatives.some((a) => a.code === item.currentCode);
            if (!inAlts) {
              cands.push({ code: item.currentCode, description_en: item.currentLabel ?? null, description_ar: null, retrieval_score: item.currentConfidence ?? null });
              seen.add(item.currentCode);
            }
          }
          for (const alt of item.alternatives) {
            if (!seen.has(alt.code) && cands.length < 4) { cands.push(alt); seen.add(alt.code); }
          }
          const target = cands[n - 1];
          if (target) setPicked(target.code);
          return;
        }
        if (e.key === 'Enter') {
          if (isCurrentPicked) handleAccept();
          else if (picked) handleApply();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isValueFlag, isCurrentPicked, picked, handleAccept, handleApply, handleNext, handlePrev, onClose, item, blockConfirmOpen]);

  const breadcrumb = isValueFlag
    ? `${t('review_queue_label' as TKey)} · Value review`
    : `${t('review_queue_label' as TKey)} · HS classification`;

  const title = isValueFlag
    ? 'Review declared value'
    : t('review_title_hs' as TKey);

  const candidateCount = !isValueFlag
    ? Math.min(4,
        item.alternatives.length +
        (item.currentCode && !item.alternatives.some((a) => a.code === item.currentCode) ? 1 : 0),
      )
    : 0;

  return (
    <div className="flex flex-col" style={{ width: 'min(820px, 100%)', maxHeight: 'calc(100vh - 48px)' }}>

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

        {isValueFlag ? (
          <ValueFlagBody
            item={item}
            notes={notes}
            setNotes={setNotes}
            showCodePath={showCodePath}
            onShowCodePath={() => setShowCodePath(true)}
          />
        ) : (
          <CodeFlagBody item={item} picked={picked} setPicked={setPicked} />
        )}
      </div>

      {/* Footer */}
      <div className="flex justify-between items-center gap-[14px] flex-wrap px-[22px] py-[14px] border-t border-[var(--line)] bg-[var(--line-2)] shrink-0">
        {/* Keyboard hint */}
        <div className="flex gap-[14px] font-mono text-[10.5px] text-[var(--ink-3)] tracking-[0.04em] flex-wrap">
          {!isValueFlag && candidateCount > 0 && (
            <span className="inline-flex items-center gap-[5px]">
              <kbd className="inline-block px-[6px] py-[2px] rounded-[4px] bg-[var(--surface)] border border-[var(--line)] font-mono text-[10px] text-[var(--ink-2)] shadow-[0_1px_0_var(--line)] min-w-[14px] text-center">1</kbd>
              –
              <kbd className="inline-block px-[6px] py-[2px] rounded-[4px] bg-[var(--surface)] border border-[var(--line)] font-mono text-[10px] text-[var(--ink-2)] shadow-[0_1px_0_var(--line)] min-w-[14px] text-center">{candidateCount}</kbd>
              {t('review_kbd_pick' as TKey)}
            </span>
          )}
          <span className="inline-flex items-center gap-[5px]">
            <kbd className="inline-block px-[6px] py-[2px] rounded-[4px] bg-[var(--surface)] border border-[var(--line)] font-mono text-[10px] text-[var(--ink-2)] shadow-[0_1px_0_var(--line)] min-w-[14px] text-center">→</kbd>
            {t('review_kbd_next' as TKey)}
          </span>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-[8px] flex-wrap">
          {/* Prev */}
          {hasQueue && (
            <button
              type="button"
              onClick={handlePrev}
              disabled={isFirst}
              className={cn(
                'inline-flex items-center gap-[7px] px-[14px] py-[9px] rounded-[8px]',
                'border border-[var(--line)] bg-[var(--surface)] text-[13px] text-[var(--ink-2)]',
                'hover:not-disabled:border-[var(--ink-3)] hover:not-disabled:text-[var(--ink)]',
                'transition-all duration-150 disabled:opacity-45 disabled:cursor-not-allowed',
              )}
            >
              ← {t('review_action_prev' as TKey)}
            </button>
          )}

          {/* Skip */}
          <button
            type="button"
            onClick={handleSkip}
            className={cn(
              'inline-flex items-center gap-[7px] px-[14px] py-[9px] rounded-[8px]',
              'border border-[var(--line)] bg-[var(--surface)] text-[13px] text-[var(--ink-2)]',
              'hover:border-[var(--ink-3)] hover:text-[var(--ink)] transition-all duration-150',
            )}
          >
            {t('review_action_skip' as TKey)}
          </button>

          {/* Reject */}
          <button
            type="button"
            onClick={handleDismiss}
            className={cn(
              'inline-flex items-center gap-[7px] px-[14px] py-[9px] rounded-[8px]',
              'border border-[var(--line)] bg-[var(--surface)] text-[13px] text-[var(--ink-2)]',
              'hover:border-[var(--ink-3)] hover:text-[var(--ink)] transition-all duration-150',
            )}
          >
            Reject
          </button>

          {isValueFlag ? (
            <>
              {/* Block from submission */}
              <button
                type="button"
                onClick={() => {
                  if (notes.trim().length < 10) return;
                  setBlockConfirmOpen(true);
                }}
                disabled={notes.trim().length < 10}
                title={notes.trim().length < 10 ? 'Add a note (10+ chars) before blocking' : 'Block this row from the declaration XML'}
                className={cn(
                  'inline-flex items-center gap-[7px] px-[14px] py-[9px] rounded-[8px]',
                  'border bg-[var(--surface)] text-[13px]',
                  'border-[oklch(0.82_0.06_25)] text-[oklch(0.40_0.14_25)]',
                  'hover:not-disabled:bg-[oklch(0.96_0.03_25)] hover:not-disabled:border-[oklch(0.55_0.15_25)]',
                  'transition-all duration-150',
                  'disabled:opacity-40 disabled:cursor-not-allowed',
                )}
              >
                Block from submission
              </button>
              {/* Approve */}
              <button
                type="button"
                onClick={handleAccept}
                className={cn(
                  'inline-flex items-center gap-[7px] px-[14px] py-[9px] rounded-[8px]',
                  'bg-[var(--accent)] text-white border border-[var(--accent)]',
                  'text-[13px] font-medium hover:brightness-110 transition-all duration-150',
                )}
              >
                Approve value
              </button>
            </>
          ) : (
            <>
              {/* Override — apply selected candidate (only when a non-current code is picked) */}
              <button
                type="button"
                onClick={handleApply}
                disabled={isCurrentPicked || !picked}
                title={isCurrentPicked ? 'Pick a different code to override' : 'Apply selected code as override'}
                className={cn(
                  'inline-flex items-center gap-[7px] px-[14px] py-[9px] rounded-[8px]',
                  'border border-[var(--line)] bg-[var(--surface)] text-[13px] text-[var(--ink-2)]',
                  'hover:not-disabled:border-[var(--ink-3)] hover:not-disabled:text-[var(--ink)]',
                  'transition-all duration-150 disabled:opacity-45 disabled:cursor-not-allowed',
                )}
              >
                {t('review_action_apply' as TKey)}
              </button>
              {/* Block from submission */}
              <button
                type="button"
                onClick={() => setBlockConfirmOpen(true)}
                className={cn(
                  'inline-flex items-center gap-[7px] px-[14px] py-[9px] rounded-[8px]',
                  'border bg-[var(--surface)] text-[13px]',
                  'border-[oklch(0.82_0.06_25)] text-[oklch(0.40_0.14_25)]',
                  'hover:bg-[oklch(0.96_0.03_25)] hover:border-[oklch(0.55_0.15_25)]',
                  'transition-all duration-150',
                )}
              >
                Block
              </button>
              {/* Approve current */}
              <button
                type="button"
                onClick={handleAccept}
                className={cn(
                  'inline-flex items-center gap-[7px] px-[14px] py-[9px] rounded-[8px]',
                  'bg-[var(--accent)] text-white border border-[var(--accent)]',
                  'text-[13px] font-medium hover:brightness-110 transition-all duration-150',
                )}
              >
                {t('review_action_accept_resolved' as TKey)}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Block confirmation modal — mounted inside the dialog's stacking context */}
      {blockConfirmOpen && (
        <BlockConfirmModal
          item={item}
          notes={notes}
          onConfirm={handleBlock}
          onCancel={() => setBlockConfirmOpen(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Exported dialog shell — mounted via React Portal on document.body so
// it is fully independent of any scrollable table container.
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
  onBlock,
}: ReviewDialogProps) {
  const handleClose = useCallback(() => onOpenChange(false), [onOpenChange]);

  // Only render when we have something to show.
  if (!open && !item) return null;

  const overlay = (
    <div
      role="presentation"
      className={cn(
        'fixed inset-0 z-[90] overflow-y-auto',
        'flex justify-center items-start pt-[80px] pb-8 px-6',
        'bg-black/[0.12]',
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
          'shadow-[0_24px_60px_-20px_rgba(20,15,5,0.28),0_2px_4px_rgba(20,15,5,0.06)]',
          'overflow-hidden flex flex-col w-full',
          'transition-transform duration-[250ms]',
          open ? 'translate-y-0 scale-100' : 'translate-y-2 scale-[0.985]',
        )}
        style={{ maxWidth: '820px', maxHeight: 'calc(100vh - 120px)', overflow: 'hidden' }}
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
            onBlock={onBlock}
            onClose={handleClose}
          />
        ) : null}
      </div>
    </div>
  );

  // createPortal ensures the overlay is a sibling of <body> children,
  // not a descendant of the batch table's scroll container. This makes
  // `fixed` positioning work correctly regardless of any ancestor
  // `transform`, `overflow`, or `will-change` CSS.
  if (typeof document === 'undefined') return null;
  return createPortal(overlay, document.body);
}
