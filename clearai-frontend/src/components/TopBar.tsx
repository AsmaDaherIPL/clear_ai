/** Sticky top navigation: brand mark + LanguageToggle, with scroll-triggered border. */

import { useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import LanguageToggle from './LanguageToggle';

interface TopBarProps {
  className?: string;
}

export default function TopBar({ className }: TopBarProps) {
  const t = useT();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 0);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header
      className={cn(
        'sticky top-0 z-20',
        'bg-[color-mix(in_oklab,var(--bg)_88%,transparent)]',
        'backdrop-blur-[10px] backdrop-saturate-[140%]',
        'border-b border-transparent transition-[border-color] duration-200',
        scrolled && 'border-[var(--line)]',
        className,
      )}
    >
      <div className="max-w-[1180px] mx-auto px-7 py-[18px] flex items-center justify-between gap-6">
        <a
          href="/"
          className="inline-flex items-center gap-2.5 font-semibold text-base tracking-tight text-[var(--ink)] no-underline"
        >
          <svg
            width="22"
            height="23"
            viewBox="0 0 60 63"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="flex-shrink-0"
            aria-hidden="true"
          >
            <rect width="60" height="11.55" rx="2.8" fill="currentColor" />
            <rect x="12.75" y="17.15" width="47.25" height="11.55" rx="2.8" fill="currentColor" fillOpacity={0.7} />
            <rect x="28.5" y="34.3" width="31.5" height="11.55" rx="2.8" fill="currentColor" fillOpacity={0.4} />
            <rect x="44.25" y="51.45" width="15.75" height="11.55" rx="2.8" fill="var(--accent)" />
            <circle cx="52.125" cy="57.225" r="3.5" fill="var(--bg)" fillOpacity={0.9} />
          </svg>
          <span>{t('brand')}</span>
        </a>

        <div className="flex items-center gap-2">
          <LanguageToggle />
        </div>
      </div>
    </header>
  );
}
