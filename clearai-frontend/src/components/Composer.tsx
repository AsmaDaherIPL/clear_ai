/** Main classify input area: textarea, optional parent-code field, batch dropzone. */

import { useState } from 'react';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { ClassifyMode } from './ModeTabs';

interface ComposerProps {
  mode: ClassifyMode;
  onSubmit?: (description: string, parentCode?: string) => void;
  loading?: boolean;
  className?: string;
}

/** Mirrors backend zod cap; keep in lock-step with `describeBody` / `expandBody`. */
const DESCRIPTION_MAX = 250;
const DESCRIPTION_WARN_AT = Math.floor(DESCRIPTION_MAX * 0.9);

export default function Composer({ mode, onSubmit, loading, className }: ComposerProps) {
  const t = useT();
  const [description, setDescription] = useState('');
  const [parentCode, setParentCode] = useState('');
  const charCount = description.length;
  const nearCap = charCount >= DESCRIPTION_WARN_AT;
  const atCap = charCount >= DESCRIPTION_MAX;
  const PARENT_CODE_MIN = 4;
  const parentCodeValid = mode !== 'expand' || parentCode.length >= PARENT_CODE_MIN;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = description.trim();
    if (!trimmed) return;
    if (!parentCodeValid) return;
    onSubmit?.(trimmed, mode === 'expand' ? parentCode.trim() || undefined : undefined);
  };

  return (
    <form
      onSubmit={handleSubmit}
      className={cn(
        'bg-[var(--surface)] border border-[var(--line)] rounded-[var(--radius-lg)]',
        'shadow-[var(--shadow-lift)] text-start',
        'transition-[border-color,box-shadow] duration-150',
        'focus-within:border-[oklch(0.78_0.008_70)]',
        'focus-within:shadow-[0_8px_30px_-10px_rgba(40,28,18,0.16),0_1px_2px_rgba(20,16,12,0.04)]',
        className,
      )}
    >
      {/* Textarea pane — generate + expand modes. */}
      {mode !== 'batch' && (
        <div>
          <div className="px-[22px] pt-[22px] pb-2">
            <textarea
              rows={2}
              value={description}
              maxLength={DESCRIPTION_MAX}
              onChange={(e) =>
                // Truncate in state — paste can bypass the maxLength attribute.
                setDescription(e.target.value.slice(0, DESCRIPTION_MAX))
              }
              onKeyDown={(e) => {
                // Enter submits, Shift+Enter newlines; skip during IME composition.
                if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                if (e.shiftKey) return;
                e.preventDefault();
                handleSubmit(e);
              }}
              placeholder={t('placeholder')}
              className={cn(
                'w-full border-0 outline-none resize-none bg-transparent',
                'text-[17px] leading-[1.5] text-[var(--ink)]',
                'min-h-7 max-h-[180px] font-[inherit]',
                'placeholder:text-[var(--ink-3)]',
              )}
            />
          </div>

          {/* Expand-only parent code row. */}
          {mode === 'expand' && (
            <div className="flex items-center gap-3 px-[22px] py-2.5 border-t border-[var(--line-2)]">
              <label className="font-mono text-[11px] font-medium text-[var(--ink-3)] tracking-[0.06em] uppercase shrink-0">
                {t('parent_label')}
              </label>
              <input
                type="text"
                inputMode="numeric"
                value={parentCode}
                onChange={(e) => setParentCode(e.target.value.replace(/\D/g, '').slice(0, 10))}
                placeholder="e.g. 010121 / 3304993 / 01012110"
                className="flex-1 border-0 outline-none bg-transparent font-mono text-base text-[var(--ink)] tracking-[0.02em] placeholder:text-[var(--ink-3)]"
              />
            </div>
          )}

          {/* Meta bar — char counter + submit. */}
          <div className="flex items-center justify-between gap-2 px-3.5 pb-3.5 pt-2">
            <div className="flex items-center gap-1.5">
              <span
                className={cn(
                  'font-mono text-[12px] tabular-nums transition-colors duration-150',
                  atCap
                    ? 'text-[oklch(0.55_0.18_25)] font-medium'
                    : nearCap
                      ? 'text-[oklch(0.62_0.16_60)]'
                      : 'text-[var(--ink-3)]',
                )}
                aria-live="polite"
              >
                {charCount} / {DESCRIPTION_MAX}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="submit"
                aria-label="Classify"
                disabled={loading || !description.trim() || !parentCodeValid}
                className={cn(
                  'w-9 h-9 rounded-full border-0',
                  'bg-[var(--accent)] text-white',
                  'inline-flex items-center justify-center',
                  'shadow-[0_1px_0_rgba(0,0,0,0.04),0_4px_10px_-3px_rgba(233,123,58,0.5)]',
                  'transition-[transform,background] duration-150',
                  'hover:bg-[var(--accent-ink)] active:scale-95',
                  'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-[var(--accent)] disabled:active:scale-100',
                  'rtl:[&_svg]:scale-x-[-1]',
                )}
              >
                {loading ? (
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    className="w-4 h-4 animate-spin"
                    aria-hidden="true"
                  >
                    <path d="M12 2a10 10 0 0 1 10 10" />
                  </svg>
                ) : (
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="w-4 h-4"
                    aria-hidden="true"
                  >
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Batch dropzone pane. */}
      {mode === 'batch' && (
        <div className="p-3.5">
          <div
            className={cn(
              'border-[1.5px] border-dashed border-[var(--line)] rounded-[var(--radius)]',
              'bg-[var(--line-2)]',
              'py-11 px-6',
              'flex flex-col items-center gap-2.5 text-center',
              'transition-[border-color,background] duration-150',
            )}
          >
            <span className="w-[38px] h-[38px] rounded-full bg-[var(--surface)] border border-[var(--line)] inline-flex items-center justify-center text-[var(--ink-2)]">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </span>
            <h3 className="m-0 mt-1 text-[18px] font-medium tracking-[-0.01em] text-[var(--ink)]">
              {t('drop_title')}
            </h3>
            <p className="m-0 text-[13px] text-[var(--ink-3)]">{t('drop_hint')}</p>
            <button
              type="button"
              className={cn(
                'mt-2.5 border-0',
                'bg-[var(--accent)] text-white',
                'px-[18px] py-2.5 rounded-full',
                'text-[13.5px] font-medium',
                'shadow-[0_4px_10px_-3px_rgba(233,123,58,0.4)]',
                'hover:bg-[var(--accent-ink)] transition-colors duration-150',
              )}
            >
              {t('drop_browse')}
            </button>
          </div>
        </div>
      )}
    </form>
  );
}
