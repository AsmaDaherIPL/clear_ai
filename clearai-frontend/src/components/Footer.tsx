/** Page footer: copyright line. */

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
