/**
 * AppShell — sidebar shell matching the prototype design exactly.
 *
 * Prototype spec (extracted from ClearAI Prototype _standalone_.html):
 *   - Width: 248px open, 72px collapsed
 *   - Background: #ffffff, border-right: 1px solid #ede4dc
 *   - Header: WordMark left + dock_to_right icon button right (no bottom border)
 *   - Nav: 3 items — Classify (auto_awesome), Bulk upload (upload_file), History (history)
 *     Review queue is NOT in prototype sidebar — omitted
 *   - Active: bg #fff1e5, color #7a3000, font-weight 600
 *   - Inactive: color #7a6d65, font-weight 500, hover bg #f6f2ed
 *   - Footer: avatar img + name + workspace + logout icon button
 *   - Icons: Material Symbols Outlined variable font
 *   - Collapse: stores in localStorage
 *
 * The main content area uses margin-inline-start (logical property) so
 * RTL mirrors automatically.
 */

import { useState, useEffect, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useT, type TKey } from '@/lib/i18n';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip';
import { ensureInitialized, getActiveAccount, signOut } from '@/lib/auth';

// ---------------------------------------------------------------------------
// Page id type — Review queue handled outside sidebar per prototype
// ---------------------------------------------------------------------------

export type PageId = 'classify' | 'bulk' | 'history' | 'review';

// ---------------------------------------------------------------------------
// Material Symbol icon helper — matches prototype Icon component exactly
// ---------------------------------------------------------------------------

function Icon({
  name,
  size = 20,
  fill = 0,
  weight = 400,
}: {
  name: string;
  size?: number;
  fill?: number;
  weight?: number;
}) {
  return (
    <span
      className="material-symbols-outlined"
      style={{
        fontSize: size,
        fontVariationSettings: `'FILL' ${fill}, 'wght' ${weight}, 'GRAD' 0, 'opsz' ${size}`,
        lineHeight: 1,
        flexShrink: 0,
      }}
      aria-hidden="true"
    >
      {name}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Logo — exact prototype SVG
// ---------------------------------------------------------------------------

function Logo({ size = 22 }: { size?: number }) {
  const h = size * (63 / 60);
  return (
    <svg width={size} height={h} viewBox="0 0 60 63" fill="none" aria-hidden xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
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
// WordMark — logo + "Clear AI" label
// ---------------------------------------------------------------------------

function WordMark({ size = 22 }: { size?: number }) {
  const t = useT();
  return (
    <a
      href="/"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        textDecoration: 'none',
        outline: 'none',
      }}
    >
      <Logo size={size} />
      <span
        className="sidebar-wordmark"
        style={{
          fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
          fontWeight: 700,
          fontSize: size * 0.78,
          letterSpacing: '-0.01em',
          color: '#231915',
          whiteSpace: 'nowrap',
        }}
      >
        {t('brand' as TKey)}
      </span>
    </a>
  );
}

// ---------------------------------------------------------------------------
// Nav items — 3 items matching prototype (no review queue)
// ---------------------------------------------------------------------------

type NavId = 'classify' | 'bulk' | 'history';

interface NavItem {
  id: NavId;
  icon: string;
  labelKey: TKey;
  href: string;
  /** Extra page ids that should light up this nav item */
  aliases?: PageId[];
}

const NAV_ITEMS: NavItem[] = [
  { id: 'classify', icon: 'auto_awesome',  labelKey: 'nav_classify' as TKey, href: '/',       aliases: ['review'] },
  { id: 'bulk',     icon: 'upload_file',   labelKey: 'nav_bulk'     as TKey, href: '/?mode=batch' },
  { id: 'history',  icon: 'history',       labelKey: 'nav_history'  as TKey, href: '/history' },
];

function isNavActive(item: NavItem, activePageId: PageId): boolean {
  if (item.id === activePageId) return true;
  return item.aliases?.includes(activePageId) ?? false;
}

// ---------------------------------------------------------------------------
// Single nav row
// ---------------------------------------------------------------------------

function NavRow({
  item,
  isActive,
  collapsed,
}: {
  item: NavItem;
  isActive: boolean;
  collapsed: boolean;
}) {
  const t = useT();
  const label = t(item.labelKey);

  const btn = (
    <a
      href={item.href}
      aria-current={isActive ? 'page' : undefined}
      style={{
        appearance: 'none' as const,
        background: isActive ? '#fff1e5' : 'transparent',
        color: isActive ? '#7a3000' : '#7a6d65',
        border: 0,
        padding: collapsed ? '12px 0' : '11px 14px',
        borderRadius: 10,
        display: 'flex',
        alignItems: 'center',
        justifyContent: collapsed ? 'center' : 'flex-start',
        gap: 12,
        fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
        fontSize: 14,
        fontWeight: isActive ? 600 : 500,
        textDecoration: 'none',
        cursor: 'pointer',
        width: '100%',
        transition: 'background 140ms ease, color 140ms ease',
        outline: 'none',
        boxSizing: 'border-box' as const,
      }}
      onMouseEnter={(e) => {
        if (!isActive) (e.currentTarget as HTMLAnchorElement).style.background = '#f6f2ed';
      }}
      onMouseLeave={(e) => {
        if (!isActive) (e.currentTarget as HTMLAnchorElement).style.background = 'transparent';
      }}
    >
      <Icon name={item.icon} size={20} fill={isActive ? 1 : 0} weight={isActive ? 500 : 400} />
      {!collapsed && <span className="sidebar-label">{label}</span>}
    </a>
  );

  if (!collapsed) return btn;

  return (
    <Tooltip delayDuration={100}>
      <TooltipTrigger asChild>{btn}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={10}>{label}</TooltipContent>
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

  const W = collapsed ? 72 : 248;

  return (
    <TooltipProvider>
      {/* ----------------------------------------------------------------
          Sidebar
      ---------------------------------------------------------------- */}
      <aside
        aria-label={t('nav_menu' as TKey)}
        style={{
          width: W,
          position: 'fixed',
          inset: '0 auto 0 0',
          background: '#ffffff',
          borderRight: '1px solid #ede4dc',
          display: 'flex',
          flexDirection: 'column',
          zIndex: 50,
          transition: 'width 200ms cubic-bezier(0.2, 0.8, 0.2, 1)',
          overflow: 'hidden',
        }}
      >
        {/* Header: wordmark + collapse toggle */}
        <div style={{
          padding: collapsed ? '18px 0' : '18px 18px 14px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: collapsed ? 'center' : 'space-between',
          gap: 8,
          flexShrink: 0,
        }}>
          {!collapsed && <WordMark size={22} />}
          <Tooltip delayDuration={100}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={toggle}
                aria-label={collapsed ? t('nav_expand' as TKey) : t('nav_collapse' as TKey)}
                style={{
                  background: 'transparent',
                  border: 0,
                  padding: 8,
                  borderRadius: 8,
                  cursor: 'pointer',
                  color: '#7a6d65',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transition: 'background 120ms ease, color 120ms ease',
                  flexShrink: 0,
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = '#f6f2ed';
                  (e.currentTarget as HTMLButtonElement).style.color = '#231915';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
                  (e.currentTarget as HTMLButtonElement).style.color = '#7a6d65';
                }}
              >
                <Icon name="dock_to_right" size={20} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={10}>
              {collapsed ? t('nav_expand' as TKey) : t('nav_collapse' as TKey)}
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Nav items */}
        <nav style={{
          padding: collapsed ? '8px 8px' : '8px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          flexShrink: 0,
        }}>
          {NAV_ITEMS.map((item) => (
            <NavRow
              key={item.id}
              item={item}
              isActive={isNavActive(item, activePageId)}
              collapsed={collapsed}
            />
          ))}
        </nav>

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* Footer: user profile */}
        {authReady && (
          <div style={{
            padding: collapsed ? '12px 8px' : '12px 14px',
            borderTop: '1px solid #ede4dc',
            flexShrink: 0,
          }}>
            {collapsed ? (
              /* Collapsed: just avatar */
              <Tooltip delayDuration={100}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => { void signOut(); }}
                    title={accountName ?? ''}
                    style={{
                      width: '100%',
                      background: 'transparent',
                      border: 0,
                      padding: 4,
                      borderRadius: 10,
                      cursor: 'pointer',
                      display: 'flex',
                      justifyContent: 'center',
                    }}
                  >
                    <UserAvatar name={accountName} size={36} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={10}>
                  {accountName} — {t('signout' as TKey)}
                </TooltipContent>
              </Tooltip>
            ) : (
              /* Expanded: avatar + name + workspace + logout icon */
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <UserAvatar name={accountName} size={36} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: '#231915',
                    fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}>
                    {accountName ?? '—'}
                  </div>
                  <div style={{
                    fontSize: 11,
                    color: '#7a6d65',
                    fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}>
                    ClearAI
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => { void signOut(); }}
                  title={t('nav_signout_title' as TKey)}
                  style={{
                    background: 'transparent',
                    border: 0,
                    padding: 6,
                    color: '#7a6d65',
                    cursor: 'pointer',
                    borderRadius: 8,
                    display: 'inline-flex',
                    alignItems: 'center',
                    transition: 'color 120ms, background 120ms',
                    flexShrink: 0,
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.color = '#231915';
                    (e.currentTarget as HTMLButtonElement).style.background = '#f6f2ed';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.color = '#7a6d65';
                    (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
                  }}
                >
                  <Icon name="logout" size={18} />
                </button>
              </div>
            )}
          </div>
        )}
      </aside>

      {/* ----------------------------------------------------------------
          Main content — shifts right to clear the sidebar
      ---------------------------------------------------------------- */}
      <div
        style={{
          marginInlineStart: W,
          transition: 'margin-inline-start 200ms cubic-bezier(0.2, 0.8, 0.2, 1)',
          minHeight: '100dvh',
        }}
      >
        {children}
      </div>
    </TooltipProvider>
  );
}

// ---------------------------------------------------------------------------
// UserAvatar — initials fallback (no photo available from MSAL accounts)
// ---------------------------------------------------------------------------

function UserAvatar({ name, size = 36 }: { name: string | null; size?: number }) {
  const initials = name
    ? name.split(' ').map((p) => p.charAt(0).toUpperCase()).slice(0, 2).join('')
    : '?';

  return (
    <div
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: '#fff1e5',
        color: '#7a3000',
        fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
        fontSize: size * 0.36,
        fontWeight: 600,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        letterSpacing: '0.02em',
      }}
    >
      {initials}
    </div>
  );
}
