/**
 * LanguageToggle.tsx
 *
 * Fully implemented (not a stub) — it is small enough to ship now.
 *
 * RESPONSIBILITIES:
 *   - Reads current locale from the i18n store via getLocale().
 *   - Renders a pill button that always shows the OPPOSITE language label:
 *     when UI is in English → shows "العربية", when Arabic → shows "English".
 *   - onClick: calls setLocale(other), which:
 *       1. Updates the in-memory locale.
 *       2. Writes the lang cookie (persists across reloads).
 *       3. Flips html[lang] and html[dir] immediately.
 *       4. Notifies all useSyncExternalStore subscribers → all React islands
 *          re-render in lock-step with the new locale.
 *
 * STATE OWNED: none — delegates fully to i18n module.
 */

import { useT, getLocale, setLocale, locales, type Locale } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface LanguageToggleProps {
  className?: string;
}

export default function LanguageToggle({ className }: LanguageToggleProps) {
  // Subscribe to locale changes so the label re-renders when the store fires.
  const t = useT();
  const current = getLocale();
  const other = (current === 'en' ? 'ar' : 'en') as Locale;
  const otherLabel = locales[other].label;

  return (
    <button
      type="button"
      aria-label={`Switch to ${otherLabel}`}
      onClick={() => setLocale(other)}
      className={cn(
        'inline-flex items-center gap-1.5',
        'px-3 py-1.5 rounded-full',
        'bg-[var(--surface)] border border-[var(--line)]',
        'text-[13px] font-medium text-[var(--ink-2)]',
        'transition-colors duration-150',
        'hover:bg-[var(--line-2)] hover:border-[var(--ink-3)]',
        className,
      )}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="w-3.5 h-3.5 opacity-70"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
      </svg>
      <span>{t('langLabel')}</span>
    </button>
  );
}
