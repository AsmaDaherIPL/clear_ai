/** Generate-mode result card. Presentational; parent owns the DescribeResponse. */

import { useState } from 'react';
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
// ReviewDialog removed 2026-05-16: the dialog was mounted from here
// with onAccept/onDismiss/onPick TODO stubs that never persisted.
// Single-shot results don't have a hitl_queue entry (queue is batch-
// only for now), so there is no review surface to navigate to either.
// The onReviewAccept / onReviewDismiss callback props are kept on the
// component interface for caller-side compatibility but are unused.

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
function clampDescription(text: string, max: number = ZATCA_DESC_MAX): string {
  if (!text || text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

/** Canonical 12-digit Saudi HS code: strip non-digits, right-pad with 0, truncate to 12. */
function padCodeTo12(code: string | null | undefined): string {
  return (code ?? '').replace(/\D/g, '').padEnd(12, '0').slice(0, 12);
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
                    className="flex-shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-[var(--line)] bg-[var(--surface)] text-[12px] font-medium text-[var(--ink-2)] hover:border-[var(--ink-3)] hover:text-[var(--ink)] transition-colors duration-150"
                  >
                    {labels.useCode}
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
                      {a.reason && (
                        <span className="text-[12px] text-[var(--ink-3)] leading-[1.45] italic truncate">
                          {a.reason}
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

/** Classify an alternative against the chosen code via HS hierarchy (chapter/heading). */
type Relationship = 'same-family' | 'related-family' | 'cross-family' | 'no-chosen';

// `CodeMonument` (the 6-cell gradient grid) was retired in the
// mockup-match rebuild. The mockup renders the code as a single
// inline 12-digit string with `.` separators, the first 6 digits in
// --accent and the last 6 in --ink. See `BigCode` at the bottom of
// this file for the replacement.

/**
 * Sidebar alternative row with per-row collapsable description.
 *
 * The mockup shows the sidebar's CONSIDERED ALTERNATIVES as a quiet
 * always-visible list (code + relationship pill). The user added one
 * extra requirement on top: each row should be collapsable on its
 * description. Default is collapsed (just code + pill), and a
 * disclosure caret toggles the EN/AR description text below it. We
 * own per-row open state with a local `useState`; lifting it would
 * complicate the sidebar block without buying anything.
 */
function AlternativeSidebarRow({
  alt,
  chosenCode,
  t,
  onPick,
}: {
  alt: AlternativeLine;
  chosenCode: string;
  t: (key: TKey) => string;
  /** When provided, renders a "Use this code" ghost button on hover. */
  onPick?: (code: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const hasDesc = Boolean(alt.description_en || alt.description_ar);

  return (
    <div className="flex flex-col gap-1.5 py-1 group">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => hasDesc && setOpen((o) => !o)}
          disabled={!hasDesc}
          className={cn(
            'inline-flex items-center gap-1.5 font-mono text-[14px] font-medium text-[var(--ink)] leading-none',
            hasDesc ? 'cursor-pointer hover:text-[var(--accent)] transition-colors duration-150' : 'cursor-default',
          )}
          aria-expanded={hasDesc ? open : undefined}
          aria-label={hasDesc ? (open ? t('res_alts_hide_desc') : t('res_alts_show_desc')) : undefined}
        >
          {hasDesc && (
            <svg
              width="9"
              height="9"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
              className={cn(
                'transition-transform duration-150 text-[var(--ink-3)] rtl:scale-x-[-1]',
                open && 'rotate-90',
              )}
            >
              <path d="M9 6l6 6-6 6" />
            </svg>
          )}
          <span>{alt.code}</span>
        </button>
        {onPick && (
          <button
            type="button"
            onClick={() => onPick(alt.code)}
            className={cn(
              'inline-flex items-center px-2 py-0.5 rounded-full border border-[var(--line)]',
              'font-mono text-[10px] uppercase tracking-[0.06em]',
              'text-[var(--ink-3)] hover:text-[var(--ink)] hover:border-[var(--ink-3)]',
              'bg-transparent transition-colors duration-150',
            )}
            title={t('act_use_code')}
          >
            {t('act_use_code')}
          </button>
        )}
      </div>
      {open && hasDesc && (
        <div className="pe-1 ps-[15px] flex flex-col gap-0.5 animate-[fadeIn_0.15s_ease_both]">
          {alt.description_en && (
            <span className="text-[12.5px] text-[var(--ink-2)] leading-[1.45]">
              {clampDescription(alt.description_en, ALT_DESC_MAX)}
            </span>
          )}
          {alt.description_ar && (
            <span
              dir="rtl"
              lang="ar"
              className="text-[12.5px] text-[var(--ink-3)] leading-[1.5] text-end"
              style={{ fontFamily: "'IBM Plex Sans Arabic', sans-serif" }}
            >
              {clampDescription(alt.description_ar, ALT_DESC_MAX)}
            </span>
          )}
          {alt.reason && (
            <span className="text-[11.5px] text-[var(--ink-3)] leading-[1.45] italic">
              {alt.reason}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function relationshipFor(altCode: string, chosenCode: string | null | undefined): Relationship {
  if (!chosenCode) return 'no-chosen';
  const altChapter = altCode.slice(0, 2);
  const chosenChapter = chosenCode.slice(0, 2);
  const altHeading = altCode.slice(0, 4);
  const chosenHeading = chosenCode.slice(0, 4);
  if (altHeading === chosenHeading) return 'same-family';
  if (altChapter === chosenChapter) return 'related-family';
  return 'cross-family';
}

/** Pill rendering an alternative's relationship to the chosen code. */
function RelationshipChip({ rel, label }: { rel: Relationship; label: string }) {
  if (rel === 'no-chosen') return null;
  const style =
    rel === 'cross-family'
      ? { background: TONE_STYLES.warn.bg, color: TONE_STYLES.warn.fg }
      : { background: 'var(--line-2)', color: 'var(--ink-3)' };
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium font-mono uppercase tracking-[0.04em]"
      style={style}
    >
      {label}
    </span>
  );
}

/** i18n key per relationship; caller resolves so RelationshipChip stays hook-free. */
const REL_KEY: Record<Exclude<Relationship, 'no-chosen'>, TKey> = {
  'same-family': 'rel_same_family',
  'related-family': 'rel_related_family',
  'cross-family': 'rel_cross_family',
};

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

  // Mockup-pivot v2 (May-2, 2nd iteration): single-column layout
  // language. The pre-v2 build leaned on a two-column grid that
  // fragmented the page; this version goes back to a centered single
  // column at max-width 1180 with cards stacked vertically and
  // sections inside each card separated by --line-2 hairlines (no
  // gaps). The signature CodeMonument carries the 12-digit HS code
  // as a 6-column gradient grid — the typographic monument the spec
  // asks for. See `CodeMonument` above for the rendering rule.

  // Strong-match pill: shown only when reconciliation produced AGREEMENT
  // (both tracks agreed) or status is absent (older payloads). Explicitly
  // excluded for DRIFT and ZERO_SIGNAL — those have their own pill or
  // are not a reliable agreement signal.
  const showStrongMatch =
    data.decision_status === 'accepted' &&
    data.classification_status === 'AGREEMENT';

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

  // Classification confidence (0-1 → "85%").
  const confidencePct =
    r && typeof r.classification_confidence === 'number'
      ? `${Math.round(r.classification_confidence * 100)}%`
      : null;

  // (reviewItem builder removed 2026-05-16 with ReviewDialog.)

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
  const code12 = padCodeTo12(r.code);

  return (
    // Mockup-correct landing-page layout: centered single column at
    // 1080px max (matches mockup's `main`), two-column inner grid
    // (main 1fr + sidebar 280px). Cards stack with 18px gap; the
    // mockup uses gaps between cards, NOT hairlines inside one big
    // card — that was the previous mockup-pivot v2 misread.
    <div
      className={cn(
        'mx-auto max-w-[1080px] flex flex-col gap-4 animate-[fadeUp_0.35s_ease_both]',
        className,
      )}
    >
      <div className="grid gap-[18px] items-start grid-cols-1 lg:grid-cols-[3fr_2fr] rtl:lg:[&>aside]:order-first">

        {/* ──────────── MAIN COLUMN ──────────── */}
        <div className="bg-[var(--surface)] border border-[var(--line)] rounded-[var(--radius-lg)] p-6 sm:p-[26px] flex flex-col gap-[22px] shadow-[var(--shadow)] hover:shadow-[var(--shadow-lift)] transition-shadow duration-200">

          {/* §1 HEADER — code + copy + Strong-match pill. */}
          <div>
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="flex flex-col gap-3 min-w-0 flex-1">
                <div className="font-mono text-[11.5px] text-[var(--ink-3)] tracking-[0.08em] uppercase">
                  {t('res_code_saudi')}
                </div>
                <BigCode code={code12} />
              </div>
              <div className="flex flex-wrap items-start gap-2">
                {showStrongMatch && (
                  <span
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md font-mono text-[11.5px] font-medium uppercase tracking-[0.06em]"
                    style={{ background: 'oklch(0.94 0.06 155)', color: 'oklch(0.36 0.13 155)' }}
                    title={`Decision: ${data.decision_status} · ${data.decision_reason}`}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M5 12.5l4.5 4.5L19 7" />
                    </svg>
                    {t('res_pill_strong_match')}
                  </span>
                )}
                {/* DRIFT pill */}
                {data.classification_status === 'DRIFT' && (
                  <span
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md font-mono text-[11.5px] font-medium uppercase tracking-[0.06em]"
                    style={{ background: 'oklch(0.94 0.07 75)', color: 'oklch(0.42 0.14 60)' }}
                  >
                    {t('res_pill_reviewed_ai' as TKey)}
                  </span>
                )}
                {/* Confidence percentage */}
                {confidencePct && (
                  <span className="inline-flex items-center px-2.5 py-1.5 rounded-md font-mono text-[11.5px] text-[var(--ink-3)] bg-[var(--line-2)] border border-[var(--line)]">
                    {confidencePct}
                  </span>
                )}
              </div>
            </div>

            {/* Chosen-leaf label (cleaned EN above AR), small under code. */}
            {(pickLabel(r, 'en') || pickLabel(r, 'ar')) && (
              <div className="mt-4 text-[14.5px] text-[var(--ink)] leading-[1.55]">
                {pickLabel(r, 'en') && <div className="break-words">{pickLabel(r, 'en')}</div>}
                {pickLabel(r, 'ar') && (
                  <div
                    dir="rtl"
                    lang="ar"
                    className="text-end mt-0.5 text-[var(--ink-2)] break-words"
                    style={{ fontFamily: "'IBM Plex Sans Arabic', sans-serif" }}
                  >
                    {pickLabel(r, 'ar')}
                  </div>
                )}
              </div>
            )}

            {/* Catalog breadcrumb — parse "A > B > C" into a section/heading table. */}
            {(r.path_ar || r.path_en) && (() => {
              const splitPath = (s: string | null | undefined) =>
                s ? s.split(/\s*>\s*/).map((seg) => seg.trim()).filter(Boolean) : [];
              const enSegs = splitPath(r.path_en);
              const arSegs = splitPath(r.path_ar);
              const count = Math.max(enSegs.length, arSegs.length);
              if (count === 0) return null;
              // Level label + digit prefix from the resolved code
              const levelLabel = (i: number) => {
                const names = [
                  t('res_meta_chapter'),
                  t('res_meta_heading'),
                  t('res_meta_subheading'),
                  'National Code',
                ];
                const prefixLengths = [2, 4, 6, 8];
                const name = names[i] ?? 'Tariff';
                const prefix = code12.slice(0, prefixLengths[i] ?? 8).replace(/^0+$/, '');
                return prefix ? `${name} ${prefix}` : name;
              };
              return (
                <div className="mt-3 rounded-[var(--radius)] border border-[var(--line)] overflow-hidden">
                  {Array.from({ length: count }, (_, i) => {
                    const en = enSegs[i] ?? null;
                    const ar = arSegs[i] ?? null;
                    return (
                      <div
                        key={i}
                        className={cn(
                          'flex items-start gap-4 px-4 py-3 bg-[var(--surface)]',
                          i > 0 && 'border-t border-[var(--line-2)]',
                        )}
                      >
                        <div className="w-[110px] flex-shrink-0 pt-[1px]">
                          <div className="font-mono text-[10.5px] text-[var(--ink-3)] tracking-[0.06em] uppercase leading-[1.4]">
                            {levelLabel(i)}
                          </div>
                        </div>
                        <div className="flex-1 min-w-0 flex flex-col gap-1">
                          {ar && (
                            <div
                              dir="rtl"
                              lang="ar"
                              className="text-[13px] text-[var(--ink)] leading-[1.55] break-words text-end"
                              style={{ fontFamily: "'IBM Plex Sans Arabic', sans-serif" }}
                            >
                              {ar}
                            </div>
                          )}
                          {en && (
                            <div className="text-[12px] text-[var(--ink-3)] leading-[1.5] break-words">
                              {en}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
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
                  : 'bg-[oklch(0.96_0.06_75)] border-[oklch(0.82_0.10_75)] text-[oklch(0.40_0.13_60)]',
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
        <aside className="bg-[var(--surface)] border border-[var(--line)] rounded-[var(--radius-lg)] p-[22px] flex flex-col gap-[22px] shadow-[var(--shadow)] hover:shadow-[var(--shadow-lift)] transition-shadow duration-200">

          {/*
            DUTY & REQUIREMENTS — Import Duty only. The VAT row was
            removed: it always rendered a hardcoded 15% which isn't part
            of the duty_info payload, and the project rule is to never
            invent values. Numeric rates come from r.duty.rate_percent;
            enum statuses (exempted / prohibited) come from r.duty.status.
          */}
          <div>
            <div className="font-mono text-[11px] text-[var(--ink-3)] tracking-[0.08em] uppercase mb-2.5 pb-2.5 border-b border-[var(--line-2)]">
              {t('res_sidebar_duty')}
            </div>
            <div className="flex items-center justify-between gap-3 py-2 text-[13.5px]">
              <span className="text-[var(--ink)]">{t('res_sidebar_duty_import')}</span>
              <span className="font-mono text-[var(--ink)] font-medium">{importDutyValue}</span>
            </div>
          </div>

          {/* REQUIRED PROCEDURES (only when chosen leaf has any). */}
          {r.procedures && r.procedures.length > 0 && (
            <div>
              <div className="font-mono text-[11px] text-[var(--ink-3)] tracking-[0.08em] uppercase mb-2.5 pb-2.5 border-b border-[var(--line-2)]">
                {t('res_sidebar_procedures')}
              </div>
              <RequiredProcedures procedures={r.procedures} mode="result" />
            </div>
          )}

          {/*
            CONSIDERED ALTERNATIVES.
            v2 + anchored: per-candidate data not on the wire — render
            aggregate verdict counts (fits / partial / does_not_fit) +
            GIR rule as a summary line. The picker's `verdict_population`
            is the source of truth.
            Legacy (pre-PR-13 rows): union track_a / track_b per-candidate
            rows. Retained so historic rows still render.
          */}
          {(anchoredSummary || altRows.length > 0) && (() => {
            const trackARows = altRows.filter((a) => a.track === 'track_a');
            const trackBRows = altRows.filter((a) => a.track === 'track_b');
            const groupless = altRows.filter((a) => !a.track);
            const hasBothTracks = trackARows.length > 0 && trackBRows.length > 0;
            return (
              <div>
                <div className="font-mono text-[11px] text-[var(--ink-3)] tracking-[0.08em] uppercase mb-2.5 pb-2.5 border-b border-[var(--line-2)]">
                  {t('res_sidebar_alternatives')}
                </div>


                {/* Track A — only label when both tracks present (else no header noise) */}
                {trackARows.length > 0 && (
                  <>
                    {hasBothTracks && (
                      <div className="font-mono text-[10.5px] text-[var(--ink-3)] tracking-[0.08em] uppercase mt-1 mb-1.5">
                        {t('res_track_identify' as TKey)}
                      </div>
                    )}
                    <div className="flex flex-col divide-y divide-[var(--line-2)]">
                      {trackARows.map((a, i) => (
                        <AlternativeSidebarRow
                          key={`a-${a.code}-${i}`}
                          alt={a}
                          chosenCode={r.code}
                          t={t}
                          onPick={onPickAlternative}
                        />
                      ))}
                    </div>
                  </>
                )}

                {/* Track B */}
                {trackBRows.length > 0 && (
                  <>
                    <div className="font-mono text-[10.5px] text-[var(--ink-3)] tracking-[0.08em] uppercase mt-3 mb-1.5">
                      {t('res_track_resolve' as TKey)}
                    </div>
                    <div className="flex flex-col divide-y divide-[var(--line-2)]">
                      {trackBRows.map((a, i) => (
                        <AlternativeSidebarRow
                          key={`b-${a.code}-${i}`}
                          alt={a}
                          chosenCode={r.code}
                          t={t}
                          onPick={onPickAlternative}
                        />
                      ))}
                    </div>
                  </>
                )}

                {/* Legacy untrack'd alternatives — render as a flat list. */}
                {groupless.length > 0 && (
                  <div className="flex flex-col divide-y divide-[var(--line-2)]">
                    {groupless.map((a, i) => (
                      <AlternativeSidebarRow
                        key={`u-${a.code}-${i}`}
                        alt={a}
                        chosenCode={r.code}
                        t={t}
                        onPick={onPickAlternative}
                      />
                    ))}
                  </div>
                )}

              </div>
            );
          })()}

        </aside>
      </div>

    </div>
  );
}

/**
 * Big inline HS code render: `15.09.20.00.00.00` with the first three
 * 2-digit pairs in --accent and the last three in --ink. Matches the
 * landing-page mockup's `big-code` element exactly. Includes a copy
 * button on the side. Replaces the older 6-cell `CodeMonument` grid
 * (which fragmented the code into floating cells with too much air
 * between them).
 */
function BigCode({ code }: { code: string }) {
  // code is already padded to 12 chars by the caller.
  const pairs = [
    code.slice(0, 2),
    code.slice(2, 4),
    code.slice(4, 6),
    code.slice(6, 8),
    code.slice(8, 10),
    code.slice(10, 12),
  ];
  return (
    <div className="flex items-center gap-3.5">
      <code
        className="font-mono font-medium leading-none whitespace-nowrap text-[clamp(28px,4.2vw,36px)] tracking-[0.01em]"
        aria-label={`HS code ${code}`}
      >
        {pairs.map((pair, i) => (
          <span key={i}>
            <span className={i < 3 ? 'text-[var(--accent)]' : 'text-[var(--ink)]'}>
              {pair}
            </span>
            {i < pairs.length - 1 && (
              <span className="text-[var(--ink-3)] font-normal px-[1px]">.</span>
            )}
          </span>
        ))}
      </code>
      <CopyIconButton text={code} title="Copy 12-digit HS code" />
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
