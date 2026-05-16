/**
 * Sticky top navigation: brand mark + LanguageToggle + signed-in
 * user info, with scroll-triggered border.
 *
 * The user/sign-out section only renders once MSAL has initialised
 * AND there's an active account. Before init we render a placeholder
 * sized to the eventual content so the topbar doesn't jump when MSAL
 * resolves; on the login screen the section stays empty (no name to
 * show, no token to revoke).
 */

import { useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import LanguageToggle from './LanguageToggle';
import { ensureInitialized, getActiveAccount, signOut } from '@/lib/auth';

interface TopBarProps {
  className?: string;
}

export default function TopBar({ className }: TopBarProps) {
  const t = useT();
  const [scrolled, setScrolled] = useState(false);
  const [accountName, setAccountName] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 0);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Subscribe to MSAL: pull the active account once it's available.
  // Defensive — auth.ts throws at module-eval time if PUBLIC_ENTRA_*
  // vars are missing, so we wrap in try/catch to keep the topbar
  // rendering even in a misconfigured-build state.
  useEffect(() => {
    let alive = true;
    ensureInitialized()
      .then(() => {
        if (!alive) return;
        setAccountName(getActiveAccount()?.name ?? null);
        setAuthReady(true);
      })
      .catch(() => {
        if (!alive) return;
        setAuthReady(true);
      });
    return () => { alive = false; };
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

        <div className="flex items-center gap-3">
          {authReady && accountName && (
            <div className="flex items-center gap-2.5">
              <span
                className="text-[13px] text-[var(--ink-2)] max-w-[180px] truncate"
                title={accountName}
              >
                {accountName}
              </span>
              <button
                type="button"
                onClick={() => { void signOut(); }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[var(--surface)] border border-[var(--line)] text-[12.5px] font-medium text-[var(--ink-2)] transition-colors duration-150 hover:bg-[var(--line-2)] hover:border-[var(--ink-3)]"
              >
                {t('signout')}
              </button>
            </div>
          )}
          {/* LanguageToggle hidden — will re-enable when i18n launch is ready */}
          {/* <LanguageToggle /> */}
        </div>
      </div>
    </header>
  );
}
