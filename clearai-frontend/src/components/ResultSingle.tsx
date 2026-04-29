/**
 * ResultSingle.tsx — Generate-mode result card (props-driven, real backend data)
 *
 * RESPONSIBILITIES:
 *   1. HEADER: 12-digit code as 6-segment digit breakdown
 *      (Chapter · Heading · Sub · National · Stat · Ext) + match-pill +
 *      Copy code + duty/procedures meta chips.
 *   2. INTERPRETATION ROW: "Understood as: …" trust signal — only when the
 *      researcher rewrote the input (interpretation.stage !== 'passthrough').
 *   3. BODY: four stacked blocks:
 *        a) ZATCA catalog description (EN above AR)
 *        b) Suggested ZATCA submission description (EN/AR rows + Copy AR
 *           button + "Differs from ZATCA catalog" pill + AI disclaimer)
 *        c) "Why this code" rationale block (tinted card)
 *        d) Considered alternatives (rank · code · desc · score/fit rows)
 *   4. LATENCY FOOTER (dev-only): client-measured round-trip + View full
 *      trace link → /trace?id=<request_id>.
 *
 * STATE OWNED: none — this is a presentational component. Parent
 * (ClassifyApp) owns the DescribeResponse and round-trip latency.
 *
 * DATA STRATEGY:
 *   The component takes `data: DescribeResponse | null`. When null (e.g. an
 *   error happened upstream and the parent still rendered us), we render
 *   nothing — the parent handles the empty / error UI. The EXEMPLAR
 *   constant has been removed: the wiring is live. For Storybook / layout
 *   work, pass a hand-crafted DescribeResponse instead.
 *
 * NOT YET IMPLEMENTED (genuine TODOs):
 *   - Generate ZATCA XML action (no backend endpoint yet).
 */

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
  /** The classifier response. When null, renders nothing. */
  data: DescribeResponse | null;
  /** Round-trip latency in ms, measured at the call site. */
  latencyMs?: number;
  /**
   * Re-fire the most recent classification request. Surfaced on the
   * degraded-with-candidates manual-pick variant as a "Retry auto-pick"
   * button — when the picker LLM was transiently unavailable but
   * retrieval still produced candidates, a second attempt usually
   * succeeds. Owned by ClassifyApp; ResultSingle just calls it.
   */
  onRetry?: () => void;
  /**
   * Promote a manually-picked alternative code to the chosen leaf.
   * Called when the user clicks "Use this code" on a candidate row in
   * the manual-pick variant. The parent synthesizes an accepted-shaped
   * envelope so the next render lands on the normal accepted layout.
   */
  onPickAlternative?: (code: string) => void;
  className?: string;
}

/**
 * Cap a description string at a hard character limit, breaking at a word
 * boundary when possible. ZATCA catalog descriptions can run 400+ chars.
 *
 * Applied independently to EN and AR — Arabic word-segmentation also
 * works on whitespace for ZATCA's catalog descriptions.
 */
const ZATCA_DESC_MAX = 250;
const ALT_DESC_MAX = 120;
function clampDescription(text: string, max: number = ZATCA_DESC_MAX): string {
  if (!text || text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

/**
 * Canonical 12-digit form of a Saudi HS code. Strips non-digits, pads
 * the right with `0` to 12 chars, then truncates to 12.
 *
 * Why this exists:
 *   - The backend can legitimately return a SHORTER code on the
 *     heading-level acceptance path (ADR-0019) — e.g. `4202` for a
 *     bag whose only confident-enough match was the HS-4 heading.
 *     ZATCA accepts the heading-padded form `420200000000` as a
 *     valid declaration, so the FRONTEND is responsible for
 *     surfacing the padded form to the user (visually AND on the
 *     clipboard) rather than the bare 4 digits.
 *   - Both the segment renderer and the Copy code button consume
 *     this so the digits the user sees on screen are exactly the
 *     digits that land on their clipboard.
 *
 * Defensive against:
 *   - Backend drift (returning 13+ chars → truncate to 12)
 *   - Punctuation (returning `4202.00.00.00` → strip non-digits)
 *   - Missing field (returning `''` / `null` → pad to `000000000000`)
 */
function padCodeTo12(code: string | null | undefined): string {
  return (code ?? '').replace(/\D/g, '').padEnd(12, '0').slice(0, 12);
}

/**
 * Split a 12-digit HS code into 6 two-digit segments. The first three
 * (HS-6 trunk: chapter / heading / sub) render with the orange→rust
 * gradient; the last three (Saudi NSE) stay solid ink.
 */
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

// Inline arrow icon — used for the trace link in the dev footer. The
// copy icon used to live here too but moved into the shared CopyChip
// primitive when both Copy code and Copy AR converged on that pill
// geometry.
const ArrowIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="rtl:scale-x-[-1]">
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

// Retry icon — circular arrow. Used by ManualPickCard's "Retry
// auto-pick" button so the affordance reads as "go again" without
// leaning on the word alone.
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

/**
 * Compact meta chip used for duty / procedures in the header. Layout:
 *
 *   ┌──────────────────┐
 *   │  DUTY    5 %     │
 *   └──────────────────┘
 *
 * Mono uppercase tag in muted ink on the start side; the value in solid
 * ink on the end side, slightly heavier so it reads as the primary
 * datum. Hairline border + subtle surface fill mirrors the match pill /
 * Copy code button so the trio of chips at the top of the card share a
 * consistent visual language.
 */
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

/**
 * Match pill — three visual tones depending on decision_status:
 *   accepted             → green ("Strong match" / reasonLabel)
 *   needs_clarification  → amber ("Needs review")
 *   best_effort          → amber ("Best effort — verify")
 *   degraded             → red   ("Service degraded")
 */
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

/**
 * Map (status, reason) → (pill tone, displayed label).
 *
 * The label is either:
 *   - `labelKey`   : a known i18n key the caller resolves with t(...)
 *   - `fallback`   : a literal string (already-formatted)
 *
 * The fallback path covers two cases:
 *   1. The backend ships a new `decision_reason` value before the
 *      frontend has been updated. We don't want to crash or render an
 *      empty pill — render "snake_case → Title Case" so it's at
 *      least intelligible (e.g. "future_new_reason" → "Future new
 *      reason"). The pill tone uses the status-only default.
 *   2. needs_clarification with no specific reason match — same
 *      fallback applies.
 *
 * `confidence_band` is no longer consulted — the new pill copy is
 * driven purely by (status, reason) per the spec table.
 */
type PillSpec =
  | { tone: PillTone; labelKey: TKey }
  | { tone: PillTone; fallback: string };

function titleCaseSnake(s: string): string {
  if (!s) return '';
  const spaced = s.replace(/_/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

function pillFor(status: DecisionStatus, reason: DecisionReason): PillSpec {
  // ----- accepted (green/amber by reason) -----
  if (status === 'accepted') {
    switch (reason) {
      case 'strong_match':            return { tone: 'good', labelKey: 'match_strong' };
      case 'single_valid_descendant': return { tone: 'good', labelKey: 'match_only_leaf' };
      case 'already_most_specific':   return { tone: 'good', labelKey: 'match_most_specific' };
      case 'heading_level_match':     return { tone: 'warn', labelKey: 'match_family' };
      default:
        // Unknown accepted reason — surface it without crashing.
        return { tone: 'good', fallback: titleCaseSnake(reason) };
    }
  }
  // ----- best_effort (always amber, "review" suffix) -----
  if (status === 'best_effort') {
    if (reason === 'best_effort_heading') return { tone: 'warn', labelKey: 'match_best_effort_review' };
    return { tone: 'warn', fallback: titleCaseSnake(reason) };
  }
  // ----- degraded (always red, generic retry message) -----
  if (status === 'degraded') {
    return { tone: 'bad', labelKey: 'match_degraded_retry' };
  }
  // ----- needs_clarification (mostly amber, one red) -----
  switch (reason) {
    case 'ambiguous_top_candidates': return { tone: 'warn', labelKey: 'match_multi_refine' };
    // `weak_retrieval` is the spec's name; the api.ts type lists
    // `low_top_score` as the equivalent. Cover both so a backend
    // rename in either direction doesn't drop us through to fallback.
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
 * Format the duty into a chip-ready string, or `null` when there's
 * nothing useful to show. Resolution order is intentional:
 *   1. `rate_percent` (numeric) — the most common case, render as "5 %".
 *   2. `status_en`     (words)   — used when the catalog row carries a
 *                                  status word like "Exempted" /
 *                                  "Prohibited from Importing" instead
 *                                  of a numeric duty.
 *   3. neither populated         → return null so the caller hides the
 *                                  whole chip (don't render an empty
 *                                  pill or a fallback dash — the user
 *                                  shouldn't see a chip that says "no
 *                                  data" when we genuinely don't know).
 *
 * We deliberately do NOT consult `raw_en` here even though it would
 * usually carry the trailing "%". The user spec pins the ordering to
 * (rate_percent → status_en → hide) so the rendering is predictable
 * regardless of how the catalog row got serialised.
 */
function dutyText(
  duty: NonNullable<NonNullable<DescribeResponse['result']>['duty']>,
): string | null {
  if (duty.rate_percent != null) return `${duty.rate_percent} %`;
  if (duty.status_en) return duty.status_en;
  return null;
}

/**
 * ManualPickCard — special-case render for the picker-down case
 *
 * Triggered when:
 *   decision_status === 'degraded' && decision_reason === 'llm_unavailable'
 *   && alternatives.length > 0
 *
 * Why a separate variant: the regular ClarifyCard pairs a red
 * "Service degraded" pill with retrieval candidates carrying 100% /
 * 99% scores, which reads as a contradiction (system says it's
 * broken, but here are confident-looking matches). In reality
 * retrieval succeeded, the picker LLM didn't, and `retrieval_score`
 * is search relevance not classification confidence — so we:
 *   - Use a calmer "Couldn't auto-select" headline + body.
 *   - Hide the percentage column entirely (rank-only).
 *   - Make every row pickable (`Use this code`) so the human can
 *     choose what the LLM couldn't.
 *   - Offer a "Retry auto-pick" affordance in the header — picker
 *     failures are usually transient.
 *
 * Heading is "Closest matches", not "Considered alternatives", since
 * "alternatives" implies "alternatives to the chosen one" and there
 * is no chosen one in this state.
 */
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
        {/* Header — calm headline + Retry affordance on the end side.
            No tone pill: the red "Service degraded" chip was the
            biggest contributor to the alarming feel of the previous
            UI; we replace the signal with the headline copy itself. */}
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

        {/* Interpretation row — same trust signal as the accepted card,
            only when the researcher rewrote the input. */}
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

        {/* Candidates — same row geometry as the accepted card's
            alternatives but with a `Use this code` button on the end
            instead of the score chip, and a different section label. */}
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
                {/* Per-row "Use this code" affordance. Same pill
                    geometry as Copy code / Strong match so the
                    control language stays consistent. */}
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

      {/* Latency footer — same dev-only panel as the accepted card. */}
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

/**
 * Card rendered when the backend returned a non-accepted decision —
 * needs_clarification (most common), best_effort, or degraded with
 * NO candidates. The shape mirrors the accepted ResultSingle card so
 * the user doesn't land in a wholly different UI just because the
 * classifier needs more input: same outer card chrome, same
 * alternatives list at the bottom, same dev-only latency footer.
 * What's different is the absence of a chosen 12-digit code —
 * replaced by a tone-coded pill + reason label + remediation hint
 * that tells the user what to do next.
 *
 * For the degraded-WITH-candidates case, see ManualPickCard above —
 * that has its own calmer treatment because retrieval succeeded.
 */
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
        {/* Header — tone-coded pill + reason label. The pill carries
            the colour signal (amber for needs_clarification, red for
            degraded); the label spells out which case fired. */}
        <div className="px-[22px] py-[18px] border-b border-[var(--line-2)] flex items-center gap-3 flex-wrap">
          <TonePill tone={pillTone}>{pillLabel}</TonePill>
          <span className="font-mono text-[11px] text-[var(--ink-3)] tracking-[0.06em] uppercase">
            {reasonLabel}
          </span>
        </div>

        {/* Interpretation row — if the researcher rewrote the input,
            show what retrieval actually saw. Useful trust signal: the
            user can see whether the rewrite matched their intent. */}
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

        {/* Body — remediation hint + retrieved candidates. */}
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
                    {/* No relationship chip in ClarifyCard — there's no
                        chosen code to compare against (that's the whole
                        reason this card is rendering instead of the
                        accepted layout). */}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Latency footer — same dev-only panel as the accepted card. */}
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

/**
 * Classify an alternative's relationship to the chosen code based on
 * the HS hierarchy:
 *   - same-family    : alternative shares the chosen code's HS-4 heading
 *                      (most semantic siblings).
 *   - related-family : alternative shares only the HS-2 chapter.
 *                      Often a near-miss — same broad commodity group
 *                      but different heading.
 *   - cross-family   : different chapter entirely. The amber case —
 *                      worth pausing over because if the system surfaced
 *                      a candidate in a different chapter, the user's
 *                      product description might genuinely belong there.
 *   - no-chosen      : there's no chosen code (e.g. ClarifyCard /
 *                      ManualPickCard paths). Caller hides the chip.
 *
 * Why this matters for non-customs users:
 *   The previous UI showed a "partial" / "excludes" chip from the
 *   branch-rank LLM, which means nothing without HS knowledge.
 *   "Same family" / "Cross-family" turns the same hierarchical signal
 *   into vocabulary anyone can read.
 */
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

/**
 * Pill that renders an alternative's relationship to the chosen code.
 * Uses the existing TonePill geometry — neutral grey for same/related
 * (these are background context, not action items), amber for
 * cross-family (catches the eye because it's the anomaly worth
 * investigating). Hides itself entirely on `no-chosen`.
 */
function RelationshipChip({ rel, label }: { rel: Relationship; label: string }) {
  if (rel === 'no-chosen') return null;
  // Same/related-family: neutral grey, sits flat in the row.
  // Cross-family: warn (amber) — same palette as the result-card pill.
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

/**
 * Resolve the i18n key for a given relationship. Caller passes the
 * resolved string into RelationshipChip — keeps the chip component
 * pure (no useT() hook so it can be cheaply rendered N times).
 */
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
  // Resolve the label once — either through useT() for known keys, or
  // straight to the literal fallback for unknown decision_reasons.
  const pillLabel = 'labelKey' in pill ? t(pill.labelKey) : pill.fallback;
  const interp = data.interpretation;
  const r = data.result;
  const candidates = data.alternatives ?? [];

  // -------------------------------------------------------------------
  // DEGRADED + CANDIDATES → MANUAL-PICK VARIANT
  //
  // When the picker LLM failed but retrieval still returned ranked
  // candidates, the user needs a calm "we couldn't choose, here's what
  // we found, you pick" UI — not the alarming "Service degraded" red
  // chip + no actionable next step. The retrieval scores are search
  // relevance not classification confidence, so we hide them in this
  // variant to avoid the contradiction of "100% match" sitting next
  // to a "couldn't pick" banner.
  //
  // Falls through to the regular ClarifyCard for the no-candidates
  // case (genuine outage where retrieval also failed) and for
  // needs_clarification / best_effort paths.
  // -------------------------------------------------------------------
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

  // -------------------------------------------------------------------
  // OTHER NON-ACCEPTED PATHS (needs_clarification / best_effort /
  // degraded-without-candidates)
  // -------------------------------------------------------------------
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
        // i18n keys passed through so the child can localise without a
        // duplicate hook subscription.
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
  // The submission description used to live on `data.submission_description`,
  // but the backend moved that work to a separate /classify/newDescription
  // route to cut ~3-5s off the main classify latency. SubmissionDescriptionCard
  // owns its own fetch lifecycle keyed on the request_id.
  // Resolve duty up-front so the chip's render condition checks a real
  // string, not the truthiness of `r.duty` (which can be a populated
  // object whose fields are all null — i.e. catalog row exists but
  // contains no duty data, e.g. heading-level codes).
  const dutyLabel = r.duty ? dutyText(r.duty) : null;

  // Trace link — the backend writes a classification_events row per
  // request and surfaces its UUID as `request_id`. The /trace/:id route
  // exists on the backend; the frontend page is a v2 TODO (port from v1).
  const traceHref = data.request_id ? `/trace?id=${data.request_id}` : '#';

  return (
    <>
      {/* ============ Main card ============ */}
      <div
        className={cn(
          'bg-[var(--surface)] border border-[var(--line)] rounded-[var(--radius-lg)] overflow-hidden',
          'animate-[fadeUp_0.35s_ease_both]',
          className,
        )}
      >
        {/* ----- HEADER: code-saudi label + match-pill + 6-segment digits.
              Copy code button used to live here next to the match pill;
              it moved down into the meta row alongside Duty so all
              code-context actions sit in one strip. */}
        <div className="px-[22px] py-[18px] border-b border-[var(--line-2)]">
          <div className="flex items-center justify-between gap-3 mb-2.5">
            <span className="font-mono text-[11px] text-[var(--ink-3)] tracking-[0.06em] uppercase">
              {t('res_code_saudi')}
            </span>
            <TonePill tone={pill.tone}>{pillLabel}</TonePill>
          </div>

          {/*
            Digit-segment grid.
            HS-6 trunk (chapter/heading/sub) renders with a vertical
            orange → rust gradient via background-clip:text. Saudi NSE
            digits stay solid ink as secondary detail.
          */}
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

          {/*
            Code-context strip: Duty + Copy code chips, sitting next to
            each other. Both share the MetaChip / CopyChip pill geometry
            (rounded-full, 12px text + 10px mono uppercase label,
            px-2.5 py-1) so they read as one control family. Procedures
            was previously here too but dropped — users never acted on
            it; the value still lives in the trace JSON for debugging.
          */}
          <div className="mt-3 pt-3 border-t border-[var(--line-2)] flex items-center gap-2 flex-wrap">
            {dutyLabel && (
              <MetaChip label={t('res_duty')} value={dutyLabel} title="ZATCA duty rate" />
            )}
            <CopyChip
              // Always copy the canonical 12-digit form, never the
              // raw `r.code` string. ZATCA accepts only 12-digit
              // declarations, so heading-level (4-digit) results
              // need their trailing zeros pasted along — the
              // segments renderer already shows the padded form,
              // and the clipboard must match.
              text={padCodeTo12(r.code)}
              label={t('act_copy')}
              title="Copy 12-digit HS code"
            />
          </div>
        </div>

        {/* ----- INTERPRETATION (trust signal) -----
            Only render when the researcher rewrote the input or the
            cleanup LLM stripped tokens. For pass-through inputs (the
            user gave us a clean phrase), this row would be noise. */}
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

        {/* ----- BODY: stacked content blocks ----- */}
        <div className="px-[22px] py-[18px] flex flex-col gap-[18px]">
          {/* (0) Required procedures — only when the chosen leaf has any.
              Slots above the catalog description because procedures are
              broker-actionable compliance signals (SFDA approval,
              quarantine, livestock export rules), and they need to be
              visible before the user reads the descriptive text below. */}
          {r.procedures && r.procedures.length > 0 && (
            <RequiredProcedures procedures={r.procedures} mode="result" />
          )}

          {/* (a) ZATCA catalog description — EN above AR */}
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

          {/* (b) Suggested ZATCA submission description — lazy-loaded via
              GET /classify/newDescription on mount. The card owns its own
              fetch lifecycle (loading skeleton → success / error / retry)
              and self-unmounts on `400 invalid_state` (when the original
              classification wasn't on the accepted 12-digit path). The
              describe response no longer carries this block — splitting
              it out cut ~3-5s off the main classify latency. */}
          <SubmissionDescriptionCard requestId={data.request_id} />

          {/* (c) Why this code — tinted rationale card. Only when present. */}
          {data.rationale && (
            <div>
              <FieldLabel>{t('res_rationale')}</FieldLabel>
              <div className="text-[14px] text-[var(--ink-2)] leading-[1.6] bg-[var(--line-2)] border border-[var(--line)] rounded-[var(--radius)] px-4 py-3.5">
                {data.rationale}
              </div>
            </div>
          )}

          {/* (d) Considered alternatives — rows.
              Skip the picker's-choice row (rank=1 / same code as r.code) so
              we don't repeat the chosen leaf in its own alternatives list.
              Falls back to "all alternatives" if no rank info is present. */}
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
                        {/* When the branch-rank model returned a per-alt
                            reason, surface it under the description as a
                            third muted line. Strictly optional — RRF-only
                            alternatives don't have one. */}
                        {a.reason && (
                          <span className="text-[12px] text-[var(--ink-3)] leading-[1.45] italic truncate">
                            {a.reason}
                          </span>
                        )}
                      </div>
                      {/* Relationship-to-chosen chip — replaces the old
                          retrieval-score percentage and the branch-rank
                          fit ("partial"/"excludes") chips. Cross-family
                          rows pop amber so the user notices candidates
                          from a different chapter. */}
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

      {/* ============ Latency + trace footer (dev-only) ============ */}
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
