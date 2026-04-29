/**
 * TraceSpine.tsx — at-a-glance flow strip at the top of the trace page.
 *
 * Shows every stage that ran (or was skipped) as a clickable pill, with
 * arrows between them. Tells the story in one line:
 *
 *    [✓ Understand · 340ms] → [✓ Search · 280ms] → [⚠ Gate · tied] → [✓ Picker · 3.41s] → [✓ Result · 6109…]
 *
 * Each pill links to the corresponding StageBlock further down (anchor
 * jumps via `#stage-N`).
 */
import { cn } from '@/lib/utils';

type SpineState = 'good' | 'warn' | 'bad' | 'skipped' | 'current';

const TONE: Record<Exclude<SpineState, 'current'>, { dot: string; border: string; fg: string }> = {
  good:    { dot: 'oklch(0.55 0.15 155)', border: 'var(--line)',         fg: 'var(--ink-2)' },
  warn:    { dot: 'oklch(0.62 0.16 60)',  border: 'oklch(0.62 0.16 60)', fg: 'oklch(0.42 0.13 60)' },
  bad:     { dot: 'oklch(0.55 0.18 25)',  border: 'oklch(0.55 0.18 25)', fg: 'oklch(0.42 0.14 25)' },
  skipped: { dot: 'var(--ink-3)',          border: 'var(--line)',         fg: 'var(--ink-3)' },
};

export interface SpinePillSpec {
  /** Anchor target — typically `#stage-N`, or `#result` for the terminal pill. */
  href: string;
  /** 1-indexed stage number, e.g. "1" / "2". The terminal Result pill has no number. */
  num?: string;
  /** Plain title — "Understand", "Search", "Gate", etc. */
  label: string;
  /** Right-side meta — "340 ms" / "tied" / "skipped" / "640200000000". */
  meta?: string;
  state: SpineState;
}

export function TraceSpine({ pills }: { pills: SpinePillSpec[] }) {
  return (
    <nav
      aria-label="Pipeline overview"
      className="flex items-center gap-2 px-4 py-3 bg-[var(--surface)] border border-[var(--line)] rounded-[var(--radius)] overflow-x-auto"
    >
      {pills.map((pill, i) => {
        // Terminal "Result" pill has no following arrow.
        const isLast = i === pills.length - 1;
        return (
          <span key={`${pill.label}-${i}`} className="contents">
            <SpinePill {...pill} />
            {!isLast && <span aria-hidden className="font-mono text-[var(--ink-3)] flex-shrink-0 rtl:scale-x-[-1]">→</span>}
          </span>
        );
      })}
    </nav>
  );
}

function SpinePill({ href, num, label, meta, state }: SpinePillSpec) {
  // `current` is a stylistic modifier on top of the underlying state —
  // keeps the dot/border colour from the state but adds the brand-soft
  // background highlight. Resolved here so callers don't have to combine.
  const baseState = state === 'current' ? 'good' : state;
  const t = TONE[baseState];
  const isCurrent = state === 'current';
  return (
    <a
      href={href}
      className={cn(
        'inline-flex items-center gap-2 px-2.5 py-1.5 rounded-full border text-[12.5px] no-underline flex-shrink-0',
        'transition-colors duration-150 hover:[border-color:var(--ink-3)] hover:text-[var(--ink)]',
      )}
      style={{
        borderColor: isCurrent ? 'var(--accent)' : t.border,
        background: isCurrent ? 'var(--accent-soft)' : 'transparent',
        color: t.fg,
      }}
    >
      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: t.dot }} />
      {num && <span className="font-mono text-[10px] text-[var(--ink-3)] tracking-[0.08em]">{num}</span>}
      <span>{label}</span>
      {meta && <span className="font-mono text-[10.5px] text-[var(--ink-3)] ms-1">{meta}</span>}
    </a>
  );
}
