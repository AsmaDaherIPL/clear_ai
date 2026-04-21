import { useEffect, useRef, type ReactNode } from 'react';

// ── Reveal wrapper ───────────────────────────────────────
export function Reveal({
  children,
  delay = 0,
  className = '',
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          el.style.opacity = '1';
          el.style.transform = 'translateY(0)';
          io.unobserve(el);
        }
      },
      { threshold: 0.1 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={className}
      style={{
        opacity: 0,
        transform: 'translateY(16px)',
        transition: `opacity .6s ease ${delay}ms, transform .6s ease ${delay}ms`,
      }}
    >
      {children}
    </div>
  );
}

// ── SectionLabel ─────────────────────────────────────────
export function SectionLabel({ num, children }: { num: string; children: ReactNode }) {
  return (
    <Reveal className="flex items-center gap-3 font-mono text-[.8rem] text-accent tracking-[.08em] uppercase mb-4">
      <span
        className="w-6 h-6 rounded-full grid place-items-center text-[.7rem] font-medium text-white shrink-0"
        style={{ background: 'linear-gradient(135deg, #EA6A1F 0%, #94421C 100%)' }}
      >
        {num}
      </span>
      {children}
    </Reveal>
  );
}

// ── SectionTitle ─────────────────────────────────────────
export function SectionTitle({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <Reveal>
      <h2
        className={`font-sans font-medium tracking-[-0.022em] text-text mb-4 ${className}`}
        style={{ fontSize: 'clamp(1.55rem, 2.6vw, 2.2rem)', lineHeight: 1.15 }}
      >
        {children}
      </h2>
    </Reveal>
  );
}

// ── SectionDesc ──────────────────────────────────────────
export function SectionDesc({ children }: { children: ReactNode }) {
  return (
    <Reveal>
      <p className="text-muted text-[.98rem] leading-[1.8] mb-8 max-w-[680px]">{children}</p>
    </Reveal>
  );
}

// ── Divider ──────────────────────────────────────────────
export function Divider() {
  return (
    <div
      className="h-px mx-20"
      style={{ background: 'linear-gradient(90deg, transparent, #E8E9EA, transparent)' }}
    />
  );
}

// ── Callout ──────────────────────────────────────────────
type CalloutVariant = 'default' | 'warn' | 'info' | 'note' | 'gold' | 'red' | 'blue' | 'green';

const calloutStyles: Record<CalloutVariant, { bg: string; border: string; strongColor: string }> = {
  // ClearAI palette: orange accent + green ok + neutral paper
  default: { bg: '#F5F5F4',           border: '#E8E9EA',                strongColor: '#151516' },
  gold:    { bg: '#FDEFE5',           border: '#FBE3D1',                strongColor: '#94421C' },
  warn:    { bg: '#FDEFE5',           border: '#FBE3D1',                strongColor: '#94421C' },
  red:     { bg: '#FDEFE5',           border: '#FBE3D1',                strongColor: '#94421C' },
  info:    { bg: '#F5F5F4',           border: '#E8E9EA',                strongColor: '#2B2B2D' },
  blue:    { bg: '#F5F5F4',           border: '#E8E9EA',                strongColor: '#2B2B2D' },
  note:    { bg: 'rgba(234,106,31,.06)', border: 'rgba(234,106,31,.20)', strongColor: '#94421C' },
  green:   { bg: '#E6F1EC',           border: 'rgba(46,125,87,.22)',    strongColor: '#2E7D57' },
};

export function Callout({
  variant = 'default',
  icon,
  children,
  className = '',
}: {
  variant?: CalloutVariant;
  icon?: string;
  children: ReactNode;
  className?: string;
}) {
  const s = calloutStyles[variant];
  return (
    <div
      className={`flex gap-4 items-start rounded-xl px-6 py-5 text-[.92rem] leading-[1.7] text-text ${className}`}
      style={{ background: s.bg, border: `1px solid ${s.border}` }}
    >
      {icon && <span className="text-[1.1rem] shrink-0 mt-0.5">{icon}</span>}
      <div style={{ ['--strong-color' as string]: s.strongColor } as React.CSSProperties}>
        {children}
      </div>
    </div>
  );
}

// ── Badge / Tag ───────────────────────────────────────────
export function Badge({
  children,
  color = 'accent',
}: {
  children: ReactNode;
  color?: 'accent' | 'green' | 'blue' | 'purple' | 'muted';
}) {
  const styles: Record<string, { bg: string; border: string; text: string }> = {
    accent: { bg: '#FDEFE5',                border: '#FBE3D1',                text: '#94421C' },
    green:  { bg: '#E6F1EC',                border: 'rgba(46,125,87,.25)',    text: '#2E7D57' },
    blue:   { bg: '#F5F5F4',                border: '#E8E9EA',                text: '#2B2B2D' },
    purple: { bg: 'rgba(234,106,31,.08)',   border: 'rgba(234,106,31,.25)',   text: '#94421C' },
    muted:  { bg: '#F5F5F4',                border: '#E8E9EA',                text: '#7C7C7F' },
  };
  const s = styles[color];
  return (
    <span
      className="inline-flex items-center gap-1 font-mono text-[.58rem] tracking-[.1em] uppercase px-[.6rem] py-[.22rem] rounded"
      style={{ background: s.bg, border: `1px solid ${s.border}`, color: s.text }}
    >
      {children}
    </span>
  );
}

// ── FeatureTag (p0/p1/p2) ────────────────────────────────
const featureTagStyles = {
  p0: { bg: '#FDEFE5',           border: '#FBE3D1',                text: '#94421C' },
  p1: { bg: 'rgba(234,106,31,.08)', border: 'rgba(234,106,31,.22)', text: '#94421C' },
  p2: { bg: '#F5F5F4',           border: '#E8E9EA',                text: '#7C7C7F' },
};

export function FeatureTag({ tier, children }: { tier: 'p0' | 'p1' | 'p2'; children: ReactNode }) {
  const s = featureTagStyles[tier];
  return (
    <span
      className="inline-flex font-mono text-[.57rem] tracking-[.1em] uppercase px-[.58rem] py-[.2rem] rounded"
      style={{ background: s.bg, border: `1px solid ${s.border}`, color: s.text }}
    >
      {children}
    </span>
  );
}

// ── PersonaCard ───────────────────────────────────────────
export function PersonaCard({
  num,
  name,
  role,
  subsections,
  badge,
  delay = 0,
}: {
  num: string;
  name: string;
  role: string;
  subsections: { label: string; items: string[] }[];
  badge?: { label: string; color?: 'accent' | 'green' | 'blue' | 'purple' | 'muted' };
  delay?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          el.style.opacity = '1';
          el.style.transform = 'translateY(0)';
          io.unobserve(el);
        }
      },
      { threshold: 0.1 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className="bg-card rounded-2xl overflow-hidden border border-border transition-[border-color] duration-300 hover:border-accent"
      style={{ opacity: 0, transform: 'translateY(14px)', transition: `opacity .5s ease ${delay}ms, transform .5s ease ${delay}ms, border-color .3s` }}
    >
      {/* Head */}
      <div
        className="px-5 sm:px-7 pt-5 sm:pt-6 pb-4 sm:pb-5 border-b border-border"
        style={{ background: 'linear-gradient(135deg, rgba(234,106,31,.05) 0%, #fff 70%)' }}
      >
        <div className="font-mono text-[.74rem] text-muted tracking-[.12em] uppercase mb-1">{num}</div>
        <div className="font-sans text-[1.05rem] sm:text-[1.15rem] font-bold text-text mb-1">{name}</div>
        <div className="font-mono text-[.66rem] text-muted">{role}</div>
      </div>
      {/* Body */}
      <div className="px-5 sm:px-7 py-5 sm:py-6">
        {subsections.map((sub) => (
          <div key={sub.label} className="mb-5 last:mb-0">
            <div className="flex items-center gap-1 font-mono text-[.72rem] text-accent tracking-[.1em] uppercase mb-3">
              <span className="text-[.42rem]">▶</span>
              {sub.label}
            </div>
            <ul className="flex flex-col gap-1 list-none">
              {sub.items.map((item, i) => (
                <li key={i} className="flex gap-[.6rem] text-[.88rem] text-text leading-[1.55]">
                  <span className="font-mono text-[.72rem] text-[#EA6A1F] shrink-0">—</span>
                  {item}
                </li>
              ))}
            </ul>
          </div>
        ))}
        {badge && (
          <div className="mt-4">
            <Badge color={badge.color ?? 'muted'}>{badge.label}</Badge>
          </div>
        )}
      </div>
    </div>
  );
}

// ── MetricCard ────────────────────────────────────────────
export function MetricCard({
  category,
  title,
  target,
  note,
  delay = 0,
}: {
  category: string;
  title: string;
  target: string;
  note: string;
  delay?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) { el.style.opacity = '1'; el.style.transform = 'translateY(0)'; io.unobserve(el); } },
      { threshold: 0.1 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className="bg-card border border-border rounded-[13px] p-6 transition-[border-color] duration-300 hover:border-accent"
      style={{ opacity: 0, transform: 'translateY(14px)', transition: `opacity .5s ease ${delay}ms, transform .5s ease ${delay}ms, border-color .3s` }}
    >
      <div className="font-mono text-[.72rem] text-muted tracking-[.14em] uppercase mb-2">{category}</div>
      <div className="font-sans text-[1.05rem] font-semibold text-text mb-2">{title}</div>
      <div className="font-mono text-[.85rem] text-accent mb-2">{target}</div>
      <p className="text-[.82rem] text-muted leading-[1.6]">{note}</p>
    </div>
  );
}

// ── RiskCard ──────────────────────────────────────────────
type Severity = 'high' | 'med' | 'low' | 'unknown';
const sevStyles: Record<Severity, { bg: string; border: string; text: string; label: string }> = {
  high:    { bg: '#FBE3D1',                border: 'rgba(148,66,28,.30)',    text: '#94421C', label: 'High' },
  med:     { bg: '#FDEFE5',                border: 'rgba(234,106,31,.30)',   text: '#94421C', label: 'Medium' },
  low:     { bg: '#E6F1EC',                border: 'rgba(46,125,87,.25)',    text: '#2E7D57', label: 'Low' },
  unknown: { bg: '#F5F5F4',                border: '#E8E9EA',                text: '#7C7C7F', label: 'Unknown' },
};

export function RiskCard({
  severity,
  title,
  rate,
  trigger,
  handling,
  delay = 0,
}: {
  severity: Severity;
  title: string;
  rate: string;
  trigger: string;
  handling: string;
  delay?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) { el.style.opacity = '1'; el.style.transform = 'translateY(0)'; io.unobserve(el); } },
      { threshold: 0.1 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const s = sevStyles[severity];
  return (
    <div
      ref={ref}
      className="bg-card border border-border rounded-[13px] p-6 transition-[border-color] duration-300 hover:border-accent"
      style={{ opacity: 0, transform: 'translateY(14px)', transition: `opacity .5s ease ${delay}ms, transform .5s ease ${delay}ms, border-color .3s` }}
    >
      <span
        className="inline-flex items-center gap-1 font-mono text-[.7rem] tracking-[.1em] uppercase px-[.55rem] py-[.22rem] rounded-md mb-4"
        style={{ background: s.bg, border: `1px solid ${s.border}`, color: s.text }}
      >
        {s.label}
      </span>
      <div className="font-sans text-[1rem] font-semibold text-text mb-1">{title}</div>
      <div className="font-mono text-[.72rem] text-muted mb-2">{rate}</div>
      <p className="text-[.85rem] text-muted leading-[1.6] mb-3">{trigger}</p>
      <div className="text-[.82rem] text-text px-4 py-3 bg-surface rounded-lg leading-[1.6]">
        {handling}
      </div>
    </div>
  );
}

// ── FeatureTable ──────────────────────────────────────────
interface FeatureRow {
  mode: 'p0' | 'p1' | 'p2';
  modeLabel: string;
  feature: string;
  description: string;
}

export function FeatureTable({ rows }: { rows: FeatureRow[] }) {
  return (
    <Reveal>
      {/* Mobile: stacked cards */}
      <div className="md:hidden flex flex-col gap-3">
        {rows.map((row, i) => (
          <div key={i} className="bg-card border border-border rounded-xl p-4">
            <div className="flex items-center gap-3 mb-2">
              <FeatureTag tier={row.mode}>{row.modeLabel}</FeatureTag>
              <span className="text-[.87rem] font-semibold text-text">{row.feature}</span>
            </div>
            <p className="text-[.81rem] text-muted leading-[1.65]">{row.description}</p>
          </div>
        ))}
      </div>

      {/* Desktop: table */}
      <div className="hidden md:block border border-border rounded-2xl overflow-hidden bg-card">
        <div className="grid border-b border-border" style={{ gridTemplateColumns: '1fr 2fr 4fr' }}>
          {['Mode', 'Feature', 'What it does'].map((h) => (
            <div key={h} className="px-6 py-4 border-r border-border last:border-r-0">
              <span className="font-mono text-[.6rem] text-muted tracking-[.14em] uppercase">{h}</span>
            </div>
          ))}
        </div>
        {rows.map((row, i) => (
          <div
            key={i}
            className="grid border-b border-border last:border-b-0 transition-colors duration-150 hover:bg-surface"
            style={{ gridTemplateColumns: '1fr 2fr 4fr' }}
          >
            <div className="px-6 py-[1.15rem] border-r border-border">
              <FeatureTag tier={row.mode}>{row.modeLabel}</FeatureTag>
            </div>
            <div className="px-6 py-[1.15rem] border-r border-border">
              <span className="text-[.87rem] font-semibold text-text">{row.feature}</span>
            </div>
            <div className="px-6 py-[1.15rem]">
              <span className="text-[.81rem] text-muted leading-[1.65]">{row.description}</span>
            </div>
          </div>
        ))}
      </div>
    </Reveal>
  );
}

// ── VerticalTabs ──────────────────────────────────────────
export function VerticalTabs({
  tabs,
}: {
  tabs: { id: string; label: string; content: ReactNode }[];
}) {
  const [active, setActive] = useState(tabs[0]?.id ?? '');

  return (
    <div>
      <div className="inline-flex bg-card border border-border rounded-[10px] p-1 gap-0.5 mb-8">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActive(t.id)}
            className={[
              'px-5 py-2 font-mono text-[.72rem] tracking-[.1em] uppercase rounded-[7px] border-none cursor-pointer transition-all duration-200',
              active === t.id
                ? 'bg-accent text-bg shadow-sm'
                : 'bg-transparent text-muted hover:text-text',
            ].join(' ')}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div key={t.id} className={active === t.id ? 'block' : 'hidden'}>
          {t.content}
        </div>
      ))}
    </div>
  );
}

// ── PageNav (prev / next) ─────────────────────────────────
import { Link } from 'react-router-dom';
import { useState } from 'react';

export function PageNav({
  prev,
  next,
}: {
  prev?: { to: string; label: string };
  next?: { to: string; label: string };
}) {
  return (
    <div className="grid grid-cols-2 gap-4 my-12">
      {prev ? (
        <Link
          to={prev.to}
          className="block bg-card border border-border rounded-xl px-6 py-[1.1rem] no-underline transition-all duration-200 hover:border-accent hover:-translate-y-0.5 hover:shadow-md"
        >
          <div className="font-mono text-[.6rem] text-muted tracking-[.14em] uppercase mb-1">← Previous</div>
          <div className="font-serif text-[1rem] text-text font-semibold">{prev.label}</div>
        </Link>
      ) : (
        <div />
      )}
      {next ? (
        <Link
          to={next.to}
          className="block bg-card border border-border rounded-xl px-6 py-[1.1rem] no-underline text-right transition-all duration-200 hover:border-accent hover:-translate-y-0.5 hover:shadow-md"
        >
          <div className="font-mono text-[.6rem] text-muted tracking-[.14em] uppercase mb-1">Next →</div>
          <div className="font-serif text-[1rem] text-text font-semibold">{next.label}</div>
        </Link>
      ) : (
        <div />
      )}
    </div>
  );
}

// ── EmptyPlaceholder ──────────────────────────────────────
export function EmptyPlaceholder({ children }: { children: ReactNode }) {
  return (
    <Reveal>
      <div className="bg-card border border-dashed border-border rounded-2xl p-8 text-muted font-mono text-[.78rem] leading-[1.8]">
        {children}
      </div>
    </Reveal>
  );
}

// ── SubHeading (section sub-group label) ──────────────────
export function SubHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="flex items-center gap-3 font-mono text-[.62rem] text-accent tracking-[.18em] uppercase my-6">
      <span className="inline-block w-4 h-px bg-[#EA6A1F]" />
      {children}
    </h3>
  );
}
