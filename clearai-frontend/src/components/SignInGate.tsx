/**
 * Auth wall. Children render only when MSAL has an active account.
 *
 * Three states:
 *   - 'initialising' — MSAL hasn't finished `handleRedirectPromise`
 *     yet. Render nothing; the page is empty for ~50–200ms on cold
 *     load, ~0ms on warm. Avoids a sign-in flash for already-signed
 *     -in users.
 *   - 'unauthenticated' — no account in cache. Render the login card.
 *   - 'authenticated' — account present, render children.
 *
 * Visual language is taken from diagrams:mockups/Login.html: cream
 * page surface, ink-on-cream typography, mockup's eyebrow chip + card
 * + dark `--ink` Microsoft button + the SSO redirect hint. No new
 * design tokens introduced.
 */
import { useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';
import { ensureInitialized, getActiveAccount, signIn } from '@/lib/auth';

type GateState = 'initialising' | 'unauthenticated' | 'authenticated';

interface SignInGateProps {
  children: React.ReactNode;
}

export default function SignInGate({ children }: SignInGateProps) {
  const t = useT();
  const [state, setState] = useState<GateState>('initialising');
  const [signingIn, setSigningIn] = useState(false);

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

  if (state === 'initialising') {
    // Empty render — no flash. The page background (cream) is already
    // visible from the Layout shell.
    return null;
  }

  if (state === 'unauthenticated') {
    return (
      <main
        className="grid place-items-center px-7 pt-10 pb-20"
        style={{ minHeight: 'calc(100vh - 76px)' }}
      >
        <div className="w-full max-w-[420px] flex flex-col gap-7">

          {/* Eyebrow chip — matches landing-page hero language. */}
          <span className="self-center inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-[var(--surface)] border border-[var(--line)] text-[12.5px] text-[var(--ink-2)]">
            <span
              className="w-1.5 h-1.5 rounded-full bg-[var(--accent)]"
              style={{
                boxShadow: '0 0 0 3px color-mix(in oklab, var(--accent) 20%, transparent)',
              }}
            />
            <span>
              {t('login_eyebrow_prefix')} <b className="font-semibold text-[var(--ink)]">{t('login_eyebrow_provider')}</b>
            </span>
          </span>

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
                try {
                  await signIn();
                  // signIn() redirects away — anything below here only
                  // runs if MSAL choked before the navigation.
                } catch {
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
      </main>
    );
  }

  return <>{children}</>;
}
