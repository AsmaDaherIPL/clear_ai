/**
 * Auth-state primitive + login card.
 *
 * Two exports:
 *
 *   useAuthState() — React hook that returns one of:
 *     'initialising' (MSAL not ready yet — render a placeholder),
 *     'unauthenticated' (no account — render the LoginCard),
 *     'authenticated' (account in cache — render the real app).
 *
 *   <LoginCard /> — the eyebrow chip + login card UI shown to
 *     unauthenticated users. Slots into the page layout WHERE the
 *     composer would normally sit, so the page chrome (TopBar, Hero,
 *     Footer) keeps rendering around it. This matches the design
 *     mockup which shows the same hero copy above the login card.
 *
 *   <SignInGate>{children}</SignInGate> — back-compat wrapper. Keeps
 *     children hidden until authenticated. Useful for any page that
 *     wants a full-screen take-over, but the home page now uses the
 *     hook + LoginCard pattern instead so the page chrome stays.
 *
 * Visual language is taken from diagrams:mockups/Login.html: cream
 * page surface, ink-on-cream typography, the eyebrow chip + card +
 * dark `--ink` Microsoft button + the SSO redirect hint. No new
 * design tokens introduced.
 */
import { useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';
import { ensureInitialized, getActiveAccount, signIn } from '@/lib/auth';

export type AuthState = 'initialising' | 'unauthenticated' | 'authenticated';

/**
 * Resolve MSAL state on mount; returns the current auth state. The
 * hook drives ALL three states (initialising → either authenticated
 * or unauthenticated). Callers should branch on the value.
 */
export function useAuthState(): AuthState {
  const [state, setState] = useState<AuthState>('initialising');
  useEffect(() => {
    let alive = true;
    ensureInitialized()
      .then(() => {
        if (!alive) return;
        setState(getActiveAccount() ? 'authenticated' : 'unauthenticated');
      })
      .catch(() => {
        // MSAL.handleRedirectPromise() can throw when the URL fragment
        // is malformed (rare — usually a user pasting a fragmented
        // link). Treat it the same as "not signed in" so the user can
        // retry from the login button.
        if (!alive) return;
        setState('unauthenticated');
      });
    return () => { alive = false; };
  }, []);
  return state;
}

/**
 * Login card — eyebrow chip + Sign-in card with the Microsoft button.
 *
 * Intentionally NOT wrapped in a `<main>` or any layout container.
 * The home page slots this in WHERE the composer would normally
 * render, so the surrounding TopBar + Hero + Footer keep showing.
 * Designs that want a full-screen take-over should add their own
 * outer `<main>` around it.
 */
export function LoginCard() {
  const t = useT();
  const [signingIn, setSigningIn] = useState(false);

  return (
    <div className="w-full max-w-[420px] mx-auto flex flex-col gap-7">
      {/* Login card. */}
      <div
        className="bg-[var(--surface)] border border-[var(--line)] rounded-[var(--radius-lg)] px-9 pt-9 pb-7 text-center"
        style={{ boxShadow: 'var(--shadow-lift)' }}
      >
        <h1 className="m-0 mb-2 text-[26px] font-medium tracking-[-0.02em] text-[var(--ink)] rtl:font-semibold">
          {t('login_title')}
        </h1>
        <p className="mt-0 mb-7 text-[14.5px] text-[var(--ink-2)] leading-[1.55]">
          {t('login_sub')}
        </p>

        <button
          type="button"
          onClick={async () => {
            if (signingIn) return;
            setSigningIn(true);
            // Safety net: if loginRedirect() never navigates within 8s
            // (third-party cookies blocking the iframe, MSAL hung on
            // monitor_window_timeout, popup-blocker eating the redirect),
            // reset the spinner so the user can retry instead of staring
            // at a permanent "Redirecting to Microsoft..." label forever.
            // The successful path navigates away long before this fires.
            const safetyReset = window.setTimeout(() => setSigningIn(false), 8000);
            try {
              await signIn();
              // signIn() redirects away — anything below here only
              // runs if MSAL choked before the navigation.
            } catch {
              window.clearTimeout(safetyReset);
              setSigningIn(false);
            }
          }}
          disabled={signingIn}
          className="w-full inline-flex items-center justify-center gap-3 px-5 py-[13px] bg-[var(--ink)] border border-[var(--ink)] rounded-[10px] text-[14.5px] font-medium tracking-[0.01em] transition-[background,transform] duration-150 hover:bg-[oklch(0.28_0.01_60)] active:translate-y-[1px] disabled:opacity-70 disabled:cursor-progress"
          // Force white text inline because the global reset
          // `button { color: inherit; }` outranks Tailwind's
          // `text-white` utility on the button element. Inline
          // style wins specificity and the label stays legible.
          style={{ color: '#fff', boxShadow: '0 4px 12px -4px rgba(20,16,12,0.25)' }}
        >
          {signingIn ? (
            <>
              <span
                className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin"
                aria-hidden
              />
              <span>{t('login_cta_loading')}</span>
            </>
          ) : (
            <>
              {/* Microsoft 4-square logo, inline so we don't ship an extra asset. */}
              <span
                className="w-[18px] h-[18px] grid grid-cols-2 gap-[2px] flex-shrink-0"
                aria-hidden
              >
                <i className="block w-full h-full" style={{ background: '#F25022' }} />
                <i className="block w-full h-full" style={{ background: '#7FBA00' }} />
                <i className="block w-full h-full" style={{ background: '#00A4EF' }} />
                <i className="block w-full h-full" style={{ background: '#FFB900' }} />
              </span>
              <span>{t('login_cta')}</span>
            </>
          )}
        </button>

        {/* SSO redirect hint. */}
        <div className="mt-4 inline-flex items-center gap-2 font-mono text-[11.5px] text-[var(--ink-3)] tracking-[0.04em]">
          <svg
            className="w-3 h-3"
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
          <span>{t('login_redirect_hint')}</span>
        </div>
      </div>
    </div>
  );
}

interface SignInGateProps {
  children: React.ReactNode;
}

/**
 * Auth gate wrapper.
 *
 * - 'initialising' — renders nothing (avoids layout flash before MSAL resolves).
 * - 'unauthenticated' — redirects to /login. The /login page owns the full
 *   auth UI so the sidebar shell doesn't leak into the login screen.
 * - 'authenticated' — renders children.
 */
export default function SignInGate({ children }: SignInGateProps) {
  const state = useAuthState();
  if (state === 'initialising') {
    return (
      <div className="flex items-center justify-center" style={{ minHeight: '100dvh' }}>
        <span className="w-6 h-6 rounded-full border-2 border-[var(--line)] border-t-[var(--accent)] animate-spin" />
      </div>
    );
  }
  if (state === 'unauthenticated') {
    if (typeof window !== 'undefined') {
      window.location.replace('/login');
    }
    return null;
  }
  return <>{children}</>;
}
