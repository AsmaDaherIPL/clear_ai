/**
 * i18n.ts — ClearAI v2 internationalisation module
 *
 * DESIGN DECISIONS:
 *   - `locales` table is the single source of truth for locale code, text
 *     direction, and display label. Add new locales here only.
 *   - `useT()` is the React hook: call inside any React component to get a
 *     translation function bound to the current locale.
 *   - `t()` is the non-hook variant for use outside React (e.g. Astro files).
 *   - `setLocale()` writes the cookie AND hot-flips html[lang/dir] without a
 *     page reload, so all React islands re-render in lock-step.
 *   - `useSyncExternalStore` is used instead of useState/useEffect so every
 *     subscribed island re-renders atomically when setLocale fires — no
 *     intermediate state where one island has flipped and another hasn't.
 *   - The cookie name matches the server-side cookie read in Layout.astro,
 *     so the locale persists across hard reloads without a round-trip.
 */

import { useSyncExternalStore } from 'react';
import en from '../locales/en.json';
import ar from '../locales/ar.json';

export const locales = {
  en: { code: 'en', dir: 'ltr', label: 'English' },
  ar: { code: 'ar', dir: 'rtl', label: 'العربية' },
} as const;

export type Locale = keyof typeof locales;
export type Dict = typeof en;
export type TKey = keyof Dict;

const dicts: Record<Locale, Dict> = { en, ar };
const COOKIE = 'lang';
const FALLBACK: Locale = 'en';

function readCookie(): Locale | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(/(?:^|; )lang=(en|ar)/);
  return m ? (m[1] as Locale) : null;
}

function writeCookie(l: Locale) {
  if (typeof document === 'undefined') return;
  const oneYear = 60 * 60 * 24 * 365;
  document.cookie = `${COOKIE}=${l}; path=/; max-age=${oneYear}; samesite=lax`;
}

let current: Locale = readCookie() ?? FALLBACK;
const listeners = new Set<() => void>();

export function getLocale(): Locale { return current; }
export function getDir(locale: Locale = current) { return locales[locale].dir; }

export function setLocale(next: Locale) {
  if (next === current) return;
  current = next;
  writeCookie(next);
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('lang', next);
    document.documentElement.setAttribute('dir', locales[next].dir);
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** React hook — returns a `t(key)` function bound to the live locale. */
export function useT(): (k: TKey) => string {
  const locale = useSyncExternalStore(subscribe, getLocale, getLocale);
  return (k) => (dicts[locale][k] as string | undefined) ?? (dicts[FALLBACK][k] as string | undefined) ?? String(k);
}

/** Non-hook variant for use outside React components (Astro files, utilities). */
export function t(k: TKey): string {
  return (dicts[current][k] as string | undefined) ?? (dicts[FALLBACK][k] as string | undefined) ?? String(k);
}
