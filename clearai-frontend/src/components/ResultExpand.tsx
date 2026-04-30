/** Expand mode result card — placeholder layout until wired to ExpandBoostResponse. */

import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface ResultExpandProps {
  visible: boolean;
  className?: string;
}

export default function ResultExpand({ visible, className }: ResultExpandProps) {
  const t = useT();

  if (!visible) return null;

  return (
    <div
      className={cn(
        'bg-[var(--surface)] border border-[var(--line)] rounded-[var(--radius-lg)] overflow-hidden',
        'animate-[fadeUp_0.35s_ease_both]',
        className,
      )}
    >
      <div className="px-[22px] py-[18px] border-b border-[var(--line-2)]">
        <div className="flex items-center justify-between gap-3 mb-2.5">
          <span className="font-mono text-[11px] text-[var(--ink-3)] tracking-[0.06em] uppercase">
            {t('res_expanded')}
          </span>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[oklch(0.95_0.05_155)] text-[oklch(0.42_0.12_155)] text-[12px] font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-[oklch(0.55_0.15_155)]" />
            <span>{t('match_strong')}</span>
          </span>
        </div>
      </div>

      <div className="px-[22px] py-[18px] flex flex-col gap-[18px]">
        <p className="text-[13px] text-[var(--ink-3)] italic">
          ResultExpand stub — wire to ExpandBoostResponse in the next pass.
        </p>
        <div>
          <div className="font-mono text-[11px] text-[var(--ink-3)] tracking-[0.06em] uppercase mb-1.5">
            {t('res_input')}
          </div>
          <div className="text-[14.5px] text-[var(--ink)] leading-[1.55]">
            Parent code + description will appear here.
          </div>
        </div>
        <div>
          <div className="font-mono text-[11px] text-[var(--ink-3)] tracking-[0.06em] uppercase mb-1.5">
            {t('res_rationale')}
          </div>
          <div className="text-[14px] text-[var(--ink-2)] leading-[1.6] bg-[var(--line-2)] border border-[var(--line)] rounded-[var(--radius)] px-4 py-3.5">
            Rationale will appear here once wired to the API response.
          </div>
        </div>
        <div>
          <div className="font-mono text-[11px] text-[var(--ink-3)] tracking-[0.06em] uppercase mb-1.5">
            {t('res_alts')}
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="text-[13px] text-[var(--ink-3)]">Sibling leaves will appear here.</div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 px-[22px] py-3.5 border-t border-[var(--line-2)] bg-[var(--line-2)]">
        <div className="text-[12.5px] text-[var(--ink-3)] inline-flex items-center gap-2.5">
          <span><b className="text-[var(--ink-2)] font-medium">{t('meta_latency')}</b> —</span>
          <span>·</span>
          <span><b className="text-[var(--ink-2)] font-medium">{t('meta_candidates')}</b> —</span>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full border border-[var(--line)] bg-[var(--surface)] text-[13px] font-medium text-[var(--ink-2)] hover:border-[var(--ink-3)] hover:text-[var(--ink)] transition-colors duration-150"
          >
            {t('act_copy')}
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full border-0 bg-[var(--accent)] text-white text-[13px] font-medium shadow-[0_4px_10px_-3px_rgba(233,123,58,0.4)] hover:bg-[var(--accent-ink)] transition-colors duration-150"
          >
            {t('act_save')}
          </button>
        </div>
      </div>
    </div>
  );
}
