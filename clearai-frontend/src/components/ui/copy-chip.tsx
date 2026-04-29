/**
 * copy-chip.tsx — small uppercase pill-button that copies a string
 *
 * The visual sibling of MetaChip in ResultSingle: rounded-full pill,
 * 10px mono uppercase label + 12px icon, hairline border, surface
 * fill. Used wherever a copy-to-clipboard action sits inside a strip
 * of code-context chips (Copy code next to Duty, Copy AR next to the
 * Arabic submission text). Picking up the same geometry across both
 * places means the duty / copy-code / copy-AR pills all read as one
 * control family.
 *
 * Behaviour:
 *   - On click, writes `text` to the clipboard.
 *   - For 1.5s afterwards, swaps the icon to a checkmark and the
 *     label to t('copied'). Reverts automatically.
 *   - Disabled state mutes the colour and blocks the click; useful
 *     while the source string is still loading.
 */

import { useState } from 'react';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface CopyChipProps {
  /** The string to write to the clipboard on click. */
  text: string;
  /**
   * Uppercase mono label rendered before the icon, e.g. "Copy code"
   * or "Copy AR". Already rendered uppercased by CSS, so pass it in
   * sentence case — i18n strings stay legible in JSON.
   */
  label: string;
  /** When true, the chip renders muted and ignores clicks. */
  disabled?: boolean;
  /** Optional native title= for hover tooltips. */
  title?: string;
  className?: string;
}

const CopyIcon = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </svg>
);

const CheckIcon = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

export function CopyChip({ text, label, disabled, title, className }: CopyChipProps) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  const handleClick = () => {
    if (disabled || !text) return;
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        // Reset the affordance after 1.5s. If the user clicks again
        // mid-fade the timer is replaced — cheap enough to skip the
        // cleanup edge case.
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        /* clipboard denied / unsupported — silent failure is fine */
      });
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      title={title}
      className={cn(
        'inline-flex items-center gap-2 px-2.5 py-1 rounded-full border bg-[var(--surface)] text-[12px] transition-colors duration-150',
        disabled
          ? 'border-[var(--line)] cursor-not-allowed opacity-60'
          : 'border-[var(--line)] hover:border-[var(--ink-3)]',
        className,
      )}
    >
      <span className="font-mono text-[10px] font-medium tracking-[0.08em] uppercase text-[var(--ink-3)]">
        {copied ? t('copied') : label}
      </span>
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}
