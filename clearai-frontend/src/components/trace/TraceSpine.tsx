/** Top-of-trace flow strip. Each pill links to its StageBlock via #stage-N. */
import { cn } from '@/lib/utils';

type SpineState = 'good' | 'warn' | 'bad' | 'skipped' | 'current';

const TONE: Record<Exclude<SpineState, 'current'>, { dot: string; border: string; fg: string }> = {
  good:    { dot: 'oklch(0.55 0.15 155)', border: 'var(--line)',         fg: 'var(--ink-2)' },
  warn:    { dot: 'oklch(0.62 0.16 60)',  border: 'oklch(0.62 0.16 60)', fg: 'oklch(0.42 0.13 60)' },
  bad:     { dot: 'oklch(0.55 0.18 25)',  border: 'oklch(0.55 0.18 25)', fg: 'oklch(0.42 0.14 25)' },
  skipped: { dot: 'var(--ink-3)',          border: 'var(--line)',         fg: 'var(--ink-3)' },
};

export interface SpinePillSpec {
  href: string;
  /** 1-indexed; terminal Result pill omits. */
  num?: string;
  label: string;
  /** Right-side meta — latency, status, or chosen code. */
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
