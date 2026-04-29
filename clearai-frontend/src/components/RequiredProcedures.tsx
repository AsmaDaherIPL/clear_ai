/**
 * RequiredProcedures.tsx — broker-actionable customs procedures list
 *
 * Renders the `result.procedures` array attached to a ZATCA HS leaf
 * (SFDA approval, Ministry of Environment quarantine, livestock export
 * approval, etc). Two consumers, two modes:
 *
 *   mode="result" (default)
 *     Used by the main ResultSingle card. Active procedures appear in
 *     the primary list; repealed entries are hidden behind a small
 *     disclosure ("Show {n} historical procedures (repealed)") so the
 *     broker isn't misled into thinking a superseded rule still
 *     applies. Click expands to show them greyed-out.
 *
 *   mode="trace"
 *     Used by TracePage for full audit fidelity. Repealed entries are
 *     rendered inline alongside active ones (still greyed-out, still
 *     badged "Repealed") with no toggle — operators inspecting a trace
 *     want to see the complete catalogue state at decision time.
 *
 * The `description_ar` text is rendered RTL + Arabic font regardless
 * of the user's UI locale because ZATCA only publishes these
 * descriptions in Arabic. We never machine-translate, never show
 * "[no translation]" placeholders.
 *
 * The KEY IS OMITTED ENTIRELY when no procedures apply, so the caller
 * branches on `procedures && procedures.length` and only mounts this
 * component when there's something to render — there is no empty
 * state to design for here.
 *
 * Order of the input array is meaningful (most-blocking first); we
 * never sort or reorder.
 */
import { useState } from 'react';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { ProcedureRef } from '@/lib/api';

interface RequiredProceduresProps {
  procedures: ProcedureRef[];
  /**
   * 'result' (default) hides repealed entries behind a disclosure;
   * 'trace' renders them inline. See file header.
   */
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

  // Defensive: if the caller forgot to gate on length, we still no-op.
  if (!procedures || procedures.length === 0) return null;

  const active   = procedures.filter((p) => !p.is_repealed);
  const repealed = procedures.filter((p) =>  p.is_repealed);

  // In result mode, only show repealed when toggled on.
  // In trace mode, always show repealed inline.
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
        // Subtle compliance signal — not a card, not a banner. A
        // slightly tinted block with a hairline border, sitting in
        // the body flow below the duty chip. NOT red, NOT all-caps.
        // This is broker-routine; the visual register matches the
        // duty meta strip but pulls a touch more weight via the
        // tinted background.
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

      {/*
        Disclosure toggle for repealed entries — only shown in result
        mode (trace renders them inline). Even when there are no
        repealed entries, we don't render the toggle — keeps the
        section minimal for the common case.
      */}
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

/**
 * One procedure row: small mono code chip on the start side, Arabic
 * description on the end side. The chip mirrors the existing
 * `MetaChip` (duty / procedures) geometry exactly so the visual
 * language stays consistent.
 *
 * `muted=true` when the procedure is repealed — chip and text dim,
 * description gets line-through, a small "Repealed" badge sits next
 * to the code chip. We deliberately avoid a red treatment: repealed
 * isn't an error, it's historical context.
 */
function ProcedureRow({ proc, muted }: { proc: ProcedureRef; muted: boolean }) {
  const t = useT();
  return (
    <li
      className={cn(
        'flex items-start gap-3 py-1',
        muted && 'opacity-60',
      )}
    >
      {/* Code chip — same geometry as the duty MetaChip. */}
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

      {/* Arabic description, RTL + Arabic font, never truncated. */}
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
