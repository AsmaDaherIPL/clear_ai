/**
 * LoginPage — full-screen authentication gate.
 *
 * Visual pattern from the prototype:
 *   - Centered card on the cream background
 *   - Brand logo + wordmark above the card
 *   - Card: title, subtitle, Microsoft SSO button, redirect hint
 *   - Subtle geometric background grid for depth
 *
 * This component owns its own auth-state detection. It redirects to '/'
 * the moment MSAL resolves an active account, so users who are already
 * signed in (e.g. refreshed on /login) are bounced immediately.
 *
 * All labels come from the i18n store — no hardcoded strings.
 */

import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { useT, type TKey } from '@/lib/i18n';
import { ensureInitialized, getActiveAccount, signIn } from '@/lib/auth';

// ---------------------------------------------------------------------------
// Brand logo mark (canonical, same as AppShell)
// ---------------------------------------------------------------------------

function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      width="36"
      height="38"
      viewBox="0 0 60 63"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn('flex-shrink-0', className)}
      aria-hidden="true"
    >
      <rect width="60" height="11.55" rx="2.8" fill="currentColor" />
      <rect x="12.75" y="17.15" width="47.25" height="11.55" rx="2.8" fill="currentColor" fillOpacity={0.7} />
      <rect x="28.5" y="34.3" width="31.5" height="11.55" rx="2.8" fill="currentColor" fillOpacity={0.4} />
      <rect x="44.25" y="51.45" width="15.75" height="11.55" rx="2.8" fill="var(--accent)" />
      <circle cx="52.125" cy="57.225" r="3.5" fill="var(--bg)" fillOpacity={0.9} />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Microsoft 4-square logo (inline, no extra asset)
// ---------------------------------------------------------------------------

function MicrosoftLogo() {
  return (
    <span
      className="w-[18px] h-[18px] grid grid-cols-2 gap-[2.5px] flex-shrink-0"
      aria-hidden
    >
      <i className="block w-full h-full" style={{ background: '#F25022' }} />
      <i className="block w-full h-full" style={{ background: '#7FBA00' }} />
      <i className="block w-full h-full" style={{ background: '#00A4EF' }} />
      <i className="block w-full h-full" style={{ background: '#FFB900' }} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// LoginPage
// ---------------------------------------------------------------------------

export default function LoginPage() {
  const t = useT();
  const [signingIn, setSigningIn] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);

  // If already authenticated, go home immediately
  useEffect(() => {
    let alive = true;
    ensureInitialized()
      .then(() => {
        if (!alive) return;
        if (getActiveAccount()) {
          window.location.replace('/');
        } else {
          setAuthChecked(true);
        }
      })
      .catch(() => {
        if (!alive) return;
        setAuthChecked(true);
      });
    return () => { alive = false; };
  }, []);

  async function handleSignIn() {
    if (signingIn) return;
    setSigningIn(true);
    // Safety net: if loginRedirect() never fires the navigation within 8s
    // (popup blocker, MSAL iframe timeout, etc.), reset the spinner.
    const safetyReset = window.setTimeout(() => setSigningIn(false), 8000);
    try {
      await signIn();
    } catch {
      window.clearTimeout(safetyReset);
      setSigningIn(false);
    }
  }

  // Don't flash the login UI if auth check is still in-flight
  if (!authChecked) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-[var(--bg)]">
        <span className="w-6 h-6 rounded-full border-2 border-[var(--line)] border-t-[var(--accent)] animate-spin" />
      </div>
    );
  }

  return (
    <div
      className={cn(
        'min-h-dvh flex flex-col items-center justify-center',
        'bg-[var(--bg)] px-4 py-12',
        'relative overflow-hidden',
      )}
    >
      {/* Subtle geometric background — fine grid of dots */}
      <div
        className="absolute inset-0 pointer-events-none select-none"
        aria-hidden
        style={{
          backgroundImage:
            'radial-gradient(circle, oklch(0.82 0.008 70 / 0.55) 1px, transparent 1px)',
          backgroundSize: '28px 28px',
          maskImage: 'radial-gradient(ellipse 70% 70% at 50% 45%, black 40%, transparent 100%)',
          WebkitMaskImage:
            'radial-gradient(ellipse 70% 70% at 50% 45%, black 40%, transparent 100%)',
        }}
      />

      {/* Content column */}
      <div className="relative z-10 w-full max-w-[400px] flex flex-col items-center gap-8">

        {/* Brand mark + wordmark above card */}
        <a
          href="/"
          className={cn(
            'flex flex-col items-center gap-3 no-underline',
            'outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] rounded-lg',
          )}
        >
          <LogoMark className="text-[var(--ink)]" />
          <span className="font-semibold text-[18px] tracking-tight text-[var(--ink)]">
            {t('brand' as TKey)}
          </span>
        </a>

        {/* Card */}
        <div
          className={cn(
            'w-full bg-[var(--surface)] rounded-[var(--radius-lg)]',
            'border border-[var(--line)]',
            'px-8 pt-8 pb-7',
          )}
          style={{ boxShadow: 'var(--shadow-lift)' }}
        >
          {/* Heading */}
          <h1 className="m-0 mb-2 text-[22px] font-semibold tracking-[-0.02em] text-[var(--ink)] text-center rtl:font-bold">
            {t('login_title' as TKey)}
          </h1>
          <p className="mt-0 mb-7 text-[14px] text-[var(--ink-2)] leading-[1.55] text-center">
            {t('login_sub' as TKey)}
          </p>

          {/* SSO button */}
          <button
            type="button"
            onClick={() => { void handleSignIn(); }}
            disabled={signingIn}
            className={cn(
              'w-full inline-flex items-center justify-center gap-3',
              'px-5 py-[13px] rounded-[10px]',
              'bg-[var(--ink)] border border-[var(--ink)]',
              'text-[14px] font-medium tracking-[0.01em]',
              'transition-[background,transform,opacity] duration-150',
              'hover:bg-[oklch(0.28_0.01_60)]',
              'active:translate-y-[1px]',
              'disabled:opacity-65 disabled:cursor-progress',
              'outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2',
            )}
            style={{ color: '#fff', boxShadow: '0 4px 14px -4px rgba(20,16,12,0.28)' }}
          >
            {signingIn ? (
              <>
                <span
                  className="w-4 h-4 rounded-full border-2 border-white/25 border-t-white animate-spin flex-shrink-0"
                  aria-hidden
                />
                <span>{t('login_cta_loading' as TKey)}</span>
              </>
            ) : (
              <>
                <MicrosoftLogo />
                <span>{t('login_cta' as TKey)}</span>
              </>
            )}
          </button>

          {/* Redirect hint */}
          <div className="mt-5 flex items-center justify-center gap-2">
            <svg
              className="w-3 h-3 text-[var(--ink-3)] flex-shrink-0"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <rect x="4" y="11" width="16" height="10" rx="2" />
              <path d="M8 11V7a4 4 0 0 1 8 0v4" />
            </svg>
            <span className="font-mono text-[11.5px] text-[var(--ink-3)] tracking-[0.04em]">
              {t('login_redirect_hint' as TKey)}
            </span>
          </div>
        </div>

        {/* Footer attribution */}
        <p className="text-[12px] text-[var(--ink-3)] text-center">
          {t('brand_meta' as TKey)}
        </p>
      </div>
    </div>
  );
}
