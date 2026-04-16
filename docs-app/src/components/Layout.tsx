import { useEffect, useState } from 'react';
import { NavLink, Link, useLocation } from 'react-router-dom';

// ── Types ────────────────────────────────────────────────
interface SideSection {
  href: string;
  label: string;
}
interface SidePage {
  num: string;
  label: string;
  to: string;
  sections?: SideSection[];
}

const PAGES: SidePage[] = [
  {
    num: '01', label: 'Product Definition', to: '/',
    sections: [
      { href: '#problem',       label: 'Problem' },
      { href: '#solution',      label: 'Solution Overview' },
      { href: '#target-market', label: 'Target Customer' },
      { href: '#features',      label: 'Features by Mode' },
      { href: '#metrics',       label: 'Metrics by Mode' },
      { href: '#roadmap',       label: 'Roadmap' },
      { href: '#clear-openq',   label: 'Open Questions' },
    ],
  },
  { num: '02', label: 'Current Naqel Process',  to: '/process',
    sections: [
      { href: '#big-picture', label: 'Process Overview' },
      { href: '#hvlv',        label: 'HV / LV Split' },
      { href: '#intake',      label: 'Data Intake' },
      { href: '#hscode',      label: 'HS Code Resolution' },
      { href: '#zatca',       label: 'ZATCA XML' },
    ],
  },
  { num: '03', label: 'Technical Architecture', to: '/architecture',
    sections: [
      { href: '#v1-panel',       label: 'V1 Architecture' },
      { href: '#algo-rationale', label: 'A — Resolution Algorithm' },
      { href: '#deploy-rationale', label: 'B — V1 Deployment' },
    ],
  },
  { num: '04', label: 'Reference Material', to: '/reference',
    sections: [
      { href: '#hs-anatomy',       label: 'HS Code Anatomy' },
      { href: '#authorities',      label: 'Authorities' },
      { href: '#hs-interpretation',label: 'GRI Rules' },
      { href: '#rules',            label: 'Rules & Sources' },
    ],
  },
];

const NAV_LINKS = [
  { to: '/',             label: 'Business' },
  { to: '/process',      label: 'Process' },
  { to: '/architecture', label: 'Architecture' },
  { to: '/reference',    label: 'Reference' },
];

// ── ScrollProgress ───────────────────────────────────────
function ScrollProgress() {
  const [pct, setPct] = useState(0);
  useEffect(() => {
    const handler = () => {
      const h = document.documentElement;
      setPct((h.scrollTop / (h.scrollHeight - h.clientHeight)) * 100);
    };
    document.addEventListener('scroll', handler);
    return () => document.removeEventListener('scroll', handler);
  }, []);
  return (
    <div
      className="fixed top-0 left-0 h-[2px] z-[1000] transition-[width_.1s_linear]"
      style={{
        width: `${pct}%`,
        background: 'linear-gradient(90deg, #1e3a5f, #0E1729)',
        boxShadow: '0 0 8px rgba(14,23,41,.25)',
      }}
    />
  );
}

// ── Sidebar nav content ───────────────────────────────────
function SidebarNav({ onClose }: { onClose?: () => void }) {
  const { pathname } = useLocation();

  return (
    <div className="p-6 pt-8">
      {/* Brand */}
      <div className="flex items-center gap-2 mb-1">
        <div
          className="w-[34px] h-[34px] rounded-[9px] grid place-items-center text-white font-serif font-black text-[1.05rem] shrink-0 shadow-md"
          style={{ background: 'linear-gradient(135deg, #1e3a5f, #0E1729)' }}
        >
          C
        </div>
        <span className="font-serif font-black text-[1.55rem] tracking-[-0.015em] text-text leading-none">
          Clear<em className="not-italic text-accent">AI</em>
        </span>
      </div>
      <div className="font-mono text-[.68rem] text-muted tracking-[.18em] uppercase mb-7 pl-[calc(34px+0.5rem)]">
        Project wiki
      </div>

      {/* Nav */}
      <nav className="flex flex-col gap-1">
        {PAGES.map((page) => {
          const isActive = page.to === '/' ? pathname === '/' : pathname.startsWith(page.to);
          return (
            <div key={page.to}>
              <NavLink
                to={page.to}
                end={page.to === '/'}
                onClick={onClose}
                className={[
                  'flex items-center gap-[.6rem] px-3 py-[.55rem] rounded-md font-sans text-[.85rem] font-semibold no-underline transition-colors duration-150',
                  isActive
                    ? 'bg-accent text-white'
                    : 'text-text hover:bg-[rgba(14,23,41,.05)]',
                ].join(' ')}
              >
                <span className={['font-mono text-[.62rem]', isActive ? 'opacity-80' : 'opacity-50'].join(' ')}>
                  {page.num}
                </span>
                <span>{page.label}</span>
              </NavLink>

              {isActive && page.sections && (
                <div className="flex flex-col gap-px mt-[2px] ml-6 mb-2">
                  {page.sections.map((s) => (
                    <a
                      key={s.href}
                      href={s.href}
                      onClick={onClose}
                      className="block px-3 py-[.42rem] rounded font-sans text-[.78rem] text-muted no-underline border-l-2 border-transparent hover:text-text hover:bg-[rgba(14,23,41,.04)] transition-all duration-150"
                    >
                      {s.label}
                    </a>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <div className="h-px bg-border mt-6 mb-4" />
      <p className="font-mono text-[.6rem] text-dim tracking-[.1em] uppercase">Working draft</p>
    </div>
  );
}

// ── Sidebar (desktop only) ────────────────────────────────
function Sidebar() {
  return (
    <aside
      className="hidden lg:block fixed top-0 left-0 bottom-0 w-[280px] overflow-y-auto z-50"
      style={{ background: '#eef1f7', borderRight: '1px solid #d8dce8' }}
    >
      <SidebarNav />
    </aside>
  );
}

// ── Mobile drawer ─────────────────────────────────────────
function MobileDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Lock body scroll when open
  useEffect(() => {
    if (open) document.body.style.overflow = 'hidden';
    else document.body.style.overflow = '';
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  return (
    <>
      {/* Backdrop */}
      <div
        className={[
          'lg:hidden fixed inset-0 z-[60] bg-black/40 backdrop-blur-sm transition-opacity duration-300',
          open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none',
        ].join(' ')}
        onClick={onClose}
      />
      {/* Drawer panel */}
      <div
        className={[
          'lg:hidden fixed top-0 left-0 bottom-0 w-[280px] overflow-y-auto z-[70] transition-transform duration-300 ease-in-out',
          open ? 'translate-x-0' : '-translate-x-full',
        ].join(' ')}
        style={{ background: '#eef1f7', borderRight: '1px solid #d8dce8' }}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 w-8 h-8 grid place-items-center rounded-full hover:bg-[rgba(14,23,41,.08)] transition-colors"
          aria-label="Close menu"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M1 1l12 12M13 1L1 13" stroke="#546178" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </button>
        <SidebarNav onClose={onClose} />
      </div>
    </>
  );
}

// ── Topbar ───────────────────────────────────────────────
function Topbar({
  chapter,
  title,
  onMenuOpen,
}: {
  chapter: string;
  title: string;
  onMenuOpen: () => void;
}) {
  return (
    <div
      className="sticky top-0 z-40 flex items-center justify-between px-4 md:px-8 lg:px-12 py-3 border-b border-border"
      style={{ background: 'rgba(248,249,252,.92)', backdropFilter: 'blur(14px)' }}
    >
      <div className="flex items-center gap-3">
        {/* Hamburger — mobile only */}
        <button
          onClick={onMenuOpen}
          className="lg:hidden w-8 h-8 grid place-items-center rounded-md hover:bg-[rgba(14,23,41,.06)] transition-colors shrink-0"
          aria-label="Open menu"
        >
          <svg width="18" height="14" viewBox="0 0 18 14" fill="none">
            <path d="M0 1h18M0 7h18M0 13h18" stroke="#1e3a5f" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </button>

        <Link
          to="/"
          className="flex items-center gap-2 font-serif font-black text-[1rem] text-text no-underline tracking-[-0.01em]"
        >
          <span
            className="w-[22px] h-[22px] rounded-[6px] grid place-items-center text-white text-[.72rem] font-black"
            style={{ background: 'linear-gradient(135deg, #1e3a5f, #0E1729)' }}
          >
            C
          </span>
          Clear<em className="not-italic text-accent">AI</em>
        </Link>

        <span className="text-dim hidden sm:inline">/</span>
        <span className="font-mono text-[.65rem] text-muted tracking-[.06em] hidden sm:inline truncate max-w-[240px]">
          {chapter} · <span className="text-accent font-semibold">{title}</span>
        </span>
      </div>

      {/* Desktop nav */}
      <nav className="hidden md:flex gap-5">
        {NAV_LINKS.map((l) => (
          <NavLink
            key={l.to}
            to={l.to}
            end={l.to === '/'}
            className={({ isActive }) =>
              [
                'font-mono text-[.66rem] tracking-[.1em] uppercase no-underline transition-colors duration-150',
                isActive ? 'text-accent' : 'text-muted hover:text-accent',
              ].join(' ')
            }
          >
            {l.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

// ── Footer ───────────────────────────────────────────────
function Footer() {
  return (
    <footer className="flex items-center justify-between flex-wrap gap-4 px-4 sm:px-8 lg:px-12 py-8 border-t border-border font-mono text-[.62rem] text-muted">
      <div>
        <strong className="font-serif text-[.95rem] text-text font-black">
          Clear<em className="not-italic text-accent">AI</em>
        </strong>
        <span className="mx-2 text-dim">·</span>
        Project wiki
        <span className="mx-2 text-dim">·</span>
        <span className="text-accent">Working draft</span>
      </div>
      <div className="flex gap-6">
        {NAV_LINKS.map((l) => (
          <NavLink
            key={l.to}
            to={l.to}
            end={l.to === '/'}
            className="text-muted no-underline hover:text-accent transition-colors"
          >
            {l.label}
          </NavLink>
        ))}
      </div>
    </footer>
  );
}

// ── PageHero ─────────────────────────────────────────────
export function PageHero({
  kicker,
  title,
  lede,
}: {
  kicker: string;
  title: React.ReactNode;
  lede: string;
}) {
  return (
    <section
      className="relative overflow-hidden border-b border-border px-4 sm:px-8 lg:px-12 pt-10 sm:pt-16 pb-10"
      style={{ background: 'linear-gradient(180deg, #f8f9fc 0%, #eef1f7 100%)' }}
    >
      <div
        className="absolute inset-0 opacity-20 pointer-events-none"
        style={{
          backgroundImage: 'linear-gradient(#d8dce8 1px, transparent 1px), linear-gradient(90deg, #d8dce8 1px, transparent 1px)',
          backgroundSize: '48px 48px',
          maskImage: 'radial-gradient(ellipse 60% 80% at 80% 20%, black 10%, transparent 70%)',
        }}
      />
      <div className="relative max-w-[1160px] mx-auto">
        <div className="flex items-center gap-3 font-mono text-[.72rem] sm:text-[.78rem] text-accent tracking-[.18em] uppercase mb-4">
          <span className="inline-block w-7 h-px bg-accent" />
          {kicker}
        </div>
        <h1
          className="font-sans font-bold tracking-[-0.02em] max-w-[820px] mb-4"
          style={{ fontSize: 'clamp(1.8rem, 4vw, 3.6rem)', lineHeight: 1.1 }}
        >
          {title}
        </h1>
        <p className="text-muted max-w-[680px] leading-[1.75] text-[.95rem] sm:text-[1.02rem]">{lede}</p>
      </div>
    </section>
  );
}

// ── Layout (root shell) ───────────────────────────────────
export default function Layout({
  children,
  chapter,
  pageTitle,
}: {
  children: React.ReactNode;
  chapter: string;
  pageTitle: string;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="flex min-h-screen">
      <ScrollProgress />

      {/* Desktop sidebar */}
      <Sidebar />

      {/* Mobile drawer */}
      <MobileDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />

      {/* Main content — offset by sidebar on desktop */}
      <main className="flex-1 lg:ml-[280px] min-w-0">
        <Topbar
          chapter={chapter}
          title={pageTitle}
          onMenuOpen={() => setDrawerOpen(true)}
        />
        <div>{children}</div>
        <Footer />
      </main>
    </div>
  );
}
