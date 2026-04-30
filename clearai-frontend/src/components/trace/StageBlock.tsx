/**
 * StageBlock.tsx — the per-stage primitive for the trace page rebuild.
 *
 * Each block tells a self-contained mini-story with INPUT → ACTION →
 * OUTCOME → NEXT structure. The TracePage renders 6 of these (cleanup,
 * retrieval, research, gate, picker, best-effort) by passing the same
 * primitive different `sections` content.
 *
 * The block has slots, not props for individual fields, because every
 * stage's content shape is different — retrieval has a funnel, picker
 * has a rationale quote, the gate has pass/fail check rows, etc. The
 * primitive owns the chrome (header / body wrap / divider lines /
 * collapsed raw JSON), and each adapter owns the section content.
 *
 * SUB-COMPONENTS exported alongside:
 *   - StageSection : labelled slot inside a block
 *   - StageDecision: the dramatic-beat callout (good / warn / bad)
 *   - StageHandoff : the pill linking to the next stage
 *   - StageRaw     : collapsed raw JSON disclosure
 *   - StageChecks  : pass/fail checklist primitive (used by gate, picker)
 *   - StageGloss   : (?) inline glossary marker with title-tooltip
 */
import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

type StageState = 'good' | 'warn' | 'bad' | 'skipped';

const STATE_PILL: Record<StageState, { bg: string; fg: string; dot: string }> = {
  good:    { bg: 'oklch(0.95 0.05 155)', fg: 'oklch(0.42 0.12 155)', dot: 'oklch(0.55 0.15 155)' },
  warn:    { bg: 'oklch(0.95 0.06 75)',  fg: 'oklch(0.42 0.13 60)',  dot: 'oklch(0.62 0.16 60)' },
  bad:     { bg: 'oklch(0.94 0.05 25)',  fg: 'oklch(0.42 0.14 25)',  dot: 'oklch(0.55 0.18 25)' },
  skipped: { bg: 'var(--line-2)',        fg: 'var(--ink-3)',         dot: 'var(--ink-3)' },
};

interface StageBlockProps {
  /** 1-indexed stage position, e.g. 3 for "STAGE 3 / 5". */
  index: number;
  /** Total number of stages currently rendered. */
  total: number;
  /** Plain title for this stage. */
  title: string;
  /** Optional inline glossary marker after the title — see StageGloss. */
  titleGloss?: string;
  /** State (drives header pill colour). */
  state: StageState;
  /** Localised state label, e.g. "Done" / "Refused" / "Failed". */
  stateLabel: string;
  /** Optional latency / metadata string on the right of the header (mono). */
  meta?: string;
  /**
   * Optional badge sourced from event.model_calls[] for THIS stage.
   * Renders inline in the header as e.g. "🤖 Sonnet · 4.22s" so the
   * user can see at a glance which stages called an LLM and which
   * didn't. Caller is responsible for filtering model_calls by
   * stage and passing the model + latency + status here.
   */
  llmBadge?: ReactNode;
  /** Optional id for in-page anchoring (#stage-3, etc.). */
  id?: string;
  children: ReactNode;
  className?: string;
}

export function StageBlock({
  index, total, title, titleGloss, state, stateLabel, meta, llmBadge, id, children, className,
}: StageBlockProps) {
  const pill = STATE_PILL[state];
  return (
    <section
      id={id}
      className={cn(
        'bg-[var(--surface)] border border-[var(--line)] rounded-[var(--radius-lg)] overflow-hidden',
        'shadow-[0_1px_0_rgba(20,16,12,0.02),0_1px_2px_rgba(20,16,12,0.04)]',
        className,
      )}
    >
      <header className="flex items-center justify-between gap-3 px-[22px] py-[16px] border-b border-[var(--line-2)] flex-wrap">
        <div className="flex items-center gap-3">
          <span className="font-mono text-[11px] tracking-[0.1em] text-[var(--ink-3)] uppercase">
            STAGE {index} / {total}
          </span>
          <h2 className="text-[17px] font-medium text-[var(--ink)] tracking-[-0.005em] m-0 flex items-center gap-1.5">
            {title}
            {titleGloss && <StageGloss text={titleGloss} />}
          </h2>
        </div>
        <div className="flex items-center gap-[10px] flex-wrap">
          {llmBadge}
          <span
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-medium"
            style={{ background: pill.bg, color: pill.fg }}
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: pill.dot }} />
            {stateLabel}
          </span>
          {meta && <span className="font-mono text-[11.5px] text-[var(--ink-3)]">{meta}</span>}
        </div>
      </header>
      <div className="px-[22px] pt-2 pb-[20px]">{children}</div>
    </section>
  );
}

/**
 * StageSection — one labelled slot inside a stage's body. Stages stack
 * multiple sections; each one has a uppercase mono label and freeform
 * content. Sections separate via top border (except the first).
 */
export function StageSection({
  label, children, labelExtra,
}: {
  label: string;
  /** Right-side content in the label row, e.g. a model chip. */
  labelExtra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="pt-[14px] [&+&]:mt-1 [&+&]:border-t [&+&]:border-[var(--line-2)]">
      <div className="font-mono text-[10px] font-medium tracking-[0.1em] text-[var(--ink-3)] uppercase mb-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5">{label}</span>
        {labelExtra}
      </div>
      <div className="text-[14px] text-[var(--ink-2)] leading-[1.55]">{children}</div>
    </div>
  );
}

/**
 * StageDecision — the dramatic-beat callout. Every stage with a non-
 * trivial outcome closes with one of these. Tone signals what happened:
 *   good  : everything passed, moving to next stage
 *   warn  : something flagged but not fatal (gate warned, top-2 tied)
 *   bad   : refused / abstained / failed
 */
export function StageDecision({
  tone, title, children,
}: {
  tone: 'good' | 'warn' | 'bad';
  title: string;
  children?: ReactNode;
}) {
  const palette = STATE_PILL[tone];
  return (
    <div
      className="rounded-[var(--radius)] mt-[10px]"
      style={{
        background: palette.bg,
        border: `1px solid color-mix(in oklab, ${palette.dot} 35%, transparent)`,
        color: palette.fg,
        padding: '14px 16px',
      }}
    >
      <div className="text-[13.5px] font-semibold mb-1.5 flex items-center gap-2">{title}</div>
      {children && <div className="text-[13.5px] leading-[1.55]">{children}</div>}
    </div>
  );
}

/**
 * StageHandoff — the small pill at the end of a stage that links to
 * the next one. Provides the flow narrative "this leads to that".
 */
export function StageHandoff({
  href, label,
}: {
  href: string;
  label: string;
}) {
  return (
    <a
      href={href}
      className="inline-flex items-center gap-2 mt-[10px] px-3 py-1.5 rounded-full bg-[var(--line-2)] border border-[var(--line)] text-[12.5px] text-[var(--ink-2)] hover:border-[var(--ink-3)] hover:text-[var(--ink)] no-underline transition-colors duration-150"
    >
      <span>{label}</span>
      <span className="font-mono text-[var(--ink-3)] rtl:scale-x-[-1]">→</span>
    </a>
  );
}

/**
 * StageRaw — collapsed disclosure for the raw stage payload. Sits at
 * the bottom of every block. Closed by default to keep blocks scannable.
 */
export function StageRaw({
  data, showLabel, hideLabel,
}: {
  data: unknown;
  showLabel: string;
  hideLabel: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="mt-4 pt-[14px] border-t border-[var(--line-2)]"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="list-none cursor-pointer font-mono text-[11px] tracking-[0.06em] text-[var(--ink-3)] uppercase select-none [&::-webkit-details-marker]:hidden">
        <span className="font-mono">{open ? '▾ ' : '▸ '}</span>
        {open ? hideLabel : showLabel}
      </summary>
      <pre className="mt-3 p-3 rounded-[var(--radius)] bg-[var(--line-2)] border border-[var(--line)] font-mono text-[11.5px] leading-[1.55] text-[var(--ink-2)] whitespace-pre-wrap overflow-x-auto">
        {JSON.stringify(data, null, 2)}
      </pre>
    </details>
  );
}

/**
 * StageChecks — pass/fail/warn rows shared by the gate and picker.
 * Three columns: icon · label · rule.
 *
 * `unknown` is for rows where we don't have enough information to
 * assert pass or fail — e.g. the gate's pass/fail status when the
 * backend hasn't recorded the threshold this request was evaluated
 * against. Renders a muted em-dash icon and dims the label, with
 * the rule slot showing "(threshold not recorded)" or similar
 * honest disclosure (caller's responsibility).
 */
export type CheckState = 'pass' | 'fail' | 'warn' | 'unknown';

export function StageChecks({
  rows,
}: {
  rows: Array<{ state: CheckState; label: ReactNode; rule?: ReactNode }>;
}) {
  return (
    <div className="grid items-baseline gap-y-1.5 gap-x-2.5"
         style={{ gridTemplateColumns: '16px 1fr auto' }}>
      {rows.map((r, i) => {
        const colour =
          r.state === 'pass'    ? 'oklch(0.42 0.12 155)' :
          r.state === 'fail'    ? 'oklch(0.42 0.14 25)'  :
          r.state === 'warn'    ? 'oklch(0.42 0.13 60)'  :
                                  'var(--ink-3)';
        const sym =
          r.state === 'pass'    ? '✓' :
          r.state === 'fail'    ? '✗' :
          r.state === 'warn'    ? '⚠' :
                                  '—';
        const labelMuted = r.state === 'unknown';
        return (
          <div key={i} className="contents">
            <span className="font-mono text-[13px] leading-[1]" style={{ color: colour }}>{sym}</span>
            <span
              className="text-[13.5px]"
              style={{ color: labelMuted ? 'var(--ink-3)' : 'var(--ink-2)' }}
            >
              {r.label}
            </span>
            {r.rule
              ? <span className="font-mono text-[11.5px] text-[var(--ink-3)] whitespace-nowrap">{r.rule}</span>
              : <span />}
          </div>
        );
      })}
    </div>
  );
}

/**
 * StageGloss — the (?) inline glossary marker. Hover/long-press shows
 * the definition via the native `title` tooltip. We deliberately avoid
 * a custom popover so screen readers and reduced-motion users get a
 * native experience, and so the trace page stays JS-light.
 */
export function StageGloss({ text }: { text: string }) {
  return (
    <span
      title={text}
      className="inline-flex items-center justify-center w-[14px] h-[14px] rounded-full border border-[var(--line)] font-mono text-[9px] text-[var(--ink-3)] cursor-help align-baseline hover:border-[var(--ink-3)] hover:text-[var(--ink-2)]"
      aria-label="Glossary definition available"
    >
      ?
    </span>
  );
}
