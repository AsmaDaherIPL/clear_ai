/**
 * TopBar.tsx — sticky navigation bar
 *
 * RESPONSIBILITIES:
 *   - Renders the brand mark (ink square + orange accent dot) and wordmark.
 *   - Houses the LanguageToggle.
 *   - Applies a scrolled border when the page scrolls past 0 (scroll listener).
 *   - Fully translatable via useT().
 *
 * STATE OWNED:
 *   - scrolled: boolean — controls border-bottom visibility.
 *
 * Sign-in CTA removed — no auth backend is wired and the design's primary
 * pill button was creating visual clutter against an unimplemented flow.
 * Restore as a primary pill on the right side of the topbar when auth ships;
 * add the matching i18n entry back to en.json/ar.json at that point.
 */

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
        {/* Brand */}
        <a
          href="/"
          className="inline-flex items-center gap-2.5 font-semibold text-base tracking-tight text-[var(--ink)] no-underline"
        >
          {/* Brand mark: ink square with accent dot */}
          <span className="w-[22px] h-[22px] rounded-[6px] bg-[var(--ink)] inline-flex items-center justify-center relative flex-shrink-0">
            <span className="w-2 h-2 rounded-[2px] bg-[var(--accent)]" />
          </span>
          <span>{t('brand')}</span>
          <span className="text-[var(--ink-3)] font-normal text-[13px] ms-1.5">
            {t('brand_meta')}
          </span>
        </a>

        {/* Right side */}
        <div className="flex items-center gap-2">
          <LanguageToggle />
        </div>
      </div>
    </header>
  );
}
