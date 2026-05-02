/** Generate-mode result card. Presentational; parent owns the DescribeResponse. */

import { useT, type TKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  type DescribeResponse,
  type DecisionStatus,
  type DecisionReason,
  type AlternativeLine,
  reasonLabel,
  remediationHint,
} from '@/lib/api';
import SubmissionDescriptionCard from './SubmissionDescriptionCard';
import RequiredProcedures from './RequiredProcedures';
import { CopyChip } from '@/components/ui/copy-chip';

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

/** Split a 12-digit HS code into 6 two-digit segments; first three are accented. */
function splitCodeSegments(code: string) {
  const padded = padCodeTo12(code);
  const labels: Array<{ key: 'seg_chapter' | 'seg_heading' | 'seg_sub' | 'seg_national' | 'seg_stat' | 'seg_ext'; accented: boolean }> = [
    { key: 'seg_chapter', accented: true },
    { key: 'seg_heading', accented: true },
    { key: 'seg_sub', accented: true },
    { key: 'seg_national', accented: false },
    { key: 'seg_stat', accented: false },
    { key: 'seg_ext', accented: false },
  ];
  return labels.map((l, i) => ({
    digits: padded.slice(i * 2, i * 2 + 2),
    labelKey: l.key,
    accented: l.accented,
  }));
}

// Inline arrow icon used for the trace link in the dev footer.
const ArrowIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="rtl:scale-x-[-1]">
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

// Circular-arrow retry icon used by ManualPickCard's retry button.
const RetryArrowIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
  </svg>
);

const FieldLabel = ({ children }: { children: React.ReactNode }) => (
  <div className="font-mono text-[11px] text-[var(--ink-3)] tracking-[0.06em] uppercase mb-1.5">
    {children}
  </div>
);

/** Compact meta chip used for duty in the header (mono label + value). */
const MetaChip = ({
  label,
  value,
  title,
}: {
  label: string;
  value: string;
  title?: string;
}) => (
  <span
    title={title}
    className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full border border-[var(--line)] bg-[var(--surface)] text-[12px]"
  >
    <span className="font-mono text-[10px] font-medium tracking-[0.08em] uppercase text-[var(--ink-3)]">
      {label}
    </span>
    <span className="font-mono font-medium text-[var(--ink)]">{value}</span>
  </span>
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

/**
 * Format duty as chip text. Returns null when neither rate nor status
 * is set so the caller can hide the chip entirely (rather than render
 * an em-dash that suggests "we know the duty is —").
 *
 * The DutyInfo shape changed in the backend's most recent release:
 * `status_en/ar/raw_en/raw_ar` dropped in favour of a single
 * `status` enum. We localise the enum via `dutyStatusLabel(t, …)`.
 */
function dutyText(
  duty: NonNullable<NonNullable<DescribeResponse['result']>['duty']>,
  t: (key: TKey) => string,
): string | null {
  if (duty.rate_percent != null) return `${duty.rate_percent} %`;
  if (duty.status) return dutyStatusLabel(t, duty.status);
  return null;
}

/** Map a DutyStatus enum to its localised label via i18n. */
function dutyStatusLabel(
  t: (key: TKey) => string,
  status: NonNullable<NonNullable<DescribeResponse['result']>['duty']>['status'],
): string {
  switch (status) {
    case 'exempted':           return t('result_duty_status_exempted' as TKey);
    case 'prohibited_import':  return t('result_duty_status_prohibited_import' as TKey);
    case 'prohibited_export':  return t('result_duty_status_prohibited_export' as TKey);
    case 'prohibited_both':    return t('result_duty_status_prohibited_both' as TKey);
    default:                   return String(status);
  }
}

/** Card for degraded-with-candidates: retrieval succeeded but the picker didn't. */
function ManualPickCard({
  candidates,
  interpretation,
  latencyMs,
  requestId,
  onRetry,
  onPickAlternative,
  labels,
  className,
}: {
  candidates: AlternativeLine[];
  interpretation: DescribeResponse['interpretation'];
  latencyMs?: number;
  requestId?: string;
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
    latency: string;
    trace: string;
  };
  className?: string;
}) {
  const traceHref = requestId ? `/trace?id=${requestId}` : '#';
  return (
    <>
      <div
        className={cn(
          'bg-[var(--surface)] border border-[var(--line)] rounded-[var(--radius-lg)] overflow-hidden',
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

      {/* Dev-only latency + trace footer. */}
      <div className="mt-3 flex items-center justify-between gap-3 px-[18px] py-3 border border-[var(--line)] rounded-[var(--radius)] bg-[var(--line-2)]">
        <div className="flex items-center gap-2.5">
          <span
            className="font-mono text-[12px] font-semibold tracking-[0.08em] uppercase px-2.5 py-1 rounded border border-[var(--line)] bg-[var(--surface)] text-[var(--ink-3)]"
            title="Development-only diagnostic panel"
          >
            DEV
          </span>
          <div className="font-mono text-[12px] text-[var(--ink-2)]">
            <span>{labels.latency}</span>{' '}
            <b className="text-[var(--ink)] font-medium">
              {latencyMs != null ? `${(latencyMs / 1000).toFixed(2)} s` : '—'}
            </b>
          </div>
        </div>
        <a
          href={traceHref}
          className={cn(
            'inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-[var(--line)] bg-[var(--surface)]',
            'font-mono text-[12px] font-medium text-[var(--ink-2)] hover:text-[var(--ink)] hover:border-[var(--ink-3)] no-underline transition-colors duration-150',
            !requestId && 'opacity-50 pointer-events-none',
          )}
        >
          <span>{labels.trace}</span>
          <ArrowIcon />
        </a>
      </div>
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
  latencyMs,
  requestId,
  labels,
  className,
}: {
  pillTone: PillTone;
  pillLabel: string;
  reasonLabel: string;
  hint: string | null;
  interpretation: DescribeResponse['interpretation'];
  candidates: AlternativeLine[];
  latencyMs?: number;
  requestId?: string;
  labels: { alts: string; understood: string; stripped: string; latency: string; trace: string };
  className?: string;
}) {
  const traceHref = requestId ? `/trace?id=${requestId}` : '#';
  return (
    <>
      <div
        className={cn(
          'bg-[var(--surface)] border border-[var(--line)] rounded-[var(--radius-lg)] overflow-hidden',
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

      {/* Dev-only latency + trace footer. */}
      <div className="mt-3 flex items-center justify-between gap-3 px-[18px] py-3 border border-[var(--line)] rounded-[var(--radius)] bg-[var(--line-2)]">
        <div className="flex items-center gap-2.5">
          <span
            className="font-mono text-[12px] font-semibold tracking-[0.08em] uppercase px-2.5 py-1 rounded border border-[var(--line)] bg-[var(--surface)] text-[var(--ink-3)]"
            title="Development-only diagnostic panel"
          >
            DEV
          </span>
          <div className="font-mono text-[12px] text-[var(--ink-2)]">
            <span>{labels.latency}</span>{' '}
            <b className="text-[var(--ink)] font-medium">
              {latencyMs != null ? `${(latencyMs / 1000).toFixed(2)} s` : '—'}
            </b>
          </div>
        </div>
        <a
          href={traceHref}
          className={cn(
            'inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-[var(--line)] bg-[var(--surface)]',
            'font-mono text-[12px] font-medium text-[var(--ink-2)] hover:text-[var(--ink)] hover:border-[var(--ink-3)] no-underline transition-colors duration-150',
            !requestId && 'opacity-50 pointer-events-none',
          )}
        >
          <span>{labels.trace}</span>
          <ArrowIcon />
        </a>
      </div>
    </>
  );
}

/** Classify an alternative against the chosen code via HS hierarchy (chapter/heading). */
type Relationship = 'same-family' | 'related-family' | 'cross-family' | 'no-chosen';

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
  latencyMs,
  onRetry,
  onPickAlternative,
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
        latencyMs={latencyMs}
        requestId={data.request_id}
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
          latency: t('meta_latency'),
          trace: t('view_trace'),
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
        latencyMs={latencyMs}
        requestId={data.request_id}
        className={className}
        labels={{
          alts: t('res_alts'),
          understood: t('res_understood'),
          stripped: t('res_stripped'),
          latency: t('meta_latency'),
          trace: t('view_trace'),
        }}
      />
    );
  }

  const segments = splitCodeSegments(r.code);
  // Resolve duty up-front: r.duty can be a populated object whose fields are all null.
  const dutyLabel = r.duty ? dutyText(r.duty, t) : null;

  const traceHref = data.request_id ? `/trace?id=${data.request_id}` : '#';

  return (
    <>
      <div
        className={cn(
          'bg-[var(--surface)] border border-[var(--line)] rounded-[var(--radius-lg)] overflow-hidden',
          'animate-[fadeUp_0.35s_ease_both]',
          className,
        )}
      >
        {/* Header: label + match-pill + 6-segment digits. */}
        <div className="px-[22px] py-[18px] border-b border-[var(--line-2)]">
          <div className="flex items-center justify-between gap-3 mb-2.5">
            <span className="font-mono text-[11px] text-[var(--ink-3)] tracking-[0.06em] uppercase">
              {t('res_code_saudi')}
            </span>
            <TonePill tone={pill.tone}>{pillLabel}</TonePill>
          </div>

          {/* Digit-segment grid: HS-6 trunk gets the gradient; Saudi NSE stays solid ink. */}
          <div className="grid grid-cols-6 gap-1 mt-1">
            {segments.map(({ digits, labelKey, accented }) => (
              <div key={labelKey} className="flex flex-col items-center py-1.5 px-1">
                <span
                  className={cn(
                    'font-mono text-[36px] font-medium leading-none tracking-[0.01em]',
                    accented
                      ? 'bg-clip-text text-transparent bg-gradient-to-b from-[#E97B3A] via-[#B8551B] to-[#7B3D17]'
                      : 'text-[var(--ink)]',
                  )}
                >
                  {digits}
                </span>
                <span className="mt-2 font-mono text-[10px] text-[var(--ink-3)] tracking-[0.08em] uppercase">
                  {t(labelKey)}
                </span>
              </div>
            ))}
          </div>

          {/* Code-context strip: Duty + Copy code chips. */}
          <div className="mt-3 pt-3 border-t border-[var(--line-2)] flex items-center gap-2 flex-wrap">
            {dutyLabel && (
              <MetaChip label={t('res_duty')} value={dutyLabel} title="ZATCA duty rate" />
            )}
            <CopyChip
              // Always copy the canonical 12-digit form so the clipboard matches what's on screen.
              text={padCodeTo12(r.code)}
              label={t('act_copy')}
              title="Copy 12-digit HS code"
            />
          </div>
        </div>

        {/* Interpretation row, only when the researcher rewrote the input. */}
        {interp && interp.stage !== 'passthrough' && (interp.cleaned_as || interp.rewritten_as) && (
          <div className="px-[22px] py-3 border-b border-[var(--line-2)] bg-[var(--line-2)]">
            <div className="text-[12.5px] text-[var(--ink-2)] leading-[1.5]">
              <span className="font-mono text-[10px] text-[var(--ink-3)] tracking-[0.08em] uppercase me-2">
                {t('res_understood')}
              </span>
              <span className="text-[var(--ink)]">
                {interp.rewritten_as ?? interp.cleaned_as}
              </span>
              {interp.cleanup_stripped && interp.cleanup_stripped.length > 0 && (
                <span className="ms-2 text-[var(--ink-3)]">
                  · {t('res_stripped')}: {interp.cleanup_stripped.join(', ')}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Body: stacked content blocks. */}
        <div className="px-[22px] py-[18px] flex flex-col gap-[18px]">
          {/* Required procedures, only when the chosen leaf has any. */}
          {r.procedures && r.procedures.length > 0 && (
            <RequiredProcedures procedures={r.procedures} mode="result" />
          )}

          {/* ZATCA catalog description (EN above AR). */}
          <div>
            <FieldLabel>{t('res_zatca_desc')}</FieldLabel>
            <div className="text-[14.5px] text-[var(--ink)] leading-[1.55]">
              {clampDescription(r.description_en ?? '')}
              {r.description_ar && (
                <div
                  dir="rtl"
                  lang="ar"
                  className="text-end mt-1 text-[var(--ink-2)]"
                  style={{ fontFamily: "'IBM Plex Sans Arabic', sans-serif" }}
                >
                  {clampDescription(r.description_ar)}
                </div>
              )}
            </div>
          </div>

          {/* Suggested ZATCA submission description; the card owns its own fetch lifecycle. */}
          <SubmissionDescriptionCard requestId={data.request_id} />

          {/* Rationale card; only when present. */}
          {data.rationale && (
            <div>
              <FieldLabel>{t('res_rationale')}</FieldLabel>
              <div className="text-[14px] text-[var(--ink-2)] leading-[1.6] bg-[var(--line-2)] border border-[var(--line)] rounded-[var(--radius)] px-4 py-3.5">
                {data.rationale}
              </div>
            </div>
          )}

          {/* Considered alternatives; skips the row matching the chosen code. */}
          {data.alternatives && data.alternatives.length > 0 && (() => {
            const rows = data.alternatives.filter(
              (a) => a.code !== r.code,
            );
            if (rows.length === 0) return null;
            return (
              <div>
                <FieldLabel>{t('res_alts')}</FieldLabel>
                <div className="flex flex-col gap-1.5">
                  {rows.map((a, i) => (
                    <div
                      key={`${a.code}-${i}`}
                      className="flex items-start gap-3.5 px-3.5 py-3 rounded-[var(--radius)] border border-[var(--line)] bg-[var(--surface)] hover:border-[var(--ink-3)] transition-colors duration-150"
                    >
                      <span className="font-mono text-[12px] text-[var(--ink-3)] w-[18px] flex-shrink-0 pt-[2px]">
                        {a.rank ?? i + 2}
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
                            className="text-[13px] text-[var(--ink-3)] leading-[1.5] text-end truncate"
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
                      {/* Relationship-to-chosen chip; cross-family rows pop amber. */}
                      {(() => {
                        const rel = relationshipFor(a.code, r.code);
                        if (rel === 'no-chosen') return null;
                        return (
                          <RelationshipChip
                            rel={rel}
                            label={t(REL_KEY[rel])}
                          />
                        );
                      })()}
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>
      </div>

      {/* Dev-only latency + trace footer. */}
      <div className="mt-3 flex items-center justify-between gap-3 px-[18px] py-3 border border-[var(--line)] rounded-[var(--radius)] bg-[var(--line-2)]">
        <div className="flex items-center gap-2.5">
          <span
            className="font-mono text-[12px] font-semibold tracking-[0.08em] uppercase px-2.5 py-1 rounded border border-[var(--line)] bg-[var(--surface)] text-[var(--ink-3)]"
            title="Development-only diagnostic panel"
          >
            DEV
          </span>
          <div className="font-mono text-[12px] text-[var(--ink-2)]">
            <span>{t('meta_latency')}</span>{' '}
            <b className="text-[var(--ink)] font-medium">
              {latencyMs != null ? `${(latencyMs / 1000).toFixed(2)} s` : '—'}
            </b>
          </div>
        </div>
        <a
          href={traceHref}
          className={cn(
            'inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-[var(--line)] bg-[var(--surface)]',
            'font-mono text-[12px] font-medium text-[var(--ink-2)] hover:text-[var(--ink)] hover:border-[var(--ink-3)] no-underline transition-colors duration-150',
            !data.request_id && 'opacity-50 pointer-events-none',
          )}
        >
          <span>{t('view_trace')}</span>
          <ArrowIcon />
        </a>
      </div>
    </>
  );
}
