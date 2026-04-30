/** Pill button that copies a string to the clipboard, with a "copied" affordance. */

import { useState } from 'react';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface CopyChipProps {
  text: string;
  /** Sentence-case label; CSS uppercases it. */
  label: string;
  disabled?: boolean;
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
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        /* clipboard denied / unsupported */
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
