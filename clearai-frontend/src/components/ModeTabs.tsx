/**
 * ModeTabs.tsx — Generate / Expand / Batch mode switcher
 *
 * RESPONSIBILITIES:
 *   - Renders the three mode pills (Generate, Expand, Batch).
 *   - Tracks active mode and calls onModeChange when the user switches.
 *   - Displays the mode number in monospace and an optional "BETA" badge.
 *   - All labels driven by useT() for EN/AR.
 *
 * STATE OWNED: none — controlled via props (parent ClassifyApp owns mode).
 *
 * NOT YET IMPLEMENTED:
 *   - Active indicator animation (CSS transition on the white pill).
 *   - Keyboard navigation (arrow keys between tabs per ARIA tablist spec).
 */

import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export type ClassifyMode = 'generate' | 'expand' | 'batch';

interface ModeTabsProps {
  mode: ClassifyMode;
  onModeChange: (mode: ClassifyMode) => void;
  className?: string;
}

const MODES: Array<{ id: ClassifyMode; num: string; labelKey: 'mode_generate' | 'mode_expand' | 'mode_batch'; badge?: string }> = [
  { id: 'generate', num: '01', labelKey: 'mode_generate' },
  { id: 'expand',   num: '02', labelKey: 'mode_expand' },
  { id: 'batch',    num: '03', labelKey: 'mode_batch', badge: 'BETA' },
];

export default function ModeTabs({ mode, onModeChange, className }: ModeTabsProps) {
  const t = useT();

  return (
    <div
      role="tablist"
      aria-label="Classification mode"
      className={cn(
        'inline-flex items-center gap-0.5 p-1',
        'bg-[var(--line-2)] border border-[var(--line)] rounded-full',
        'mb-[18px]',
        className,
      )}
    >
      {MODES.map(({ id, num, labelKey, badge }) => (
        <button
          key={id}
          role="tab"
          aria-selected={mode === id}
          type="button"
          onClick={() => onModeChange(id)}
          className={cn(
            'inline-flex items-center gap-2 px-4 py-[7px] rounded-full',
            'border-0 text-[13px] font-medium transition-colors duration-150',
            mode === id
              ? 'bg-[var(--surface)] text-[var(--ink)] shadow-[0_1px_0_rgba(20,16,12,0.04),0_1px_2px_rgba(20,16,12,0.06)]'
              : 'bg-transparent text-[var(--ink-2)] hover:text-[var(--ink)]',
          )}
        >
          <span
            className={cn(
              'font-mono text-[11px] font-medium',
              mode === id ? 'text-[var(--accent)]' : 'text-[var(--ink-3)]',
            )}
          >
            {num}
          </span>
          <span>{t(labelKey)}</span>
          {badge && (
            <span className="text-[10.5px] font-medium text-[var(--ink-3)] bg-[var(--line)] px-[7px] py-0.5 rounded-full ms-0.5 uppercase tracking-[0.04em]">
              {badge}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
