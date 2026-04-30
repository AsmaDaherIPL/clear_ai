/** Renders broker-actionable customs procedures attached to a ZATCA HS leaf. */
import { useState } from 'react';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { ProcedureRef } from '@/lib/api';

interface RequiredProceduresProps {
  /** Order is meaningful (most-blocking first); never reorder. */
  procedures: ProcedureRef[];
  /** 'result' hides repealed entries behind a toggle; 'trace' renders them inline. */
  mode?: 'result' | 'trace';
  className?: string;
}

export default function RequiredProcedures({
  procedures,
  mode = 'result',
  className,
}: RequiredProceduresProps) {
  const t = useT();
  const [showRepealed, setShowRepealed] = useState(false);

  if (!procedures || procedures.length === 0) return null;

  const active   = procedures.filter((p) => !p.is_repealed);
  const repealed = procedures.filter((p) =>  p.is_repealed);

  const showInlineRepealed = mode === 'trace';
  const visibleProcs: Array<{ p: ProcedureRef; muted: boolean }> = [
    ...active.map((p) => ({ p, muted: false })),
    ...(showInlineRepealed
      ? repealed.map((p) => ({ p, muted: true }))
      : showRepealed
        ? repealed.map((p) => ({ p, muted: true }))
        : []),
  ];

  return (
    <section
      className={cn(
        'rounded-[var(--radius)] border border-[var(--line)] bg-[color-mix(in_oklab,var(--line-2)_60%,var(--surface))]',
        'px-4 py-3.5',
        'animate-[fadeUp_0.35s_ease_both]',
        className,
      )}
      aria-label={t('result.procedures.title' as Parameters<typeof t>[0])}
    >
      <div className="font-mono text-[10px] font-medium tracking-[0.1em] uppercase text-[var(--ink-3)] mb-2.5">
        {t('result.procedures.title' as Parameters<typeof t>[0])}
        <span className="ms-2 text-[var(--ink-2)]" style={{ fontFamily: 'inherit' }}>
          · {active.length}
        </span>
      </div>

      <ul className="flex flex-col gap-2 list-none p-0 m-0">
        {visibleProcs.map(({ p, muted }) => (
          <ProcedureRow key={`${p.code}-${p.is_repealed}`} proc={p} muted={muted} />
        ))}
      </ul>

      {/* Disclosure toggle for repealed entries — result mode only. */}
      {mode === 'result' && repealed.length > 0 && (
        <button
          type="button"
          onClick={() => setShowRepealed((s) => !s)}
          className="mt-3 font-mono text-[11px] tracking-[0.06em] uppercase text-[var(--ink-3)] hover:text-[var(--ink-2)] bg-transparent border-0 cursor-pointer p-0 transition-colors duration-150"
          aria-expanded={showRepealed}
        >
          {showRepealed
            ? '▾ '
            : '▸ '}
          {t('result.procedures.repealed.toggle' as Parameters<typeof t>[0])
            .replace('{n}', String(repealed.length))}
        </button>
      )}
    </section>
  );
}

/** One procedure row: code chip + Arabic description, optionally muted when repealed. */
function ProcedureRow({ proc, muted }: { proc: ProcedureRef; muted: boolean }) {
  const t = useT();
  return (
    <li
      className={cn(
        'flex items-start gap-3 py-1',
        muted && 'opacity-60',
      )}
    >
      <span
        className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full border border-[var(--line)] bg-[var(--surface)] text-[12px] flex-shrink-0"
      >
        <span className="font-mono text-[10px] font-medium tracking-[0.08em] uppercase text-[var(--ink-3)]">
          {t('result.procedures.codeLabel' as Parameters<typeof t>[0])}
        </span>
        <span className="font-mono font-medium text-[var(--ink)]">{proc.code}</span>
      </span>

      {muted && (
        <span className="font-mono text-[10px] font-medium tracking-[0.08em] uppercase px-2 py-0.5 rounded-full bg-[var(--line-2)] text-[var(--ink-3)] flex-shrink-0 mt-0.5">
          {t('result.procedures.repealedBadge' as Parameters<typeof t>[0])}
        </span>
      )}

      <p
        dir="rtl"
        lang="ar"
        className={cn(
          'flex-1 min-w-0 text-[14px] leading-[1.6] text-[var(--ink)] m-0',
          muted && 'line-through',
        )}
        style={{ fontFamily: "'IBM Plex Sans Arabic', sans-serif" }}
      >
        {proc.description_ar}
      </p>
    </li>
  );
}
