/**
 * AppShell — persistent sidebar + page content slot.
 *
 * Architecture decisions:
 * - Sidebar state (open/collapsed) lives in localStorage under
 *   "sidebar_collapsed" so it persists across page loads without a
 *   server round-trip. Default is open.
 * - The sidebar is position:fixed on the inline-start edge. The main
 *   content area uses margin-inline-start (logical property) so the
 *   layout mirrors correctly in RTL.
 * - CSS transitions (.app-sidebar, .app-main, .sidebar-label, etc.) are
 *   defined in global.css — no inline transition styles here.
 * - Nav items are identified by a string id. The icon map lives here so
 *   SVG nodes don't have to cross the Astro/React serialisation boundary.
 * - Tooltip wraps each nav icon when collapsed so keyboard/screen-reader
 *   users always see the label.
 */

import { useState, useEffect, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useT, type TKey } from '@/lib/i18n';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from '@/components/ui/tooltip';
import LanguageToggle from './LanguageToggle';
import { ensureInitialized, getActiveAccount, signOut } from '@/lib/auth';

// ---------------------------------------------------------------------------
// Page id type
// ---------------------------------------------------------------------------

export type PageId = 'classify' | 'bulk' | 'history' | 'review';

// ---------------------------------------------------------------------------
// Nav icon registry — all 20×20, strokeWidth 1.75
// ---------------------------------------------------------------------------

const NAV_ICONS: Record<PageId, ReactNode> = {
  classify: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5" aria-hidden>
      <path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18" />
    </svg>
  ),
  bulk: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5" aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="12" y1="18" x2="12" y2="12" />
      <line x1="9" y1="15" x2="15" y2="15" />
    </svg>
  ),
  history: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5" aria-hidden>
      <path d="M3 3v5h5" />
      <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
      <polyline points="12 7 12 12 15 15" />
    </svg>
  ),
  review: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5" aria-hidden>
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  ),
};

const NAV_LABEL_KEYS: Record<PageId, TKey> = {
  classify: 'nav_classify' as TKey,
  bulk:     'nav_bulk'     as TKey,
  history:  'nav_history'  as TKey,
  review:   'nav_review'   as TKey,
};

const NAV_HREFS: Record<PageId, string> = {
  classify: '/',
  bulk:     '/?mode=batch',
  history:  '/history',
  review:   '/review',
};

const NAV_ORDER: PageId[] = ['classify', 'bulk', 'history', 'review'];

// ---------------------------------------------------------------------------
// Brand logo mark — exact SVG from prototype source
// ---------------------------------------------------------------------------

function LogoMark({ size = 22 }: { size?: number; className?: string }) {
  const w = size;
  const h = size * (63 / 60);
  return (
    <svg width={w} height={h} viewBox="0 0 60 63" fill="none" aria-hidden xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
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
// Collapse toggle chevron
// ---------------------------------------------------------------------------

function CollapseChevron() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-4 h-4 sidebar-toggle-icon"
      aria-hidden="true"
    >
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// NavRow
// ---------------------------------------------------------------------------

function NavRow({
  pageId,
  isActive,
  collapsed,
}: {
  pageId: PageId;
  isActive: boolean;
  collapsed: boolean;
}) {
  const t = useT();
  const label = t(NAV_LABEL_KEYS[pageId]);

  const inner = (
    <a
      href={NAV_HREFS[pageId]}
      aria-current={isActive ? 'page' : undefined}
      className={cn(
        'group flex items-center gap-3',
        'px-3 py-2.5 rounded-[10px]',
        'text-[13.5px] font-medium',
        'transition-colors duration-150',
        'outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]',
        isActive
          ? 'bg-[var(--sidebar-nav-active-bg)] text-[var(--sidebar-nav-active-ink)]'
          : 'text-[var(--ink-2)] hover:bg-[var(--sidebar-nav-hover-bg)] hover:text-[var(--ink)]',
      )}
    >
      <span
        className={cn(
          'flex-shrink-0 w-5 h-5 flex items-center justify-center',
          isActive ? 'opacity-100' : 'opacity-55 group-hover:opacity-85',
        )}
      >
        {NAV_ICONS[pageId]}
      </span>
      <span className="sidebar-label">{label}</span>
    </a>
  );

  if (!collapsed) return inner;

  return (
    <Tooltip delayDuration={100}>
      <TooltipTrigger asChild>{inner}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={10}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// AppShell
// ---------------------------------------------------------------------------

interface AppShellProps {
  activePageId: PageId;
  children: ReactNode;
}

const STORAGE_KEY = 'sidebar_collapsed';

export default function AppShell({ activePageId, children }: AppShellProps) {
  const t = useT();

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch { return false; }
  });

  const [accountName, setAccountName] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    let alive = true;
    ensureInitialized()
      .then(() => {
        if (!alive) return;
        setAccountName(getActiveAccount()?.name ?? null);
        setAuthReady(true);
      })
      .catch(() => { if (!alive) return; setAuthReady(true); });
    return () => { alive = false; };
  }, []);

  function toggle() {
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem(STORAGE_KEY, next ? '1' : '0'); } catch { /* noop */ }
      return next;
    });
  }

  return (
    <TooltipProvider>
      {/* Sidebar */}
      <aside
        className={cn(
          'app-sidebar',
          'fixed inset-y-0 start-0 z-30',
          'flex flex-col',
          'bg-[var(--sidebar-bg)] border-e border-[var(--sidebar-border)]',
        )}
        data-collapsed={collapsed ? 'true' : 'false'}
        aria-label={t('nav_menu' as TKey)}
      >
        {/* Brand header row */}
        <div
          className="flex items-center gap-3 px-3 border-b border-[var(--sidebar-border)] flex-shrink-0 overflow-hidden"
          style={{ height: 'var(--topbar-height)' }}
        >
          <a
            href="/"
            className="flex items-center gap-3 min-w-0 text-[var(--ink)] no-underline rounded-md outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            <LogoMark size={22} />
            <span className="sidebar-wordmark text-[14px] tracking-tight" style={{ fontWeight: 700, color: '#231915', letterSpacing: '-0.01em' }}>
              {t('brand' as TKey)}
            </span>
          </a>
        </div>

        {/* Nav links */}
        <nav
          className="flex-1 overflow-y-auto overflow-x-hidden px-2 py-3 flex flex-col gap-0.5"
        >
          {NAV_ORDER.map((id) => (
            <NavRow
              key={id}
              pageId={id}
              isActive={id === activePageId}
              collapsed={collapsed}
            />
          ))}
        </nav>

        {/* Bottom: language toggle + account + collapse button */}
        <div className="flex-shrink-0 px-2 py-3 border-t border-[var(--sidebar-border)] flex flex-col gap-0.5">
          {/* Language toggle */}
          <LanguageToggle
            showLabel={!collapsed}
            className={cn(
              'w-full justify-start! rounded-[10px]! px-3! py-2.5!',
              'border-transparent! bg-transparent!',
              'hover:bg-[var(--sidebar-nav-hover-bg)]! hover:border-transparent!',
              'text-[13.5px]!',
              collapsed && 'justify-center!',
            )}
          />

          {/* Sign out */}
          {authReady && accountName && (
            <Tooltip delayDuration={100}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => { void signOut(); }}
                  className={cn(
                    'flex items-center gap-3 px-3 py-2.5 rounded-[10px] w-full',
                    'text-[13.5px] font-medium text-[var(--ink-2)]',
                    'hover:bg-[var(--sidebar-nav-hover-bg)] hover:text-[var(--ink)]',
                    'transition-colors duration-150 outline-none',
                    'focus-visible:ring-2 focus-visible:ring-[var(--ring)]',
                  )}
                >
                  <span
                    className="flex-shrink-0 w-5 h-5 rounded-full bg-[var(--sidebar-nav-active-bg)] flex items-center justify-center text-[9px] font-bold text-[var(--sidebar-nav-active-ink)] uppercase"
                    aria-hidden
                  >
                    {accountName.charAt(0)}
                  </span>
                  <span className="sidebar-label truncate text-start">
                    {t('signout' as TKey)}
                  </span>
                </button>
              </TooltipTrigger>
              {collapsed && (
                <TooltipContent side="right" sideOffset={10}>
                  {accountName} — {t('signout' as TKey)}
                </TooltipContent>
              )}
            </Tooltip>
          )}

          {/* Collapse / expand toggle */}
          <Tooltip delayDuration={100}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={toggle}
                aria-label={collapsed ? t('nav_expand' as TKey) : t('nav_collapse' as TKey)}
                className={cn(
                  'flex items-center gap-3 px-3 py-2.5 rounded-[10px] w-full',
                  'text-[var(--ink-3)] hover:text-[var(--ink-2)]',
                  'hover:bg-[var(--sidebar-nav-hover-bg)]',
                  'transition-colors duration-150 outline-none',
                  'focus-visible:ring-2 focus-visible:ring-[var(--ring)]',
                )}
              >
                <span className="flex-shrink-0 w-5 h-5 flex items-center justify-center">
                  <CollapseChevron />
                </span>
                <span className="sidebar-label text-[13px]">
                  {t('nav_collapse' as TKey)}
                </span>
              </button>
            </TooltipTrigger>
            {collapsed && (
              <TooltipContent side="right" sideOffset={10}>
                {t('nav_expand' as TKey)}
              </TooltipContent>
            )}
          </Tooltip>
        </div>
      </aside>

      {/* Main content */}
      <div
        className="app-main"
        data-sidebar-collapsed={collapsed ? 'true' : 'false'}
      >
        {children}
      </div>
    </TooltipProvider>
  );
}
