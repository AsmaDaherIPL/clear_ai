/**
 * Language indicator — EN only for now. AR is display-only and non-interactive.
 * Switching to AR is disabled until RTL launch is ready.
 */

import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface LanguageToggleProps {
  className?: string;
  showLabel?: boolean;
}

export default function LanguageToggle({ className }: LanguageToggleProps) {
  const t = useT();

  return (
    <div
      className={cn(
        'inline-flex items-center gap-1.5',
        'px-3 py-1.5 rounded-full',
        'bg-[var(--surface)] border border-[var(--line)]',
        'text-[13px] font-medium select-none',
        className,
      )}
      aria-label={t('langLabel')}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="w-3.5 h-3.5 flex-shrink-0 opacity-50"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
      </svg>
      <span className="text-[var(--ink)]">EN</span>
      <span className="text-[var(--ink-3)]">/</span>
      <span className="text-[var(--ink-3)] opacity-40">AR</span>
    </div>
  );
}
