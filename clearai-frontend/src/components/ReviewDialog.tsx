/**
 * ReviewDialog — operator decision modal for a single classification item.
 *
 * Three actions:
 *   Accept   — confirm the current AI classification as correct
 *   Dismiss  — reject/flag the item for manual handling
 *   Pick     — choose one of the candidate alternatives as the final code
 *
 * All callbacks are no-ops that surface as console.log stubs until the
 * backend review endpoint is wired in. The dialog is fully self-contained;
 * callers open it by setting `open={true}` and providing `item` data.
 *
 * RTL: all spacing uses logical properties (ps/pe/ms/me). No ml/mr/pl/pr.
 */
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { useT, type TKey } from '@/lib/i18n';
import type { AlternativeLine } from '@/lib/api';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

// ---------------------------------------------------------------------------
// Public item shape — narrow slice the dialog actually needs.
// Both DeclarationRunItem (batch) and DescribeResponse.result (single-shot)
// can be adapted to this interface by the caller.
// ---------------------------------------------------------------------------

export interface ReviewItem {
  /** Line identifier (row_index for batch, request_id for single-shot). */
  id: string;
  /** Human-readable description of the item being reviewed. */
  description: string;
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
  /** Candidate alternatives the picker considered. */
  alternatives: AlternativeLine[];
}

export interface ReviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: ReviewItem | null;
  /** Called when the operator accepts the current code as correct. */
  onAccept: (item: ReviewItem) => void;
  /** Called when the operator dismisses / rejects the item. */
  onDismiss: (item: ReviewItem) => void;
  /** Called when the operator picks a different candidate code. */
  onPick: (item: ReviewItem, chosenCode: string) => void;
}

// ---------------------------------------------------------------------------
// Verdict badge colour map — mirrors BatchResultsTable's VERDICT_BADGE.
// ---------------------------------------------------------------------------

const VERDICT_STYLE: Record<string, string> = {
  pass:    'bg-[oklch(0.92_0.06_140)] text-[oklch(0.30_0.10_140)]',
  flag:    'bg-[oklch(0.93_0.10_60)]  text-[oklch(0.40_0.15_60)]',
  block:   'bg-[oklch(0.92_0.07_25)]  text-[oklch(0.40_0.12_25)]',
  unknown: 'bg-[var(--line-2)] text-[var(--ink-3)]',
};

function verdictBucketFor(raw: string | null | undefined): string {
  if (!raw) return 'unknown';
  const lc = raw.toLowerCase();
  if (lc === 'pass') return 'pass';
  if (lc === 'flag' || lc === 'warn') return 'flag';
  if (lc === 'block' || lc === 'fail') return 'block';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Candidate row
// ---------------------------------------------------------------------------

function CandidateRow({
  alt,
  index,
  currentCode,
  selected,
  onSelect,
}: {
  alt: AlternativeLine;
  index: number;
  currentCode: string | null;
  selected: boolean;
  onSelect: () => void;
}) {
  const isCurrent = alt.code === currentCode;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'w-full text-start flex items-start gap-3.5 px-4 py-3 rounded-[var(--radius)] border transition-all duration-150',
        selected
          ? 'border-[var(--accent)] bg-[oklch(0.97_0.03_220_/_0.5)]'
          : 'border-[var(--line)] bg-[var(--surface)] hover:border-[var(--ink-3)] hover:bg-[var(--line-2)]',
      )}
    >
      {/* Rank */}
      <span className="font-mono text-[11.5px] text-[var(--ink-3)] w-5 flex-shrink-0 pt-[3px] tabular-nums">
        {index + 1}
      </span>

      {/* Code + descriptions */}
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={cn(
              'font-mono text-[14px] font-semibold leading-none',
              selected ? 'text-[var(--accent)]' : 'text-[var(--ink)]',
            )}
          >
            {alt.code}
          </span>
          {isCurrent && (
            <span className="font-mono text-[9.5px] uppercase tracking-[0.10em] px-1.5 py-0.5 rounded bg-[var(--line-2)] text-[var(--ink-3)]">
              current
            </span>
          )}
          {alt.fit && alt.fit !== 'does_not_fit' && (
            <span
              className={cn(
                'font-mono text-[9.5px] uppercase tracking-[0.08em] px-1.5 py-0.5 rounded',
                alt.fit === 'fits'
                  ? 'bg-[oklch(0.92_0.06_140)] text-[oklch(0.30_0.10_140)]'
                  : 'bg-[oklch(0.93_0.10_60)] text-[oklch(0.40_0.15_60)]',
              )}
            >
              {alt.fit}
            </span>
          )}
          {alt.source_arm && (
            <span
              className="font-mono text-[9.5px] uppercase tracking-[0.08em] px-1.5 py-0.5 rounded bg-[var(--line-2)] text-[var(--ink-3)]"
              title="Which retrieval arm surfaced this candidate"
            >
              {alt.source_arm.replace('_', ' ')}
            </span>
          )}
        </div>
        {alt.description_en && (
          <span className="text-[12.5px] text-[var(--ink-2)] leading-[1.45]">
            {alt.description_en}
          </span>
        )}
        {alt.description_ar && (
          <span
            dir="rtl"
            lang="ar"
            className="text-[12.5px] text-[var(--ink-3)] leading-[1.5] block text-end"
            style={{ fontFamily: "'IBM Plex Sans Arabic', sans-serif" }}
          >
            {alt.description_ar}
          </span>
        )}
        {alt.reason && (
          <span className="text-[11.5px] text-[var(--ink-3)] leading-[1.4] italic">
            {alt.reason}
          </span>
        )}
      </div>

      {/* Selection indicator */}
      <span
        className={cn(
          'flex-shrink-0 mt-[3px] w-4 h-4 rounded-full border-2 transition-colors duration-150',
          selected
            ? 'border-[var(--accent)] bg-[var(--accent)]'
            : 'border-[var(--line)] bg-transparent',
        )}
        aria-hidden
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Dialog body
// ---------------------------------------------------------------------------

function ReviewDialogBody({
  item,
  onAccept,
  onDismiss,
  onPick,
  onClose,
}: {
  item: ReviewItem;
  onAccept: () => void;
  onDismiss: () => void;
  onPick: (code: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [selectedCode, setSelectedCode] = useState<string | null>(null);

  // Build the candidate list: current code (if present) first, then alternatives.
  // Dedupe by code so the current code doesn't appear twice if it's also in alternatives[].
  const seenCodes = new Set<string>();
  const candidateList: AlternativeLine[] = [];

  if (item.currentCode) {
    const currentAsAlt: AlternativeLine = {
      code: item.currentCode,
      description_en: item.currentLabel ?? null,
      description_ar: null,
      retrieval_score: null,
    };
    candidateList.push(currentAsAlt);
    seenCodes.add(item.currentCode);
  }

  for (const alt of item.alternatives) {
    if (!seenCodes.has(alt.code)) {
      candidateList.push(alt);
      seenCodes.add(alt.code);
    }
  }

  const verdictBucket = verdictBucketFor(item.verdict);
  const verdictStyle = VERDICT_STYLE[verdictBucket] ?? VERDICT_STYLE.unknown;

  const handlePickConfirm = () => {
    if (!selectedCode) return;
    onPick(selectedCode);
  };

  return (
    <div className="flex flex-col gap-5">
      {/* ── Item summary ─────────────────────────────────────────── */}
      <div className="flex flex-col gap-2 p-4 rounded-[var(--radius)] bg-[var(--line-2)] border border-[var(--line)]">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex-1 min-w-0">
            <div className="font-mono text-[10.5px] text-[var(--ink-3)] tracking-[0.08em] uppercase mb-1">
              {t('review_item_description' as TKey)}
            </div>
            <div className="text-[13.5px] text-[var(--ink)] leading-[1.5] break-words">
              {item.description || '—'}
            </div>
          </div>
          {item.verdict && (
            <span
              className={cn(
                'inline-flex items-center px-2 py-0.5 rounded-full font-mono text-[10px] uppercase tracking-[0.08em] flex-shrink-0',
                verdictStyle,
              )}
            >
              {item.verdict.toLowerCase()}
            </span>
          )}
        </div>

        {item.currentCode && (
          <div className="pt-2 mt-1 border-t border-[var(--line)]">
            <div className="font-mono text-[10.5px] text-[var(--ink-3)] tracking-[0.08em] uppercase mb-1">
              {t('review_current_code' as TKey)}
            </div>
            <span className="font-mono text-[15px] font-semibold text-[var(--accent)] tabular-nums">
              {item.currentCode}
            </span>
            {item.currentLabel && (
              <span className="ms-2 text-[12.5px] text-[var(--ink-2)]">{item.currentLabel}</span>
            )}
          </div>
        )}

        {!item.currentCode && (
          <div className="pt-2 mt-1 border-t border-[var(--line)]">
            <span className="font-mono text-[11px] text-[var(--ink-3)] uppercase tracking-[0.06em]">
              {t('review_no_code' as TKey)}
            </span>
          </div>
        )}
      </div>

      {/* ── Candidate picker ─────────────────────────────────────── */}
      {candidateList.length > 0 && (
        <div>
          <div className="font-mono text-[10.5px] text-[var(--ink-3)] tracking-[0.08em] uppercase mb-2">
            {t('review_candidates_label' as TKey)}
          </div>
          <div className="flex flex-col gap-1.5 max-h-[280px] overflow-y-auto pe-1">
            {candidateList.map((alt, i) => (
              <CandidateRow
                key={`${alt.code}-${i}`}
                alt={alt}
                index={i}
                currentCode={item.currentCode}
                selected={selectedCode === alt.code}
                onSelect={() =>
                  setSelectedCode((prev) => (prev === alt.code ? null : alt.code))
                }
              />
            ))}
          </div>
        </div>
      )}

      {/* ── Actions ──────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3 pt-2 border-t border-[var(--line-2)] flex-wrap">
        {/* Dismiss — left-anchored, destructive-toned ghost */}
        <button
          type="button"
          onClick={() => { onDismiss(); onClose(); }}
          className={cn(
            'inline-flex items-center gap-1.5 px-4 py-2 rounded-md',
            'border border-[var(--line)] bg-[var(--surface)]',
            'font-mono text-[11.5px] font-medium tracking-[0.06em] uppercase',
            'text-[oklch(0.45_0.13_25)] hover:border-[oklch(0.65_0.15_25)] hover:bg-[oklch(0.97_0.02_25)]',
            'transition-colors duration-150',
          )}
        >
          {t('review_action_dismiss' as TKey)}
        </button>

        {/* Right group: Pick / Accept */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Accept current code */}
          <button
            type="button"
            onClick={() => { onAccept(); onClose(); }}
            disabled={!item.currentCode}
            className={cn(
              'inline-flex items-center gap-1.5 px-4 py-2 rounded-md',
              'border border-[var(--line)] bg-[var(--surface)]',
              'font-mono text-[11.5px] font-medium tracking-[0.06em] uppercase',
              'text-[var(--ink-2)] hover:border-[var(--ink-3)] hover:text-[var(--ink)]',
              'transition-colors duration-150',
              'disabled:opacity-40 disabled:cursor-not-allowed',
            )}
          >
            {t('review_action_accept' as TKey)}
          </button>

          {/* Pick selected candidate — primary CTA */}
          <button
            type="button"
            onClick={handlePickConfirm}
            disabled={!selectedCode || selectedCode === item.currentCode}
            className={cn(
              'inline-flex items-center gap-1.5 px-5 py-2 rounded-md',
              'font-mono text-[11.5px] font-semibold tracking-[0.06em] uppercase',
              'bg-[var(--accent)] text-white',
              'hover:opacity-90 transition-opacity duration-150',
              'disabled:opacity-35 disabled:cursor-not-allowed',
            )}
          >
            {selectedCode && selectedCode !== item.currentCode
              ? `${t('review_action_pick' as TKey)} ${selectedCode}`
              : t('review_action_pick_placeholder' as TKey)}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Exported dialog shell
// ---------------------------------------------------------------------------

export default function ReviewDialog({
  open,
  onOpenChange,
  item,
  onAccept,
  onDismiss,
  onPick,
}: ReviewDialogProps) {
  const t = useT();
  if (!item) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-[580px] w-full p-6 rounded-[var(--radius-lg)] bg-[var(--surface)] border border-[var(--line)] shadow-[var(--shadow-lift)]"
        // DialogContent already handles Escape + backdrop click via Radix.
      >
        <DialogHeader className="mb-1">
          <DialogTitle className="font-mono text-[13px] tracking-[0.06em] uppercase text-[var(--ink)] font-semibold">
            {t('review_dialog_title' as TKey)}
          </DialogTitle>
          <DialogDescription className="text-[13px] text-[var(--ink-3)] leading-[1.5] font-normal mt-0.5">
            {t('review_dialog_subtitle' as TKey)}
          </DialogDescription>
        </DialogHeader>

        <ReviewDialogBody
          item={item}
          onAccept={() => onAccept(item)}
          onDismiss={() => onDismiss(item)}
          onPick={(code) => { onPick(item, code); onOpenChange(false); }}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
