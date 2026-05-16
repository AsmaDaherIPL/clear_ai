/**
 * ReviewDialog — sanity-FLAG value review modal.
 *
 * Shown when the sanity stage flagged a row's declared value as implausible
 * (sanity.verdict === "FLAG"). The reviewer answers one question:
 * "Do you trust the merchant's declared value?"
 *   - Approve → PATCH { decision: 'approve' }
 *   - Block   → PATCH { decision: 'block_from_submission', reviewer_notes }
 *
 * No HS-code candidates, no override picker. That is intentional — sanity
 * never questions the code, only the value. If the code also needs fixing
 * the operator uses the standalone /review page.
 *
 * Mounted via React Portal on document.body so fixed positioning is
 * independent of any ancestor overflow/transform on the batch table.
 * Body scroll is locked while the dialog is open.
 *
 * RTL: all spacing uses logical CSS (ps/pe/ms/me). No ml/mr/pl/pr.
 * No emojis. No coloured side-borders.
 */
import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ReviewItem {
  /** hitl_queue.id — PATCH target */
  id: string;
  description: string;
  merchantCode?: string | null;
  lineNumber?: number | null;
  value?: { amount: number; currency: string } | null;
  currentCode: string | null;
  currentLabel?: string | null;
  currentConfidence?: number | null;
  verdict?: string | null;
  /** Preserved so callers don't break — ignored in this component */
  flagType?: 'hs' | 'value' | null;
  /** Sanity rationale from current_sanity_rationale */
  sanityRationale?: string | null;
  alternatives: import('@/lib/api').AlternativeLine[];
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
  // Close on Escape
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center px-6"
      style={{ background: 'rgba(10,8,5,0.45)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
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
            Flag this declared value?
          </h3>
        </div>
        <div className="px-[22px] py-[18px] flex flex-col gap-[12px]">
          <p className="m-0 text-[13.5px] text-[var(--ink-2)] leading-[1.6]">
            This row will be{' '}
            <span className="font-medium text-[var(--ink)]">blocked from customs submission</span>{' '}
            and excluded from the declaration XML.{' '}
            <span className="font-medium text-[oklch(0.45_0.14_25)]">Cannot be undone.</span>
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
            Flag declared value
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialog inner
// ---------------------------------------------------------------------------

function DialogInner({
  item,
  queueLength,
  queueIndex,
  reviewedCount,
  onPrev,
  onNext,
  onSkip,
  onAccept,
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
  onBlock: (item: ReviewItem, notes: string) => void;
  onClose: () => void;
}) {
  const [notes, setNotes] = useState('');
  const [blockConfirmOpen, setBlockConfirmOpen] = useState(false);

  // Reset when item changes
  useEffect(() => {
    setNotes('');
    setBlockConfirmOpen(false);
  }, [item.id]);

  const canBlock = notes.trim().length >= 10;

  const hasQueue = queueLength != null && queueIndex != null;
  const isFirst = hasQueue && queueIndex === 0;
  const progressPct =
    hasQueue && queueLength > 0
      ? Math.round(((queueIndex! + 1) / queueLength) * 100)
      : 0;

  const handleAccept = useCallback(() => onAccept(item), [onAccept, item]);
  const handleConfirmBlock = useCallback(() => {
    onBlock(item, notes.trim());
    setBlockConfirmOpen(false);
  }, [onBlock, item, notes]);

  // Keyboard: Esc closes confirm modal first, then dialog; → next; ← prev
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (blockConfirmOpen) { setBlockConfirmOpen(false); return; }
        onClose();
      }
      if (e.key === 'ArrowRight') { e.preventDefault(); onNext?.(); }
      if (e.key === 'ArrowLeft')  { e.preventDefault(); onPrev?.(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [blockConfirmOpen, onClose, onNext, onPrev]);

  const fmtValue = item.value ? fmtAmount(item.value.amount) : null;

  return (
    <>
      <div className="flex flex-col" style={{ width: 'min(680px, 100%)', maxHeight: 'calc(100vh - 96px)' }}>

        {/* ── Header ── */}
        <div className="flex justify-between items-start gap-[14px] px-[22px] py-[18px] border-b border-[var(--line-2)] shrink-0">
          <div>
            <div className="font-mono text-[10.5px] text-[var(--ink-3)] tracking-[0.12em] uppercase">
              Review queue · Value check
            </div>
            <h3 className="mt-[6px] text-[18px] font-medium tracking-[-0.01em] text-[var(--ink)] m-0">
              Review declared value
            </h3>
          </div>
          <div className="flex items-center gap-[14px] shrink-0">
            {hasQueue && (
              <div className="flex flex-col items-end gap-[6px]">
                <div className="font-mono text-[11.5px] text-[var(--ink-3)] tabular-nums">
                  <span className="font-medium text-[var(--ink)]">{queueIndex! + 1}</span>
                  {' '}of{' '}{queueLength}
                  {reviewedCount != null && reviewedCount > 0 && (
                    <span className="ms-1">· {reviewedCount} reviewed</span>
                  )}
                </div>
                <div className="w-[120px] h-[3px] bg-[var(--line-2)] rounded-full overflow-hidden">
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
                'w-[32px] h-[32px] rounded-[8px] grid place-items-center shrink-0',
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

        {/* ── Scrollable body ── */}
        <div className="px-[22px] py-[20px] overflow-y-auto flex-1 flex flex-col gap-[16px]">

          {/* Item strip */}
          <div className="px-[16px] py-[14px] bg-[var(--line-2)] border border-[var(--line)] rounded-[10px]">
            <div className="text-[14.5px] text-[var(--ink)] leading-[1.5] break-words">
              {item.description || '—'}
            </div>
            {item.merchantCode && (
              <div className="font-mono text-[11.5px] text-[var(--ink-3)] mt-[4px]">
                Merchant code: {item.merchantCode}
              </div>
            )}
          </div>

          {/* Value vs pipeline code */}
          <div
            className="grid gap-[1px] rounded-[10px] overflow-hidden border border-[var(--line)]"
            style={{ gridTemplateColumns: '1fr 1fr' }}
          >
            <div className="px-[16px] py-[14px] bg-[var(--surface)]">
              <div className="font-mono text-[10px] text-[var(--ink-3)] tracking-[0.12em] uppercase mb-[6px]">
                Declared value
              </div>
              {fmtValue ? (
                <div className="font-mono text-[22px] font-medium tabular-nums text-[#A3590F] leading-none">
                  {fmtValue}
                  <span className="ms-2 text-[11px] text-[var(--ink-3)] tracking-[0.08em] font-normal">
                    {item.value?.currency}
                  </span>
                </div>
              ) : (
                <div className="text-[14px] text-[var(--ink-3)]">—</div>
              )}
            </div>
            <div className="px-[16px] py-[14px] bg-[var(--surface)] border-s border-[var(--line)]">
              <div className="font-mono text-[10px] text-[var(--ink-3)] tracking-[0.12em] uppercase mb-[6px]">
                Pipeline code
              </div>
              {item.currentCode ? (
                <>
                  <div className="font-mono text-[17px] font-medium tabular-nums text-[var(--accent-ink)] leading-none">
                    {item.currentCode}
                  </div>
                  {item.currentLabel && (
                    <div className="text-[12px] text-[var(--ink-2)] mt-[4px] leading-[1.4]">
                      {item.currentLabel}
                    </div>
                  )}
                  {item.currentConfidence != null && (
                    <div className="font-mono text-[11px] text-[var(--ink-3)] mt-[4px]">
                      {Math.round(item.currentConfidence * 100)}% confidence
                    </div>
                  )}
                </>
              ) : (
                <div className="text-[14px] text-[var(--ink-3)]">—</div>
              )}
            </div>
          </div>

          {/* Sanity rationale banner */}
          <div className="flex gap-[12px] items-start px-[16px] py-[14px] bg-[#FDF1DC] border border-[#ECC679] rounded-[10px]">
            <div className="w-[26px] h-[26px] rounded-full grid place-items-center shrink-0 bg-[#C68A1B] text-white font-mono text-[13px] font-semibold mt-[1px]">
              !
            </div>
            <div>
              <div className="text-[13.5px] font-medium text-[#7A4E11] mb-[4px]">
                Sanity check flagged this value
              </div>
              <div className="text-[13px] text-[var(--ink-2)] leading-[1.6]">
                {item.sanityRationale ?? 'The declared value is outside the expected range for this product type.'}
              </div>
            </div>
          </div>

          {/* Notes */}
          <div>
            <label className="font-mono text-[10.5px] text-[var(--ink-3)] tracking-[0.12em] uppercase block mb-[6px]">
              Notes
              <span className="ms-1 normal-case font-normal tracking-normal text-[var(--ink-3)]">
                — required if flagging (10+ chars)
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
                'resize-none transition-colors duration-150',
              )}
            />
            <div className="flex justify-end mt-[4px]">
              <span className={cn(
                'font-mono text-[11px] tabular-nums',
                notes.length > 0 && !canBlock ? 'text-[oklch(0.50_0.18_25)]' : 'text-[var(--ink-3)]',
              )}>
                {notes.trim().length} / 10 min for flag
              </span>
            </div>
          </div>
        </div>

        {/* ── Footer ── */}
        <div className="flex justify-between items-center gap-[10px] flex-wrap px-[22px] py-[14px] border-t border-[var(--line)] bg-[var(--line-2)] shrink-0">
          {/* Prev/Skip nav */}
          <div className="flex items-center gap-[8px]">
            {hasQueue && (
              <button
                type="button"
                onClick={onPrev}
                disabled={isFirst}
                className={cn(
                  'px-[12px] py-[8px] rounded-[8px] text-[13px]',
                  'border border-[var(--line)] bg-[var(--surface)] text-[var(--ink-2)]',
                  'hover:not-disabled:border-[var(--ink-3)] hover:not-disabled:text-[var(--ink)]',
                  'transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed',
                )}
              >
                ← Prev
              </button>
            )}
            <button
              type="button"
              onClick={onSkip}
              className={cn(
                'px-[12px] py-[8px] rounded-[8px] text-[13px]',
                'border border-[var(--line)] bg-[var(--surface)] text-[var(--ink-2)]',
                'hover:border-[var(--ink-3)] hover:text-[var(--ink)] transition-all duration-150',
              )}
            >
              Skip
            </button>
          </div>

          {/* Decision buttons */}
          <div className="flex items-center gap-[8px]">
            <button
              type="button"
              onClick={() => {
                if (!canBlock) return;
                setBlockConfirmOpen(true);
              }}
              disabled={!canBlock}
              title={!canBlock ? 'Add a note (10+ chars) to flag the value' : undefined}
              className={cn(
                'px-[14px] py-[9px] rounded-[8px] text-[13px]',
                'border bg-[var(--surface)]',
                'border-[oklch(0.82_0.06_25)] text-[oklch(0.40_0.14_25)]',
                'hover:not-disabled:bg-[oklch(0.96_0.03_25)] hover:not-disabled:border-[oklch(0.55_0.15_25)]',
                'transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed',
              )}
            >
              Flag declared value
            </button>
            <button
              type="button"
              onClick={handleAccept}
              className={cn(
                'px-[16px] py-[9px] rounded-[8px] text-[13px] font-medium',
                'bg-[var(--accent)] text-white border border-[var(--accent)]',
                'hover:brightness-110 transition-all duration-150',
              )}
            >
              Accept, remove flag
            </button>
          </div>
        </div>
      </div>

      {blockConfirmOpen && (
        <BlockConfirmModal
          item={item}
          notes={notes}
          onConfirm={handleConfirmBlock}
          onCancel={() => setBlockConfirmOpen(false)}
        />
      )}
    </>
  );
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
  onNext,
  onSkip,
  onAccept,
  onBlock,
}: ReviewDialogProps) {
  const handleClose = useCallback(() => onOpenChange(false), [onOpenChange]);

  // Lock body scroll while open so the table behind can't scroll
  useEffect(() => {
    if (open) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = prev; };
    }
  }, [open]);

  if (typeof document === 'undefined') return null;
  if (!open && !item) return null;

  const overlay = (
    <div
      role="presentation"
      className={cn(
        'fixed inset-0 z-[90] overflow-y-auto',
        'flex justify-center items-start pt-[72px] pb-8 px-4',
        'bg-black/[0.15]',
        'transition-opacity duration-200',
        open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none',
      )}
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Review declared value"
        className={cn(
          'bg-[var(--surface)] border border-[var(--line)] rounded-[16px]',
          'shadow-[0_24px_60px_-20px_rgba(20,15,5,0.28),0_2px_4px_rgba(20,15,5,0.06)]',
          'overflow-hidden flex flex-col w-full',
          'transition-transform duration-[250ms]',
          open ? 'translate-y-0 scale-100' : 'translate-y-2 scale-[0.985]',
        )}
        style={{ maxWidth: '680px', maxHeight: 'calc(100vh - 96px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {item && (
          <DialogInner
            item={item}
            queueLength={queueLength}
            queueIndex={queueIndex}
            reviewedCount={reviewedCount}
            onPrev={onPrev}
            onNext={onNext}
            onSkip={onSkip}
            onAccept={onAccept}
            onBlock={onBlock}
            onClose={handleClose}
          />
        )}
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
