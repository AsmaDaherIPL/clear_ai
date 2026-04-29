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
 *      trace link → /trace/:request_id.
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
 *   - /trace/:id page is wired to the backend but not built in v2 yet —
 *     the link target works once that page is ported from v1.
 */

import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  type DescribeResponse,
  type DecisionStatus,
  type DecisionReason,
  type AlternativeLine,
  type ConfidenceBand,
} from '@/lib/api';
import SubmissionDescriptionCard from './SubmissionDescriptionCard';
import { CopyChip } from '@/components/ui/copy-chip';

interface ResultSingleProps {
  visible: boolean;
  /** The classifier response. When null, renders nothing. */
  data: DescribeResponse | null;
  /** Round-trip latency in ms, measured at the call site. */
  latencyMs?: number;
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
 * Split a 12-digit HS code into 6 two-digit segments. Pads with `00` on
 * the right if the backend ever returns a shorter code (defensive — every
 * `accepted` response from /classify/describe is supposed to be exactly
 * 12 digits, but we don't want a runtime crash if the contract drifts).
 *
 * The first three segments (HS-6 trunk) are rendered with the
 * orange→rust gradient; the last three (Saudi NSE) stay solid ink.
 */
function splitCodeSegments(code: string) {
  const padded = (code ?? '').replace(/\D/g, '').padEnd(12, '0').slice(0, 12);
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
 * Map (status, reason, confidence_band) → (pill tone, label key).
 * Mirrors lib/api.ts statusToTone + reasonLabel but localised through useT().
 */
function pillFor(
  status: DecisionStatus,
  _reason: DecisionReason,
  band: ConfidenceBand | undefined,
): { tone: PillTone; labelKey: 'match_strong' | 'match_review' | 'match_best_effort' | 'match_degraded' } {
  if (status === 'accepted') {
    // High band ≈ strong match; medium/low still rendered as accepted but
    // without the "strong" wording — for now, keep it simple and use
    // "Strong match" for high, "Needs review" tone-down for medium/low.
    if (band === 'high' || !band) return { tone: 'good', labelKey: 'match_strong' };
    return { tone: 'warn', labelKey: 'match_review' };
  }
  if (status === 'best_effort') return { tone: 'warn', labelKey: 'match_best_effort' };
  if (status === 'degraded')    return { tone: 'bad',  labelKey: 'match_degraded' };
  // needs_clarification
  return { tone: 'warn', labelKey: 'match_review' };
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
 * Score chip on alternative rows. Backend returns either:
 *   - A `retrieval_score` (0..1) on RRF candidates → render as percent
 *   - A qualitative `fit` ('fits' | 'partial' | 'excludes') on
 *     branch-rank candidates → render as a word
 *   - Neither → render an em-dash so the column never looks empty
 */
function scoreText(a: AlternativeLine): string {
  if (typeof a.retrieval_score === 'number') {
    return `${Math.round(a.retrieval_score * 100)}%`;
  }
  if (a.fit) {
    return a.fit;
  }
  return '—';
}

export default function ResultSingle({ visible, data, latencyMs, className }: ResultSingleProps) {
  const t = useT();
  if (!visible || !data) return null;

  // Accepted responses carry `result`; non-accepted (needs_clarification,
  // best_effort, degraded) don't — for now we still bail to null on
  // missing result. The non-accepted UX is a future "ClarifyCard" task;
  // ClassifyApp surfaces the remediation hint above us in the meantime.
  const r = data.result;
  if (!r) return null;

  const segments = splitCodeSegments(r.code);
  const pill = pillFor(data.decision_status, data.decision_reason, data.confidence_band);
  const interp = data.interpretation;
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
  const traceHref = data.request_id ? `/trace/${data.request_id}` : '#';

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
            <TonePill tone={pill.tone}>{t(pill.labelKey)}</TonePill>
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
              text={r.code}
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

        {/* ----- BODY: 4 stacked blocks ----- */}
        <div className="px-[22px] py-[18px] flex flex-col gap-[18px]">
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
                      <span className="font-mono text-[12px] text-[var(--ink-3)] flex-shrink-0 pt-[2px]">
                        {scoreText(a)}
                      </span>
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
