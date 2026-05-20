/**
 * LoginPage — full-screen authentication gate.
 *
 * Pixel-matched to the prototype (ClearAI Prototype _standalone_.html):
 *   - Background: #fbf9f6 + two animated blob gradients + warm dot grid
 *   - Top bar: WordMark (logo + "Clear AI" text) left, EN/AR toggle right
 *   - Headline: IBM Plex Sans, font-weight 400, clamp(40px, 5.6vw, 64px)
 *   - Accent words (#b8551b): "Smarter" and "faster"
 *   - Card: white surface, border #ede4dc, title font-weight 500
 *   - Button: background #231915, font-weight 600
 *   - Redirect hint: IBM Plex Mono, 12px, color #a3958c
 *
 * All strings from i18n — no hardcoded labels.
 */

import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { useT, getLocale, setLocale, type Locale, type TKey } from '@/lib/i18n';
import { ensureInitialized, getActiveAccount, signIn } from '@/lib/auth';

// ---------------------------------------------------------------------------
// Logo — exact SVG from prototype source
// ---------------------------------------------------------------------------

function Logo({ size = 24 }: { size?: number }) {
  const w = size;
  const h = size * (63 / 60);
  return (
    <svg width={w} height={h} viewBox="0 0 60 63" fill="none" aria-hidden xmlns="http://www.w3.org/2000/svg">
      <rect width="60" height="11.55" rx="2.8" fill="#15110D" />
      <circle cx="12" cy="5.775" r="2.2" fill="#15110D" fillOpacity="0.25" />
      <circle cx="26" cy="5.775" r="2.2" fill="#15110D" fillOpacity="0.25" />
      <circle cx="40" cy="5.775" r="2.2" fill="#15110D" fillOpacity="0.25" />
      <circle cx="52" cy="5.775" r="2.2" fill="#15110D" fillOpacity="0.25" />

      <rect x="12.75" y="17.15" width="47.25" height="11.55" rx="2.8" fill="#15110D" fillOpacity="0.7" />
      <circle cx="25" cy="22.925" r="2.2" fill="#15110D" fillOpacity="0.2" />
      <circle cx="38" cy="22.925" r="2.2" fill="#15110D" fillOpacity="0.2" />
      <circle cx="51" cy="22.925" r="2.2" fill="#15110D" fillOpacity="0.2" />

      <rect x="28.5" y="34.3" width="31.5" height="11.55" rx="2.8" fill="#594028" fillOpacity="0.4" />
      <circle cx="38" cy="40.075" r="2.2" fill="#594028" fillOpacity="0.35" />
      <circle cx="50" cy="40.075" r="2.2" fill="#594028" fillOpacity="0.35" />

      <rect x="44.25" y="51.45" width="15.75" height="11.55" rx="2.8" fill="#b8551b" />
      <circle cx="52.125" cy="57.225" r="2.6" fill="white" fillOpacity="0.9" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// WordMark — logo + "Clear AI" text (font-weight 700, Plus Jakarta Sans)
// ---------------------------------------------------------------------------

function WordMark({ size = 26 }: { size?: number }) {
  const t = useT();
  return (
    <a
      href="/"
      className="inline-flex items-center no-underline outline-none focus-visible:ring-2 focus-visible:ring-[#b8551b] rounded"
      style={{ gap: 10 }}
    >
      <Logo size={size} />
      <span style={{
        fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
        fontWeight: 700,
        fontSize: size * 0.78,
        letterSpacing: '-0.01em',
        color: '#231915',
      }}>
        {t('brand' as TKey)}
      </span>
    </a>
  );
}

// ---------------------------------------------------------------------------
// EN / AR language toggle
// ---------------------------------------------------------------------------

function LangToggle() {
  const current = getLocale();

  function langBtn(active: boolean) {
    return {
      background: 'none',
      border: 'none',
      padding: '2px 4px',
      cursor: 'pointer',
      fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
      fontSize: 13,
      fontWeight: 600 as const,
      color: active ? '#231915' : '#a3958c',
      transition: 'color 120ms',
    };
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: "'IBM Plex Sans', system-ui, sans-serif", fontSize: 13, fontWeight: 600 }}>
      <button type="button" onClick={() => setLocale('en' as Locale)} style={langBtn(current === 'en')}>EN</button>
      <span style={{ color: '#d9cdc2' }}>/</span>
      <button type="button" onClick={() => setLocale('ar' as Locale)} style={langBtn(current === 'ar')}>AR</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Microsoft 4-square logo
// ---------------------------------------------------------------------------

function MicrosoftLogo() {
  return (
    <svg viewBox="0 0 22 22" width="20" height="20" aria-hidden style={{ flexShrink: 0 }}>
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="12" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="12" width="9" height="9" fill="#00a4ef" />
      <rect x="12" y="12" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Hero headline — accent words in #b8551b (c-primary)
// ---------------------------------------------------------------------------

function HeroHeadline() {
  const t = useT();
  const line1 = t('login_hero_1' as TKey);
  const line2 = t('login_hero_2' as TKey);
  const acc1  = t('login_hero_accent_1' as TKey);
  const acc2  = t('login_hero_accent_2' as TKey);

  function highlight(text: string, accent: string) {
    const parts = text.split(accent);
    if (parts.length < 2) return <>{text}</>;
    return (
      <>
        {parts[0]}
        <span style={{ color: '#b8551b' }}>{accent}</span>
        {parts.slice(1).join(accent)}
      </>
    );
  }

  return (
    <h1 style={{
      fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
      fontSize: 'clamp(40px, 5.6vw, 64px)',
      fontWeight: 400,
      lineHeight: 1.12,
      letterSpacing: '-0.025em',
      color: '#231915',
      margin: 0,
      maxWidth: 1040,
      textAlign: 'center',
    }}>
      <span style={{ display: 'block' }}>{highlight(line1, acc1)}</span>
      <span style={{ display: 'block' }}>{highlight(line2, acc2)}</span>
    </h1>
  );
}

// ---------------------------------------------------------------------------
// LoginPage
// ---------------------------------------------------------------------------

export default function LoginPage() {
  const t = useT();
  const [signingIn, setSigningIn] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);

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
      .catch(() => { if (!alive) return; setAuthChecked(true); });
    return () => { alive = false; };
  }, []);

  async function handleSignIn() {
    if (signingIn) return;
    setSigningIn(true);
    const safetyReset = window.setTimeout(() => setSigningIn(false), 8000);
    try {
      await signIn();
    } catch {
      window.clearTimeout(safetyReset);
      setSigningIn(false);
    }
  }

  if (!authChecked) {
    return (
      <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fbf9f6' }}>
        <span className="w-5 h-5 rounded-full border-2 border-[#ede4dc] border-t-[#b8551b] animate-spin" />
      </div>
    );
  }

  return (
    <div style={{
      minHeight: '100dvh',
      background: '#fbf9f6',
      color: '#231915',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Warm dot grid — rgba(184,85,27,0.16) dots, 22px grid, masked to center */}
      <div style={{
        position: 'absolute',
        inset: 0,
        opacity: 0.5,
        pointerEvents: 'none',
        backgroundImage: 'radial-gradient(circle, rgba(184,85,27,0.16) 1px, transparent 1px)',
        backgroundSize: '22px 22px',
        maskImage: 'radial-gradient(ellipse at center, black 0%, transparent 75%)',
        WebkitMaskImage: 'radial-gradient(ellipse at center, black 0%, transparent 75%)',
      }} />

      {/* Blob 1 — orange, top-left */}
      <div style={{
        position: 'absolute',
        width: 640, height: 640, borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(184,85,27,0.14) 0%, transparent 65%)',
        left: '10%', top: '-10%',
        pointerEvents: 'none',
      }} />

      {/* Blob 2 — green, bottom-right */}
      <div style={{
        position: 'absolute',
        width: 520, height: 520, borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(63,107,70,0.08) 0%, transparent 70%)',
        right: '8%', bottom: '5%',
        pointerEvents: 'none',
      }} />

      {/* Content above blobs */}
      <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', flex: 1 }}>

        {/* Top bar */}
        <header style={{
          padding: '28px 40px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <WordMark size={26} />
          <LangToggle />
        </header>

        {/* Main content */}
        <main style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '20px 24px 80px',
          textAlign: 'center',
        }}>
          <HeroHeadline />

          <p style={{
            fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
            fontSize: 22,
            fontWeight: 400,
            lineHeight: 1.5,
            color: '#7a6d65',
            margin: '28px auto 0',
            maxWidth: 760,
          }}>
            {t('login_hero_sub' as TKey)}
          </p>

          {/* Sign-in card */}
          <div style={{
            marginTop: 56,
            width: 'min(440px, 100%)',
            background: '#ffffff',
            border: '1px solid #ede4dc',
            borderRadius: 20,
            padding: '36px 36px 32px',
            boxShadow: '0 12px 40px rgba(35,25,21,0.06)',
            textAlign: 'center',
          }}>
            <h2 style={{
              fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
              fontSize: 20,
              fontWeight: 500,
              letterSpacing: '-0.01em',
              margin: '0 0 24px',
              color: '#231915',
            }}>
              {t('login_title' as TKey)}
            </h2>

            <button
              type="button"
              onClick={() => { void handleSignIn(); }}
              disabled={signingIn}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 12,
                width: '100%',
                padding: '16px 20px',
                background: '#231915',
                color: '#fff',
                border: 'none',
                borderRadius: 14,
                fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
                fontSize: 15,
                fontWeight: 600,
                cursor: signingIn ? 'wait' : 'pointer',
                transition: 'filter 120ms ease',
                opacity: signingIn ? 0.65 : 1,
              }}
              onMouseEnter={(e) => { if (!signingIn) (e.currentTarget as HTMLButtonElement).style.filter = 'brightness(1.12)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.filter = 'none'; }}
            >
              {signingIn ? (
                <>
                  <span className="w-4 h-4 rounded-full border-2 border-white/25 border-t-white animate-spin flex-shrink-0" aria-hidden />
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
            <div style={{
              marginTop: 18,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
              fontSize: 12,
              color: '#a3958c',
            }}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="4" y="11" width="16" height="10" rx="2" />
                <path d="M8 11V7a4 4 0 0 1 8 0v4" />
              </svg>
              {t('login_redirect_hint' as TKey)}
            </div>
          </div>
        </main>

        {/* Footer */}
        <footer style={{
          padding: '20px 40px 32px',
          textAlign: 'center',
          fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
          fontSize: 12,
          color: '#a3958c',
        }}>
          {t('login_footer' as TKey)}
        </footer>
      </div>
    </div>
  );
}
