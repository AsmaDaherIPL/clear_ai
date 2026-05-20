/** Generate-mode result card. Presentational; parent owns the DescribeResponse. */

import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useT, type TKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  type DescribeResponse,
  type DecisionStatus,
  type DecisionReason,
  type AlternativeLine,
  type AnchoredCandidateSummary,
  reasonLabel,
  remediationHint,
  pickLang,
} from '@/lib/api';
import SubmissionDescriptionCard from './SubmissionDescriptionCard';
import RequiredProcedures from './RequiredProcedures';

interface ResultSingleProps {
  visible: boolean;
  /** Classifier response. When null, renders nothing. */
  data: DescribeResponse | null;
  /** Round-trip latency in ms, measured at the call site. */
  latencyMs?: number;
  /** Re-fire the most recent classification request (manual-pick variant). */
  onRetry?: () => void;
  /** Promote a manually-picked alternative code to the chosen leaf. */
  onPickAlternative?: (code: string) => void;
  /** Called when the operator accepts the current result via the review dialog. */
  onReviewAccept?: () => void;
  /** Called when the operator dismisses the current result via the review dialog. */
  onReviewDismiss?: () => void;
  className?: string;
}

/** Cap a description at a char limit, breaking at a word boundary when possible. */
const ZATCA_DESC_MAX = 250;
const ALT_DESC_MAX = 120;

/**
 * Strips ZATCA catalog artifacts from a description string:
 *   - leading tree-decoration: dashes, hyphens, angle brackets, commas
 *   - inline runs of "--", ",,", ">>" that come from catalog tree paths
 *   - collapses multiple spaces and trims
 */
function cleanDescription(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(/^[\s\-,<>]+/, '')   // leading decoration
    .replace(/--+/g, ' ')         // double-dash runs -> space
    .replace(/,,+/g, ',')         // doubled commas -> single
    .replace(/>>+/g, ' ')         // double angle-bracket runs -> space
    .replace(/\s{2,}/g, ' ')      // collapse whitespace
    .trim();
}

/**
 * Strips HS-codebook decorators (leading "- - -", ">>>", "<<<", etc.)
 * then clamps to max chars at a word boundary.
 */
function clampDescription(text: string, max: number = ZATCA_DESC_MAX): string {
  if (!text) return text;
  const cleaned = cleanDescription(text);
  if (cleaned.length <= max) return cleaned;
  const slice = cleaned.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

/**
 * Normalise a pipeline-resolved HS code for display. Strips non-digits.
 * Never pads — the pipeline always emits exactly 12 digits; if a shorter
 * code arrives it is rendered at its natural length with placeholder
 * pair-slots shown as middle-dot so no granularity is fabricated.
 * (Project rule: trailing zeros are semantic; never auto-pad.)
 */
function normaliseCode(code: string | null | undefined): string {
  return (code ?? '').replace(/\D/g, '');
}

// `formatCode` (the dotted display form `1509.00.000000`) is retired
// in mockup-pivot v2 — the CodeMonument renders the 12-digit code
// as a 6-cell pair grid, not as a dotted string. Brokers compare
// codes column-by-column in the new layout, so the dots are gone.

/**
 * Display label for the chosen result. Prefers the cleaned `label_*`
 * fields (no leading dashes/colons) when present; falls back to
 * `description_*` for older backend payloads that don't yet emit
 * label fields.
 */
function pickLabel(
  r: NonNullable<DescribeResponse['result']>,
  lang: 'en' | 'ar',
): string | null {
  if (lang === 'en') return r.label_en ?? r.description_en ?? null;
  return r.label_ar ?? r.description_ar ?? null;
}

// `splitPath`, `parseHsBreakdown`, `sectionForChapter`, `formatReqId`,
// `formatTimestampUTC` (and the SECTION/CHAPTER/HEADING/SUBHEADING
// grid + REQ-ID timestamp strip they fed) were retired in the
// mockup-match rebuild — the landing-page mockup deliberately omits
// both, keeping the result card focused on code + ZATCA description
// + suggested submission + GIR rationale + sidebar.
//
// `splitCodeSegments` (and the seg_* i18n keys) was retired earlier
// with the 6-segment gradient grid — replaced inline by `BigCode`
// below ResultSingle's default export, which renders the code as a
// single 12-digit string with the first 6 digits in --accent.

// Circular-arrow retry icon used by ManualPickCard's retry button.
const RetryArrowIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
  </svg>
);

// `DisclosureCaret` and `MetaChip` were retired in the May-2 mockup
// pivot. The pivot layout shows alternatives + rationale always-on
// (no <details>) and folds duty into a sidebar block (no inline
// chip), so neither helper has a caller. They lived a long life.

const FieldLabel = ({ children }: { children: React.ReactNode }) => (
  <div className="font-mono text-[11px] text-[var(--ink-3)] tracking-[0.06em] uppercase mb-1.5">
    {children}
  </div>
);

/** Match pill tone keyed off decision_status (good=green, warn=amber, bad=red). */
type PillTone = 'good' | 'warn' | 'bad';
const TONE_STYLES: Record<PillTone, { bg: string; fg: string; dot: string }> = {
  good: { bg: 'oklch(0.95 0.05 155)', fg: 'oklch(0.42 0.12 155)', dot: 'oklch(0.55 0.15 155)' },
  warn: { bg: 'oklch(0.95 0.06 75)', fg: 'oklch(0.42 0.13 60)', dot: 'oklch(0.62 0.16 60)' },
  bad:  { bg: 'oklch(0.94 0.05 25)', fg: 'oklch(0.42 0.14 25)', dot: 'oklch(0.55 0.18 25)' },
};
const TonePill = ({ tone, children }: { tone: PillTone; children: React.ReactNode }) => {
  const s = TONE_STYLES[tone];
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-medium"
      style={{ background: s.bg, color: s.fg }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: s.dot }} />
      {children}
    </span>
  );
};

/** Map (status, reason) → pill tone + i18n label key, with title-cased fallback. */
type PillSpec =
  | { tone: PillTone; labelKey: TKey }
  | { tone: PillTone; fallback: string };

function titleCaseSnake(s: string): string {
  if (!s) return '';
  const spaced = s.replace(/_/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

function pillFor(status: DecisionStatus, reason: DecisionReason): PillSpec {
  if (status === 'accepted') {
    switch (reason) {
      case 'strong_match':            return { tone: 'good', labelKey: 'match_strong' };
      case 'single_valid_descendant': return { tone: 'good', labelKey: 'match_only_leaf' };
      case 'already_most_specific':   return { tone: 'good', labelKey: 'match_most_specific' };
      case 'heading_level_match':     return { tone: 'warn', labelKey: 'match_family' };
      default:
        return { tone: 'good', fallback: titleCaseSnake(reason) };
    }
  }
  if (status === 'best_effort') {
    if (reason === 'best_effort_heading') return { tone: 'warn', labelKey: 'match_best_effort_review' };
    return { tone: 'warn', fallback: titleCaseSnake(reason) };
  }
  if (status === 'degraded') {
    return { tone: 'bad', labelKey: 'match_degraded_retry' };
  }
  switch (reason) {
    case 'zero_signal':              return { tone: 'bad',  labelKey: 'match_no_result' };
    case 'ambiguous_top_candidates': return { tone: 'warn', labelKey: 'match_multi_refine' };
    case 'low_top_score':            return { tone: 'warn', labelKey: 'match_weak_refine' };
    case 'small_top2_gap':           return { tone: 'warn', labelKey: 'match_weak_refine' };
    case 'guard_tripped':            return { tone: 'warn', labelKey: 'match_unverifiable' };
    case 'invalid_prefix':           return { tone: 'bad',  labelKey: 'match_invalid_prefix' };
    case 'brand_not_recognised':     return { tone: 'warn', labelKey: 'match_brand_unknown' };
    default:
      return { tone: 'warn', fallback: titleCaseSnake(reason) };
  }
}

// `dutyText` retired in the May-2 mockup pivot. Sidebar Import-Duty
// row now reads `r.duty.rate_percent` directly and falls back to
// `dutyStatusLabel` only on the prohibited/exempt path; the combined
// "5%" / "Exempted" string the chip used has no caller anymore.

/** Map a DutyStatus enum to its localised label via i18n. */
function dutyStatusLabel(
  t: (key: TKey) => string,
  status: NonNullable<NonNullable<DescribeResponse['result']>['duty']>['status'],
): string {
  switch (status) {
    case 'exempted':           return t('result_duty_status_exempted');
    case 'prohibited_import':  return t('result_duty_status_prohibited_import');
    case 'prohibited_export':  return t('result_duty_status_prohibited_export');
    case 'prohibited_both':    return t('result_duty_status_prohibited_both');
    default:                   return String(status);
  }
}

/** Card for degraded-with-candidates: retrieval succeeded but the picker didn't. */
function ManualPickCard({
  candidates,
  interpretation,
  onRetry,
  onPickAlternative,
  labels,
  className,
}: {
  candidates: AlternativeLine[];
  interpretation: DescribeResponse['interpretation'];
  onRetry?: () => void;
  onPickAlternative?: (code: string) => void;
  labels: {
    title: string;
    body: string;
    closest: string;
    useCode: string;
    retry: string;
    understood: string;
    stripped: string;
  };
  className?: string;
}) {
  return (
    <>
      <div
        className={cn(
          // Primary result card per design spec: 18px radius, hairline
          // border, warm-but-imperceptible resting shadow that lifts
          // subtly on hover. No coloured side-borders, no left-rail
          // accents — the card lives by its own geometry.
          'bg-[var(--surface)] border border-[var(--line)] rounded-[var(--radius-lg)] overflow-hidden',
          'shadow-[var(--shadow)] hover:shadow-[var(--shadow-lift)] transition-shadow duration-200',
          'animate-[fadeUp_0.35s_ease_both]',
          className,
        )}
      >
        {/* Header: headline + retry affordance. */}
        <div className="px-[22px] py-[18px] border-b border-[var(--line-2)] flex items-start justify-between gap-3 flex-wrap">
          <div className="flex-1 min-w-0">
            <div className="text-[15px] font-medium text-[var(--ink)] leading-[1.4]">
              {labels.title}
            </div>
            <div className="mt-1.5 text-[13.5px] text-[var(--ink-2)] leading-[1.55]">
              {labels.body}
            </div>
          </div>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="flex-shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-[var(--line)] bg-[var(--surface)] text-[12px] font-medium text-[var(--ink-2)] hover:border-[var(--ink-3)] hover:text-[var(--ink)] transition-colors duration-150"
              title="Re-fire the same classification request"
            >
              <RetryArrowIcon />
              <span>{labels.retry}</span>
            </button>
          )}
        </div>

        {/* Interpretation row, only when the researcher rewrote the input. */}
        {interpretation &&
          interpretation.stage !== 'passthrough' &&
          (interpretation.cleaned_as || interpretation.rewritten_as) && (
            <div className="px-[22px] py-3 border-b border-[var(--line-2)] bg-[var(--line-2)]">
              <div className="text-[12.5px] text-[var(--ink-2)] leading-[1.5]">
                <span className="font-mono text-[10px] text-[var(--ink-3)] tracking-[0.08em] uppercase me-2">
                  {labels.understood}
                </span>
                <span className="text-[var(--ink)]">
                  {interpretation.rewritten_as ?? interpretation.cleaned_as}
                </span>
                {interpretation.cleanup_stripped && interpretation.cleanup_stripped.length > 0 && (
                  <span className="ms-2 text-[var(--ink-3)]">
                    · {labels.stripped}: {interpretation.cleanup_stripped.join(', ')}
                  </span>
                )}
              </div>
            </div>
          )}

        {/* Candidate rows with per-row "Use this code" buttons. */}
        <div className="px-[22px] py-[18px]">
          <FieldLabel>{labels.closest}</FieldLabel>
          <div className="flex flex-col gap-1.5">
            {candidates.map((a, i) => (
              <div
                key={`${a.code}-${i}`}
                className="flex items-start gap-3.5 px-3.5 py-3 rounded-[var(--radius)] border border-[var(--line)] bg-[var(--surface)] hover:border-[var(--ink-3)] transition-colors duration-150"
              >
                <span className="font-mono text-[12px] text-[var(--ink-3)] w-[18px] flex-shrink-0 pt-[2px]">
                  {a.rank ?? i + 1}
                </span>
                <span className="font-mono text-[14px] text-[var(--ink)] font-medium flex-shrink-0 min-w-[120px] pt-[2px]">
                  {a.code}
                </span>
                <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                  <span className="text-[13px] text-[var(--ink-2)] leading-[1.4] truncate">
                    {clampDescription(a.description_en ?? '', ALT_DESC_MAX)}
                  </span>
                  {a.description_ar && (
                    <span
                      dir="rtl"
                      lang="ar"
                      className="text-[13px] text-[var(--ink-3)] leading-[1.5] text-right truncate"
                      style={{ fontFamily: "'IBM Plex Sans Arabic', sans-serif" }}
                    >
                      {clampDescription(a.description_ar, ALT_DESC_MAX)}
                    </span>
                  )}
                </div>
                {onPickAlternative && (
                  <button
                    type="button"
                    onClick={() => onPickAlternative(a.code)}
                    className="flex-shrink-0 inline-flex items-center gap-1 text-[11px] text-[var(--ink-3)] hover:text-[var(--accent)] transition-colors duration-150"
                  >
                    {labels.useCode}
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M5 12h14M13 6l6 6-6 6" />
                    </svg>
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* DEV/latency + trace footer link strip removed at user request. */}
    </>
  );
}

/** Card for non-accepted decisions: tone pill + reason + remediation hint. */
function ClarifyCard({
  pillTone,
  pillLabel,
  reasonLabel,
  hint,
  interpretation,
  candidates,
  labels,
  className,
}: {
  pillTone: PillTone;
  pillLabel: string;
  reasonLabel: string;
  hint: string | null;
  interpretation: DescribeResponse['interpretation'];
  candidates: AlternativeLine[];
  labels: { alts: string; understood: string; stripped: string };
  className?: string;
}) {
  return (
    <>
      <div
        className={cn(
          // Primary result card per design spec: 18px radius, hairline
          // border, warm-but-imperceptible resting shadow that lifts
          // subtly on hover. No coloured side-borders, no left-rail
          // accents — the card lives by its own geometry.
          'bg-[var(--surface)] border border-[var(--line)] rounded-[var(--radius-lg)] overflow-hidden',
          'shadow-[var(--shadow)] hover:shadow-[var(--shadow-lift)] transition-shadow duration-200',
          'animate-[fadeUp_0.35s_ease_both]',
          className,
        )}
      >
        {/* Header: tone pill + reason label. */}
        <div className="px-[22px] py-[18px] border-b border-[var(--line-2)] flex items-center gap-3 flex-wrap">
          <TonePill tone={pillTone}>{pillLabel}</TonePill>
          <span className="font-mono text-[11px] text-[var(--ink-3)] tracking-[0.06em] uppercase">
            {reasonLabel}
          </span>
        </div>

        {/* Interpretation row, only when the researcher rewrote the input. */}
        {interpretation &&
          interpretation.stage !== 'passthrough' &&
          (interpretation.cleaned_as || interpretation.rewritten_as) && (
            <div className="px-[22px] py-3 border-b border-[var(--line-2)] bg-[var(--line-2)]">
              <div className="text-[12.5px] text-[var(--ink-2)] leading-[1.5]">
                <span className="font-mono text-[10px] text-[var(--ink-3)] tracking-[0.08em] uppercase me-2">
                  {labels.understood}
                </span>
                <span className="text-[var(--ink)]">
                  {interpretation.rewritten_as ?? interpretation.cleaned_as}
                </span>
                {interpretation.cleanup_stripped && interpretation.cleanup_stripped.length > 0 && (
                  <span className="ms-2 text-[var(--ink-3)]">
                    · {labels.stripped}: {interpretation.cleanup_stripped.join(', ')}
                  </span>
                )}
              </div>
            </div>
          )}

        {/* Body: remediation hint + retrieved candidates. */}
        <div className="px-[22px] py-[18px] flex flex-col gap-[18px]">
          {hint && (
            <div className="text-[14px] text-[var(--ink-2)] leading-[1.6] bg-[var(--line-2)] border border-[var(--line)] rounded-[var(--radius)] px-4 py-3.5">
              {hint}
            </div>
          )}
          {candidates.length > 0 && (
            <div>
              <FieldLabel>{labels.alts}</FieldLabel>
              <div className="flex flex-col gap-1.5">
                {candidates.map((a, i) => (
                  <div
                    key={`${a.code}-${i}`}
                    className="flex items-start gap-3.5 px-3.5 py-3 rounded-[var(--radius)] border border-[var(--line)] bg-[var(--surface)] hover:border-[var(--ink-3)] transition-colors duration-150"
                  >
                    <span className="font-mono text-[12px] text-[var(--ink-3)] w-[18px] flex-shrink-0 pt-[2px]">
                      {a.rank ?? i + 1}
                    </span>
                    <span className="font-mono text-[14px] text-[var(--ink)] font-medium flex-shrink-0 min-w-[120px] pt-[2px]">
                      {a.code}
                    </span>
                    <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                      <span className="text-[13px] text-[var(--ink-2)] leading-[1.4] truncate">
                        {clampDescription(a.description_en ?? '', ALT_DESC_MAX)}
                      </span>
                      {a.description_ar && (
                        <span
                          dir="rtl"
                          lang="ar"
                          className="text-[13px] text-[var(--ink-3)] leading-[1.5] text-right truncate"
                          style={{ fontFamily: "'IBM Plex Sans Arabic', sans-serif" }}
                        >
                          {clampDescription(a.description_ar, ALT_DESC_MAX)}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* DEV/latency + trace footer link strip removed at user request. */}
    </>
  );
}

// `CodeMonument` (the 6-cell gradient grid) was retired in the
// mockup-match rebuild. The mockup renders the code as a single
// inline 12-digit string with `.` separators, the first 6 digits in
// --accent and the last 6 in --ink. See `BigCode` at the bottom of
// this file for the replacement.

/**
 * Clickable alternative card for the right-column alternatives section.
 * Shows match %, code, description, and a "Use this code" CTA.
 * When selected, shows "Selected — confirm below" state only.
 * The compare / rationale / confirm panel is rendered BELOW the list.
 */
function AlternativeCard({
  alt,
  isSelected,
  onSelect,
  t,
}: {
  alt: AlternativeLine;
  isSelected: boolean;
  onSelect: () => void;
  t: (key: TKey) => string;
}) {
  const matchPct = alt.retrieval_score != null
    ? `${Math.round(alt.retrieval_score * 100)}%`
    : null;
  const descText = clampDescription(alt.description_en ?? '', ALT_DESC_MAX);

  return (
    <div
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}
      aria-pressed={isSelected}
      className={cn(
        'flex flex-col gap-2 rounded-xl p-[14px_16px] cursor-pointer outline-none',
        'transition-[border-color,background] duration-[120ms]',
        'focus-visible:ring-2 focus-visible:ring-[#b8551b] focus-visible:ring-offset-1',
        isSelected
          ? 'border border-[#b8551b] bg-[#fff1e5]'
          : 'border border-[#e0d6ce] bg-white',
      )}
    >
      {/* Top row: code (left) + match% (right) — prototype layout */}
      <div className="flex justify-between items-center mb-1.5">
        <span
          className={cn(
            'font-mono text-[14px] font-bold',
            isSelected ? 'text-[#b8551b]' : 'text-[#231915]',
          )}
        >
          {alt.code}
        </span>
        {matchPct && (
          <span className="font-mono text-[11px] font-semibold text-[#a3958c]">
            {matchPct} match
          </span>
        )}
      </div>

      {/* Description */}
      {descText && (
        <p className="m-0 mb-2.5 text-[12px] leading-[1.5] text-[#7a6d65]">
          {descText}
        </p>
      )}

      {/* CTA row: "Use this code →" or "Selected — confirm below" with check_circle */}
      <div
        className={cn(
          'inline-flex items-center gap-1.5',
          'font-sans text-[12px] font-semibold tracking-[0.02em]',
          'transition-colors duration-[140ms]',
          isSelected ? 'text-[#a3958c]' : 'text-[#b8551b]',
        )}
      >
        {isSelected ? (
          <>
            <span
              className="material-symbols-outlined leading-none text-[#b8551b]"
              aria-hidden="true"
              style={{
                fontSize: 14,
                fontVariationSettings: "'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 14",
              }}
            >
              check_circle
            </span>
            {t('act_selected_confirm_below' as TKey)}
          </>
        ) : (
          <>
            {t('act_use_code')}
            <span
              className="material-symbols-outlined leading-none"
              aria-hidden="true"
              style={{
                fontSize: 14,
                fontVariationSettings: "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 14",
              }}
            >
              arrow_forward
            </span>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Modal dialog for confirming an alternative HS code selection.
 * Shows current vs new code + description, rationale textarea,
 * Cancel and Update Classification buttons.
 * Rendered via portal so it sits above the sidebar card.
 */
function ComparePanel({
  currentCode,
  currentDescription,
  selectedAlt,
  onConfirm,
  onCancel,
  t,
}: {
  currentCode: string;
  currentDescription: string | null;
  selectedAlt: AlternativeLine;
  onConfirm: (rationale: string) => void;
  onCancel: () => void;
  t: (key: TKey) => string;
}) {
  const [rationale, setRationale] = useState('');
  const canConfirm = rationale.trim().length > 0;

  // Lock body scroll while open
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onCancel]);

  const newDescription = clampDescription(selectedAlt.description_en ?? '', ZATCA_DESC_MAX);

  const modal = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="compare-dialog-title"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
        onClick={onCancel}
        aria-hidden="true"
      />

      {/* Dialog surface */}
      <div className="relative w-full max-w-[520px] bg-white rounded-2xl shadow-[0_24px_64px_rgba(0,0,0,0.18)] flex flex-col overflow-hidden animate-[fadeUp_0.2s_ease_both]">

        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-[#e0d6ce]">
          <div>
            <div
              id="compare-dialog-title"
              className="font-mono text-[10px] font-bold tracking-[0.1em] uppercase text-[#a3958c] mb-0.5"
            >
              {t('res_compare_selection' as TKey)}
            </div>
            <p className="text-[15px] font-semibold text-[#231915] m-0">
              {t('act_update_hs_code' as TKey)}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            className="flex items-center justify-center w-8 h-8 rounded-lg text-[#a3958c] hover:text-[#231915] hover:bg-[#f6f2ed] transition-colors duration-150"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 flex flex-col gap-4 overflow-y-auto">

          {/* Two-column comparison */}
          <div className="grid grid-cols-2 gap-3">
            {/* Current */}
            <div className="p-3.5 rounded-xl bg-[#f6f2ed] border border-[#e0d6ce] flex flex-col gap-1.5">
              <div className="font-mono text-[9px] font-bold tracking-[0.08em] uppercase text-[#a3958c]">
                {t('res_compare_current' as TKey)}
              </div>
              <span className="font-mono text-[13px] font-medium text-[#7a6d65] line-through">
                {currentCode}
              </span>
              {currentDescription && (
                <p className="m-0 text-[12px] text-[#7a6d65] leading-[1.45]">
                  {clampDescription(currentDescription, 120)}
                </p>
              )}
            </div>
            {/* New selection */}
            <div className="p-3.5 rounded-xl bg-[#fff1e5] border border-[rgba(184,85,27,0.35)] flex flex-col gap-1.5">
              <div className="font-mono text-[9px] font-bold tracking-[0.08em] uppercase text-[#b8551b]">
                {t('res_compare_new' as TKey)}
              </div>
              <span className="font-mono text-[13px] font-semibold text-[#b8551b]">
                {selectedAlt.code}
              </span>
              {newDescription && (
                <p className="m-0 text-[12px] text-[#b8551b]/80 leading-[1.45]">
                  {newDescription}
                </p>
              )}
            </div>
          </div>

          {/* Rationale */}
          <div>
            <label className="block font-mono text-[9px] font-bold tracking-[0.08em] uppercase text-[#7a6d65] mb-1.5">
              {t('res_compare_rationale_label' as TKey)}
              {' '}<span className="text-[#b8551b]">*</span>
            </label>
            <textarea
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              rows={3}
              placeholder={t('res_compare_rationale_placeholder' as TKey)}
              autoFocus
              className="w-full px-3 py-2.5 rounded-[10px] border border-[#e0d6ce] bg-white text-[13px] text-[#231915] leading-[1.5] resize-y outline-none font-[inherit] box-border focus:border-[#b8551b] transition-colors duration-150"
            />
          </div>
        </div>

        {/* Footer actions */}
        <div className="flex items-center gap-3 px-6 pb-6 pt-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 px-4 py-3 rounded-[10px] border border-[#e0d6ce] bg-white text-[14px] font-medium text-[#7a6d65] hover:bg-[#f6f2ed] hover:text-[#231915] transition-colors duration-150 cursor-pointer"
          >
            {t('act_cancel' as TKey)}
          </button>
          <button
            type="button"
            onClick={() => { if (canConfirm) onConfirm(rationale); }}
            disabled={!canConfirm}
            className={cn(
              'flex-[2] px-4 py-3 rounded-[10px] border-none text-[14px] font-semibold transition-[background,color] duration-150',
              canConfirm
                ? 'bg-[#b8551b] text-white cursor-pointer hover:bg-[#a04718]'
                : 'bg-[#f6f2ed] text-[#a3958c] cursor-not-allowed',
            )}
          >
            {t('act_update_hs_code' as TKey)}
          </button>
        </div>
      </div>
    </div>
  );

  // Portal to body so it overlays everything
  if (typeof document === 'undefined') return null;
  return createPortal(modal, document.body);
}

export default function ResultSingle({
  visible,
  data,
  // latencyMs prop kept on the interface for caller-side compat, but
  // no longer rendered — the dev latency footer was removed.
  onRetry,
  onPickAlternative,
  onReviewAccept,
  onReviewDismiss,
  className,
}: ResultSingleProps) {
  const t = useT();
  const [selectedAltCode, setSelectedAltCode] = useState<string | null>(null);

  if (!visible || !data) return null;

  const pill = pillFor(data.decision_status, data.decision_reason);
  const pillLabel = 'labelKey' in pill ? t(pill.labelKey) : pill.fallback;
  const interp = data.interpretation;
  const r = data.result;
  const candidates = data.alternatives ?? [];

  // Degraded + candidates → manual-pick variant.
  const degradedWithCandidates =
    data.decision_status === 'degraded' &&
    data.decision_reason === 'llm_unavailable' &&
    candidates.length > 0;

  if (degradedWithCandidates) {
    return (
      <ManualPickCard
        candidates={candidates}
        interpretation={interp}
        onRetry={onRetry}
        onPickAlternative={onPickAlternative}
        className={className}
        labels={{
          title: t('manual_pick_title'),
          body: t('manual_pick_body'),
          closest: t('res_closest'),
          useCode: t('act_use_code'),
          retry: t('act_retry'),
          understood: t('res_understood'),
          stripped: t('res_stripped'),
        }}
      />
    );
  }

  // Other non-accepted paths: needs_clarification / best_effort / degraded-without-candidates.
  if (!r) {
    const hint = remediationHint(data.decision_status, data.decision_reason);
    return (
      <ClarifyCard
        pillTone={pill.tone}
        pillLabel={pillLabel}
        reasonLabel={reasonLabel(data.decision_reason)}
        hint={hint}
        interpretation={interp}
        candidates={candidates}
        className={className}
        labels={{
          alts: t('res_alts'),
          understood: t('res_understood'),
          stripped: t('res_stripped'),
        }}
      />
    );
  }

  // Resolve duty up-front: r.duty can be a populated object whose fields are all null.
  // `dutyText` (the combined "5% / Exempted" label) was used by the
  // pre-pivot inline header chip; the pivot layout splits Import Duty
  // and VAT into separate sidebar rows that read `rate_percent` and
  // `dutyStatusLabel` directly. The helper stays exported for tests
  // and possible re-use; the local label is no longer needed.

  // Strong-match pill: shown only when reconciliation produced AGREEMENT
  // (both tracks agreed) or status is absent (older payloads). Explicitly
  // Sanity flag/block: surface the banner when FLAG or BLOCK.
  const sanityVerdict = data.sanity_verdict ?? null;
  const sanityRationale = data.sanity_rationale ?? null;
  const showSanityFlag  = sanityVerdict === 'FLAG';
  const showSanityBlock = sanityVerdict === 'BLOCK';

  // v2 verifier (PR 13): deterministic 2-rule check that fires when
  // identify and pick disagree. UNCERTAIN routes the row to HITL but
  // never overrides pick.final_code — the operator sees the picked
  // code with a banner explaining what disagreed.
  const verifierResult = data.verifier_result ?? null;
  const verifierRules = data.verifier_rules_triggered ?? null;
  const showVerifierUncertain = verifierResult === 'UNCERTAIN';

  // Classification confidence (0-1 → 85%).
  const confidenceRaw =
    r && typeof r.classification_confidence === 'number'
      ? r.classification_confidence
      : null;
  const confidencePct = confidenceRaw !== null ? `${Math.round(confidenceRaw * 100)}%` : null;

  // Visible alternatives: drop the chosen leaf so it doesn't show as
  // both the picked code (left column) and a sibling (right column).
  const altRows = (data.alternatives ?? []).filter((a) => a.code !== r.code);

  // Anchored candidate summary (when per-candidate data not on wire).
  const anchoredSummary: AnchoredCandidateSummary | null =
    data.anchored_candidate_summary ?? null;

  // Duty rendering: `r.duty.rate_percent` for numeric rate, fallback
  // to `dutyStatusLabel` for prohibited/exempt enums.
  const importDutyValue = r.duty
    ? r.duty.rate_percent != null
      ? `${r.duty.rate_percent}%`
      : dutyStatusLabel(t, r.duty.status)
    : '—';

  // Code split at HS-6 boundary so the inline render can colour the
  // first 6 digits in --accent and the trailing national/stat
  // extension in --ink. Matches the mockup's `big-code` block.
  const code12 = normaliseCode(r.code);

  function handleAltSelect(code: string) {
    setSelectedAltCode((prev) => (prev === code ? null : code));
  }

  function handleAltConfirm(code: string, _rationale: string) {
    setSelectedAltCode(null);
    onPickAlternative?.(code);
  }

  return (
    // Mockup-correct landing-page layout: centered single column at
    // 1080px max (matches mockup's `main`), two-column inner grid
    // (main 1.6fr + sidebar 1fr). Cards stack with 18px gap; the
    // mockup uses gaps between cards, NOT hairlines inside one big
    // card — that was the previous mockup-pivot v2 misread.
    <div
      className={cn(
        'mx-auto max-w-[1080px] flex flex-col gap-4 animate-[fadeUp_0.35s_ease_both]',
        className,
      )}
    >
      <div className="grid gap-[18px] items-start grid-cols-1 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] rtl:lg:[&>aside]:order-first">

        {/* ──────────── MAIN COLUMN ──────────── */}
        <div className="bg-[var(--surface)] border border-[var(--line)] rounded-[var(--radius-lg)] p-6 sm:p-[26px] flex flex-col gap-[22px] shadow-[var(--shadow)] hover:shadow-[var(--shadow-lift)] transition-shadow duration-200">

          {/* §1 HEADER — code + confidence ring. */}
          <div>
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="flex flex-col gap-3 min-w-0 flex-1">
                <div className="font-mono text-[11.5px] text-[var(--ink-3)] tracking-[0.08em] uppercase">
                  {t('res_predicted_code' as TKey)}
                </div>
                <BigCode code={code12} />
              </div>
              {/* Confidence ring indicator */}
              {confidencePct && confidenceRaw !== null && (
                <div className="flex flex-col items-center gap-1.5 shrink-0">
                  <div
                    className="font-mono text-[10px] text-[var(--ink-3)] tracking-[0.08em] uppercase"
                    title={`Decision: ${data.decision_status} · ${data.decision_reason}`}
                  >
                    {t('res_confidence' as TKey)}
                  </div>
                  <ConfidenceRing pct={Math.round(confidenceRaw * 100)} />
                </div>
              )}
            </div>

            {/* "HS code breakdown" label above the breadcrumb tree. */}
            {(r.path_ar || r.path_en) && (
              <div className="mt-4 font-mono text-[11px] text-[var(--ink-3)] tracking-[0.08em] uppercase">
                {t('res_code_breakdown' as TKey)}
              </div>
            )}

            {/*
              Prototype breakdown: vertical track line + CH/HD/SH/TR rows.
              Each row is a 3-col grid (tag | code | description) with
              depth * 12px margin-inline-start. Final row (TR) is orange.
            */}
            {(r.path_ar || r.path_en) && (() => {
              const splitPath = (s: string | null | undefined) =>
                s ? s.split(/\s*>\s*/).map((seg) => seg.trim()).filter(Boolean) : [];
              const enSegs = splitPath(r.path_en);
              const count = enSegs.length;
              if (count === 0) return null;

              // Build code prefix for each level.
              // CH=first 2 digits, HD=first 4, SH=first 6, TR=full code.
              // Prototype shows: 85 | 8517 | 851713 | 8517130000 (the full resolved code).
              const prefixLengths = [2, 4, 6, null]; // null = use full code12
              const levelTags = ['CH', 'HD', 'SH', 'TR'];

              const rows = Array.from({ length: count }, (_, i) => {
                const tag = levelTags[i] ?? 'TR';
                const prefixLen = prefixLengths[i] ?? null;
                // Final (TR) row always shows the full resolved code; others show prefix
                const codePrefix = prefixLen === null
                  ? code12
                  : prefixLen <= code12.length
                    ? code12.slice(0, prefixLen)
                    : code12;
                const desc = enSegs[i] ?? '';
                const isFinal = i === count - 1;
                return { tag, codePrefix, desc, depth: i, isFinal };
              });

              return (
                <div className="relative mt-3 ps-[18px]">
                  {/* Vertical track line — absolute, inset-inline-start 6px */}
                  <div className="absolute start-[6px] top-2 bottom-2 w-[2px] rounded-[1px] bg-[#e0d6ce]" />
                  {rows.map((row) => (
                    <div
                      key={row.tag}
                      className="grid items-start py-[10px] gap-[14px]"
                      style={{
                        gridTemplateColumns: 'auto auto 1fr',
                        marginInlineStart: row.depth * 12,
                      }}
                    >
                      {/* Tag chip: CH / HD / SH / TR */}
                      <span
                        className={cn(
                          'font-mono text-[10px] font-bold tracking-[0.1em] w-[22px] pt-[3px] leading-none shrink-0',
                          row.isFinal ? 'text-[#b8551b]' : 'text-[#a3958c]',
                        )}
                      >
                        {row.tag}
                      </span>
                      {/* Code prefix */}
                      <span
                        className={cn(
                          'font-mono text-[14px] font-medium pt-[2px] shrink-0 whitespace-nowrap',
                          row.isFinal ? 'text-[#b8551b]' : 'text-[#231915]',
                        )}
                      >
                        {row.codePrefix}
                      </span>
                      {/* Description */}
                      <span
                        className={cn(
                          'text-[14px] leading-[1.5] break-words',
                          row.isFinal ? 'text-[#231915] font-semibold' : 'text-[#7a6d65] font-normal',
                        )}
                      >
                        {row.desc}
                      </span>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>

          {/* §1.5 SANITY BANNER — value plausibility FLAG or BLOCK. */}
          {(showSanityFlag || showSanityBlock) && (
            <div
              className={cn(
                'px-4 py-3 rounded-[var(--radius)] border',
                showSanityBlock
                  ? 'bg-[oklch(0.95_0.04_25)] border-[oklch(0.80_0.08_25)] text-[oklch(0.38_0.14_25)]'
                  : 'bg-[oklch(0.96_0.04_18)] border-[oklch(0.84_0.07_18)] text-[oklch(0.42_0.14_18)]',
              )}
              role="alert"
            >
              <div className="font-mono text-[10.5px] uppercase tracking-[0.08em] mb-1 font-semibold">
                {showSanityBlock
                  ? t('res_sanity_block_label' as TKey)
                  : t('res_sanity_flag_label' as TKey)}
              </div>
              {sanityRationale && (
                <div className="text-[13px] leading-[1.55]">{sanityRationale}</div>
              )}
              {showSanityBlock && !sanityRationale && (
                <div className="text-[13px] leading-[1.55]">{t('res_sanity_block_body' as TKey)}</div>
              )}
            </div>
          )}

          {/*
            §1.6 VERIFIER BANNER (v2 / PR 13).
            UNCERTAIN means a deterministic rule fired:
              identify_chapter_disagreement — picker's chapter disagrees
                with a high-confidence identify chapter
              confidence_inversion          — picker low-confidence partial
                while identify is highly confident
            The code is kept (verifier never overrides pick.final_code);
            we just nudge the operator to review.
          */}
          {showVerifierUncertain && (
            <div
              className="px-4 py-3 rounded-[var(--radius)] border bg-[oklch(0.96_0.06_75)] border-[oklch(0.82_0.10_75)] text-[oklch(0.40_0.13_60)]"
              role="alert"
            >
              <div className="font-mono text-[10.5px] uppercase tracking-[0.08em] mb-1 font-semibold">
                {t('res_verifier_uncertain_label' as TKey)}
              </div>
              <div className="text-[13px] leading-[1.55]">
                {t('res_verifier_uncertain_body' as TKey)}
                {verifierRules && verifierRules.length > 0 && (
                  <span className="font-mono text-[12px] ms-1 text-[var(--ink-2)]">
                    ({verifierRules.join(', ')})
                  </span>
                )}
              </div>
            </div>
          )}

          {/* §2 INTERPRETATION ROW (only when researcher rewrote the input). */}
          {interp && interp.stage !== 'passthrough' && (interp.cleaned_as || interp.rewritten_as) && (
            <div className="px-3.5 py-2.5 rounded-[var(--radius)] bg-[var(--line-2)] border border-[var(--line)]">
              <div className="text-[12.5px] text-[var(--ink-2)] leading-[1.5]">
                <span className="font-mono text-[10px] text-[var(--ink-3)] tracking-[0.08em] uppercase me-2">
                  {t('res_understood')}
                </span>
                <span className="text-[var(--ink)]">{interp.rewritten_as ?? interp.cleaned_as}</span>
                {interp.cleanup_stripped && interp.cleanup_stripped.length > 0 && (
                  <span className="ms-2 text-[var(--ink-3)]">
                    · {t('res_stripped')}: {interp.cleanup_stripped.join(', ')}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* §3 ZATCA DESCRIPTION — removed: description_ar duplicates the
              submission description that §4 already renders. description_en
              is null on the dispatch path. Section dropped to avoid triple
              repetition of the same Arabic text. */}

          {/* §4 SUGGESTED ZATCA SUBMISSION DESCRIPTION
              Inline path (post-dispatch-v1): use the description that came
              back on the dispatch response. The legacy fallback path uses
              data.request_id to fetch from /classifications/{id}/submission-
              description — kept for the expand/batch flows that haven't
              migrated to /pipeline/dispatch yet. */}
          <SubmissionDescriptionCard
            inline={
              data.submission_description
                ? {
                    description_ar: data.submission_description.description_ar,
                    description_en: data.submission_description.description_en,
                  }
                : null
            }
            requestId={data.request_id}
          />

          {/* §5 GIR rationale — always-visible prose, no collapse. */}
          {data.rationale && (
            <div>
              <div className="font-mono text-[11px] text-[var(--ink-3)] tracking-[0.08em] uppercase mb-3 pb-3 border-b border-[var(--line-2)]">
                {t('res_main_why')}
              </div>
              <div className="text-[14px] text-[var(--ink)] leading-[1.6] whitespace-pre-line">
                {data.rationale}
              </div>
            </div>
          )}

          {/* §6 REVIEW ACTIONS — removed per feedback (flag + trace buttons removed). */}
        </div>

        {/* ──────────── SIDEBAR ──────────── */}
        <aside className="flex flex-col gap-4">

          {/*
            DUTY CARD — Import Duty + Required Procedures in a single block.
            Prototype pattern: padded={false} card with a gray header bar
            (background #f6f2ed, border-bottom) + padded body rows.
          */}
          <div className="overflow-hidden bg-white border border-[#e0d6ce] rounded-2xl">
            {/* Header bar — gray background with border-bottom, matches prototype DutyCard */}
            <div className="flex items-center gap-2.5 px-5 py-[14px] bg-[#f6f2ed] border-b border-[#e0d6ce]">
              <span
                className="material-symbols-outlined leading-none select-none text-[#a3958c]"
                aria-hidden="true"
                style={{
                  fontSize: 18,
                  fontVariationSettings: "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 18",
                }}
              >
                policy
              </span>
              <span className="font-sans text-[11px] font-semibold tracking-[0.1em] uppercase text-[#a3958c]">
                {t('res_sidebar_duty')}
              </span>
            </div>

            {/* Body */}
            <div className="p-5 flex flex-col gap-3.5">
              {/* Import Duty row — label small/muted, value large+bold like prototype */}
              <div className="flex justify-between items-baseline pb-2 border-b border-[#e0d6ce]">
                <span className="text-[14px] text-[#7a6d65]">
                  {t('res_sidebar_duty_import')}
                </span>
                <span className="font-sans text-[22px] font-bold text-[#231915] tracking-[-0.01em]">
                  {importDutyValue}
                </span>
              </div>

              {/* Required Procedures */}
              {r.procedures && r.procedures.length > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className="font-sans text-[11px] font-semibold tracking-[0.1em] uppercase text-[#a3958c]">
                      {t('res_sidebar_procedures')}
                    </span>
                    <span className="inline-flex items-center px-1.5 py-px rounded text-[9px] font-bold tracking-[0.06em] uppercase bg-[oklch(0.93_0.06_270)] text-[oklch(0.42_0.18_270)]">
                      Beta
                    </span>
                  </div>
                  <RequiredProcedures procedures={r.procedures} mode="result" />
                </div>
              )}
            </div>
          </div>

          {/*
            ALTERNATIVES CARD — prototype layout.
            Header: account_tree icon + eyebrow label, gray background with border-bottom.
            Body: subtitle text + clickable alt cards + compare panel below the list.
          */}
          {(anchoredSummary || altRows.length > 0) && (() => {
            const selectedAlt = altRows.find((a) => a.code === selectedAltCode) ?? null;
            return (
              <div className="overflow-hidden bg-white border border-[#e0d6ce] rounded-2xl">
                {/* Header bar — matches prototype AlternativesCard */}
                <div className="flex items-center gap-2.5 px-5 py-[14px] bg-[#f6f2ed] border-b border-[#e0d6ce]">
                  <span
                    className="material-symbols-outlined leading-none select-none text-[#a3958c]"
                    aria-hidden="true"
                    style={{
                      fontSize: 18,
                      fontVariationSettings: "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 18",
                    }}
                  >
                    account_tree
                  </span>
                  <span className="font-sans text-[11px] font-semibold tracking-[0.1em] uppercase text-[#a3958c]">
                    {t('res_sidebar_alternatives')}
                  </span>
                </div>

                {/* Body */}
                <div className="p-5 flex flex-col">
                  {/* Subtitle */}
                  <p className="m-0 mb-3 text-[12px] text-[#7a6d65] leading-[1.5] font-sans">
                    {t('res_alternatives_subtitle' as TKey)}
                  </p>

                  {/* Alt cards */}
                  <div className="flex flex-col gap-2.5">
                    {altRows.map((a, i) => (
                      <AlternativeCard
                        key={`alt-${a.code}-${i}`}
                        alt={a}
                        isSelected={selectedAltCode === a.code}
                        onSelect={() => handleAltSelect(a.code)}
                        t={t}
                      />
                    ))}
                  </div>

                  {/* Compare modal — portals to body, appears on alt selection */}
                  {selectedAlt && (
                    <ComparePanel
                      currentCode={r.code ?? ''}
                      currentDescription={r.label_en ?? r.description_en ?? null}
                      selectedAlt={selectedAlt}
                      onConfirm={(rationale) => handleAltConfirm(selectedAlt.code, rationale)}
                      onCancel={() => setSelectedAltCode(null)}
                      t={t}
                    />
                  )}
                </div>
              </div>
            );
          })()}

        </aside>
      </div>
    </div>
  );
}

/**
 * Circular progress ring for confidence percentage.
 * Always green (prototype spec) — uses oklch(0.55 0.15 155) stroke
 * and oklch(0.34 0.13 145) text regardless of percentage value.
 * 56x56 px SVG — gray track ring + green progress stroke + center %.
 */
function ConfidenceRing({ pct }: { pct: number }) {
  const SIZE = 56;
  const STROKE = 4;
  const R = (SIZE - STROKE) / 2;
  const CIRC = 2 * Math.PI * R;
  const dash = Math.max(0, Math.min(1, pct / 100)) * CIRC;
  const gap = CIRC - dash;

  // Always green per prototype spec — color-coded stroke is removed.
  const strokeColor = 'oklch(0.55 0.15 155)';
  const textColor   = 'oklch(0.34 0.13 145)';

  return (
    <svg
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      aria-label={`${pct}% confidence`}
      style={{ display: 'block', flexShrink: 0 }}
    >
      {/* Track */}
      <circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={R}
        fill="none"
        stroke="#ede4dc"
        strokeWidth={STROKE}
      />
      {/* Progress arc — starts at top (−90deg offset via transform) */}
      {dash > 0 && (
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={R}
          fill="none"
          stroke={strokeColor}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${gap}`}
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
        />
      )}
      {/* Center text */}
      <text
        x={SIZE / 2}
        y={SIZE / 2}
        dominantBaseline="central"
        textAnchor="middle"
        fill={textColor}
        style={{
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: '11px',
          fontWeight: 600,
        }}
      >
        {pct}%
      </text>
    </svg>
  );
}

/**
 * Big inline HS code render: `8517.13.00.00` at 40px all-orange.
 * Prototype spec: fontSize 40, fontWeight 700, color var(--c-primary) = #b8551b.
 * Groups digits into dotted segments (6.2.2.2) like ZATCA format.
 * Includes a copy button on the side.
 */
function BigCode({ code }: { code: string }) {
  const digits = code.replace(/\D/g, '');
  // Format as dotted segments: XXXXXX.XX.XX.XX (6-2-2-2)
  // If shorter than 12 digits, show what we have with natural breaks.
  const formatDotted = (d: string): string => {
    if (!d) return '—';
    // Build segments: first 6, then pairs
    const segs: string[] = [];
    if (d.length >= 1) segs.push(d.slice(0, Math.min(6, d.length)));
    if (d.length > 6)  segs.push(d.slice(6, Math.min(8, d.length)));
    if (d.length > 8)  segs.push(d.slice(8, Math.min(10, d.length)));
    if (d.length > 10) segs.push(d.slice(10, Math.min(12, d.length)));
    return segs.join('.');
  };
  const display = formatDotted(digits);
  return (
    <div className="flex items-center gap-3">
      <code
        className="font-mono font-bold leading-none whitespace-nowrap text-[40px] text-[#b8551b]"
        aria-label={`HS code ${digits || code}`}
      >
        {display}
      </code>
      {digits.length > 0 && (
        <CopyIconButton text={digits} title={`Copy HS code${digits.length < 12 ? ` (${digits.length} digits)` : ''}`} />
      )}
    </div>
  );
}

/**
 * Minimal icon-only copy button. Used inline next to BigCode and
 * inside the SubmissionDescriptionCard rows. Wraps the existing
 * navigator.clipboard pattern in a smaller surface than CopyChip
 * (which sits beside form labels and needs the COPY-CODE wording).
 */
function CopyIconButton({ text, title }: { text: string; title?: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title ?? 'Copy'}
      className="inline-flex items-center justify-center p-1.5 rounded-md text-[var(--ink-3)] hover:bg-[var(--line-2)] hover:text-[var(--ink)] transition-colors duration-150 cursor-pointer border-0 bg-transparent"
    >
      {copied ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M20 6L9 17l-5-5" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M5 15V5a2 2 0 0 1 2-2h10" />
        </svg>
      )}
    </button>
  );
}
