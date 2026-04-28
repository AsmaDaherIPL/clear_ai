/**
 * Footer.tsx — page footer
 *
 * RESPONSIBILITIES:
 *   - Renders copyright line.
 *   - All text driven by useT() for EN/AR support.
 *
 * STATE OWNED: none — purely presentational.
 *
 * NOTE: Nav links (Pricing / API / Changelog / Contact) removed — stub
 * hrefs were never wired and added visual noise. Re-add when the pages
 * exist; restore f_pricing / f_api / f_changelog / f_contact keys to
 * en.json and ar.json at the same time.
 */

import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface FooterProps {
  className?: string;
}

export default function Footer({ className }: FooterProps) {
  const t = useT();

  return (
    <footer
      className={cn(
        'max-w-[1180px] mx-auto mt-20 px-7 pb-10 pt-6',
        'flex items-center justify-end gap-4 flex-wrap',
        'text-[var(--ink-3)] text-[12.5px]',
        'border-t border-[var(--line)]',
        className,
      )}
    >
      <div>{t('f_copy')}</div>
    </footer>
  );
}
