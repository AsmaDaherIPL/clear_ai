/**
 * Composer.tsx — the main input area (textarea + mode-specific extras)
 *
 * RESPONSIBILITIES:
 *   - Renders the shared textarea for Generate and Expand modes.
 *   - In Expand mode, shows an additional "Parent code" input row.
 *   - In Batch mode, shows the dropzone (CSV / Excel upload).
 *   - Renders the submit arrow button.
 *   - Calls onSubmit(description, parentCode?) when the form is submitted.
 *
 * STATE OWNED:
 *   - description: string — textarea value (uncontrolled at the field
 *     level via useState, but the parent receives it on submit).
 *   - parentCode: string — expand mode code input.
 *
 * `loading` from the parent disables the submit button while the API
 * call is in flight; we intentionally don't disable the textarea so the
 * user can keep editing for a follow-up classification.
 *
 * NOT YET IMPLEMENTED:
 *   - Auto-resize textarea on content change.
 *   - Drag-and-drop highlight on the dropzone.
 *   - File parsing (CSV/Excel) for batch mode.
 */

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

// Hard input cap mirrors the backend's zod schema (`describeBody` /
// `expandBody` in clearai-backend/src/routes/schemas.ts). Keeping the
// two in lock-step means the user sees the limit before they hit
// "submit", instead of getting a 400 from the server. If you change
// this, change the backend at the same time.
const DESCRIPTION_MAX = 250;
// Threshold for switching the counter to amber so the user knows
// they're running out of room. 90% = 225 chars; below that, the
// counter is muted ink.
const DESCRIPTION_WARN_AT = Math.floor(DESCRIPTION_MAX * 0.9);

export default function Composer({ mode, onSubmit, loading, className }: ComposerProps) {
  const t = useT();
  const [description, setDescription] = useState('');
  const [parentCode, setParentCode] = useState('');
  // Char count drives both the counter UI and (conceptually) any
  // submit-time validation. Keeping it derived from the controlled
  // textarea state avoids double-counting newlines / paste events.
  const charCount = description.length;
  const nearCap = charCount >= DESCRIPTION_WARN_AT;
  const atCap = charCount >= DESCRIPTION_MAX;
  // In Expand mode the backend rejects parent codes shorter than 4
  // digits with a 400. Block at the form level so the user can't
  // even submit a too-short code — the only valid HS prefixes are
  // 4 / 6 / 8 / 10 / 12 digits (regex in clearai-backend's
  // schemas.ts). Other modes don't use parentCode so this guard
  // collapses to `true`.
  const PARENT_CODE_MIN = 4;
  const parentCodeValid = mode !== 'expand' || parentCode.length >= PARENT_CODE_MIN;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = description.trim();
    if (!trimmed) return;
    // Block too-short parent codes early. The button's `disabled`
    // attribute already gates click submits; this guard catches
    // Enter-key submits + any future programmatic submit() calls.
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
      {/* Generate + Expand: textarea pane */}
      {mode !== 'batch' && (
        <div>
          <div className="px-[22px] pt-[22px] pb-2">
            <textarea
              rows={2}
              value={description}
              maxLength={DESCRIPTION_MAX}
              onChange={(e) =>
                // Belt-and-braces: maxLength on the element already
                // blocks new keystrokes past the cap, but a paste of
                // a longer string can still arrive (some browsers /
                // assistive tech bypass the attribute). Truncating in
                // state guarantees we never hold > DESCRIPTION_MAX.
                setDescription(e.target.value.slice(0, DESCRIPTION_MAX))
              }
              onKeyDown={(e) => {
                // Enter submits the form — Shift+Enter inserts a newline
                // so users can still paste / type multi-line descriptions
                // when they need to. Cmd/Ctrl+Enter also submits, in case
                // a user has the previous behaviour committed to muscle
                // memory. IME composition (Japanese / Chinese / Arabic
                // candidate selection) emits Enter to confirm a candidate
                // — `isComposing` guards against eating that Enter.
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

          {/* Expand-only: parent code row.
              The "4 / 6 / 8 / 10 digits" hint chip used to live on the
              end side; removed because the same constraint is enforced
              by `parentCodeValid` (4-digit minimum) — the user gets
              feedback by the submit button staying disabled until
              they've typed enough digits, no need for ambient text. */}
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

          {/* Meta bar — char counter on the start side, submit on the end.
              Counter swaps from muted ink → amber when within 10% of
              the cap so the user notices they're nearly out of room
              before they hit submit and get a 400 from the backend. */}
          <div className="flex items-center justify-between gap-2 px-3.5 pb-3.5 pt-2">
            <div className="flex items-center gap-1.5">
              <span
                className={cn(
                  'font-mono text-[12px] tabular-nums transition-colors duration-150',
                  atCap
                    ? 'text-[oklch(0.55_0.18_25)] font-medium' // red at the wall
                    : nearCap
                      ? 'text-[oklch(0.62_0.16_60)]'           // amber within 10%
                      : 'text-[var(--ink-3)]',                  // default muted
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
                  // Tiny inline spinner — dotted ring rotating. Keeps the
                  // 36px button footprint stable so the form layout
                  // doesn't shift when the request is in flight.
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

      {/* Batch: dropzone pane */}
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
