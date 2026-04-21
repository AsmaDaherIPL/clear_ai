import Layout, { PageHero } from '../components/Layout';
import {
  SectionLabel,
  SectionTitle,
  SectionDesc,
  Divider,
  Callout,
  PageNav,
  Reveal,
} from '../components/ui';
import {
  PAGE, HS_ANATOMY, AUTHORITIES_SECTION, AUTHORITIES,
  GRI_SECTION, GRI_RULES, SOURCES_SECTION, SOURCE_TYPES, NAV,
} from '../content/reference';

// ── HS Code Anatomy ───────────────────────────────────────
function HSAnatomy() {
  return (
    <Reveal>
      <div>
        {/* Layer labels */}
        <div className="hidden sm:flex gap-3 mb-1">
          <div className="flex-[3] text-center font-mono text-[.62rem] uppercase tracking-[.1em] font-semibold text-text px-2 py-1.5 rounded" style={{ background: '#FDEFE5' }}>
            WCO Harmonized System · digits 1–6
          </div>
          <div className="w-4" />
          <div className="flex-1 text-center font-mono text-[.62rem] uppercase tracking-[.1em] font-semibold text-text px-2 py-1.5 rounded" style={{ background: '#F5F5F4' }}>
            GCC · 7–8
          </div>
          <div className="w-4" />
          <div className="flex-[2] text-center font-mono text-[.62rem] uppercase tracking-[.1em] font-semibold text-text px-2 py-1.5 rounded" style={{ background: '#E6F1EC' }}>
            Saudi Local · digits 9–12
          </div>
        </div>

        {/* Code blocks */}
        <div className="overflow-x-auto -mx-1 px-1">
        <div className="flex gap-2 mb-6 min-w-[480px]">
          {/* WCO 6 digits */}
          <div className="flex-[3] flex rounded-xl overflow-hidden border border-[#E8E9EA]">
            {HS_ANATOMY.layers.map((item, i) => {
              const colors = ['#94421C', '#EA6A1F', '#2B2B2D'];
              const bgs = ['#FDEFE5', '#FBE3D1', '#F5F5F4'];
              return (
                <div
                  key={item.digits}
                  className="flex-1 px-4 py-3"
                  style={{
                    background: bgs[i],
                    borderRight: i < 2 ? '1px solid #E8E9EA' : undefined,
                  }}
                >
                  <div className="font-mono text-[1.2rem] font-bold" style={{ color: colors[i], letterSpacing: '.06em' }}>{item.digits}</div>
                  <div className="text-[.72rem] text-muted mt-1">{item.label}</div>
                  <div className="font-mono text-[.62rem] text-dim mt-0.5">{item.sub}</div>
                </div>
              );
            })}
          </div>
          {/* GCC */}
          <div className="flex-1 rounded-xl overflow-hidden border" style={{ borderColor: '#E8E9EA' }}>
            <div className="px-4 py-3" style={{ background: '#F5F5F4' }}>
              <div className="font-mono text-[1.2rem] font-bold" style={{ letterSpacing: '.06em', color: '#2B2B2D' }}>{HS_ANATOMY.gcc.digits}</div>
              <div className="text-[.72rem] text-muted mt-1">{HS_ANATOMY.gcc.label}</div>
              <div className="font-mono text-[.62rem] text-dim mt-0.5">{HS_ANATOMY.gcc.sub}</div>
            </div>
          </div>
          {/* Saudi */}
          <div className="flex-[2] rounded-xl overflow-hidden border" style={{ borderColor: 'rgba(46,125,87,.25)' }}>
            <div className="px-4 py-3" style={{ background: '#E6F1EC' }}>
              <div className="font-mono text-[1.2rem] font-bold text-green" style={{ letterSpacing: '.06em' }}>{HS_ANATOMY.saudi.digits}</div>
              <div className="text-[.72rem] text-muted mt-1">{HS_ANATOMY.saudi.label}</div>
              <div className="font-mono text-[.62rem] text-dim mt-0.5">{HS_ANATOMY.saudi.sub}</div>
            </div>
          </div>
        </div>
        </div>

        {/* Example */}
        <div className="flex items-center gap-3 flex-wrap mb-4">
          <span className="font-mono text-[.72rem] text-muted">Example:</span>
          <div className="bg-surface border border-border rounded-lg px-3 py-1.5 inline-flex gap-0 items-center">
            <span className="font-mono text-[.95rem] font-bold" style={{ color: 'var(--gold)' }}>85</span>
            <span className="font-mono text-[.95rem] font-bold text-orange">17</span>
            <span className="font-mono text-[.95rem] font-bold" style={{ color: '#2B2B2D' }}>12</span>
            <span className="font-mono text-[.95rem] text-dim mx-1">·</span>
            <span className="font-mono text-[.95rem] font-bold text-blue">10</span>
            <span className="font-mono text-[.95rem] text-dim mx-1">·</span>
            <span className="font-mono text-[.95rem] font-bold text-green">0000</span>
          </div>
          <span className="text-[.75rem] text-muted">{HS_ANATOMY.example.display}</span>
        </div>

        {/* Legend */}
        <div className="flex gap-5 flex-wrap mt-2">
          {HS_ANATOMY.legend.map((text, i) => {
            const colors = ['var(--gold)', 'var(--blue)', 'var(--green)'];
            return (
              <div key={text} className="flex items-center gap-2 text-[.72rem] text-muted">
                <span className="w-[10px] h-[10px] rounded-[2px] inline-block shrink-0" style={{ background: colors[i] }} />
                {text}
              </div>
            );
          })}
        </div>
      </div>
    </Reveal>
  );
}

// ── Source type styles ─────────────────────────────────────
const sourceColorStyles: Record<string, { bg: string; border: string; color: string }> = {
  blue:   { bg: '#F5F5F4',                border: '#E8E9EA',                color: '#2B2B2D' },
  gray:   { bg: '#F5F5F4',                border: '#E8E9EA',                color: '#7C7C7F' },
  orange: { bg: '#FDEFE5',                border: '#FBE3D1',                color: '#94421C' },
  green:  { bg: '#E6F1EC',                border: 'rgba(46,125,87,.30)',    color: '#2E7D57' },
};

// ── Page ──────────────────────────────────────────────────
export default function Reference() {
  return (
    <Layout chapter={PAGE.chapter} pageTitle={PAGE.pageTitle}>
      <PageHero
        kicker={PAGE.hero.kicker}
        title={<>Reference <em className="not-italic text-accent">{PAGE.hero.titleAccent}</em></>}
        lede={PAGE.hero.lede}
      />

      {/* SharePoint link */}
      <div className="px-4 sm:px-8 lg:px-12 pt-2 pb-6">
        <div className="max-w-[1160px] mx-auto">
          <a href={PAGE.sharepointLink} target="_blank" rel="noreferrer" className="font-mono text-[.85rem] text-blue hover:underline underline-offset-2">
            SharePoint Folder — Sample Data &amp; Resources →
          </a>
        </div>
      </div>

      {/* 1. HS Code Anatomy */}
      <section id="hs-anatomy" className="px-4 sm:px-8 lg:px-12 py-10 sm:py-14">
        <div className="max-w-[1160px] mx-auto">
          <SectionLabel num={HS_ANATOMY.num}>{HS_ANATOMY.label}</SectionLabel>
          <SectionTitle>Saudi HS Code <em className="not-italic text-accent">{HS_ANATOMY.titleAccent}</em></SectionTitle>
          <SectionDesc>{HS_ANATOMY.desc}</SectionDesc>
          <HSAnatomy />
        </div>
      </section>

      <Divider />

      {/* 2. Authorities */}
      <section id="authorities" className="px-4 sm:px-8 lg:px-12 py-10 sm:py-14">
        <div className="max-w-[1160px] mx-auto">
          <SectionLabel num={AUTHORITIES_SECTION.num}>{AUTHORITIES_SECTION.label}</SectionLabel>
          <SectionTitle>Who sets the <em className="not-italic text-accent">{AUTHORITIES_SECTION.titleAccent}</em></SectionTitle>
          <SectionDesc>{AUTHORITIES_SECTION.desc}</SectionDesc>

          <Reveal className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-8">
            {AUTHORITIES.map((a) => (
              <div key={a.abbr} className="bg-card border border-border rounded-[14px] p-7 flex flex-col gap-4">
                <div className="font-mono text-[.6rem] uppercase tracking-[.12em] text-muted">{a.abbr}</div>
                <div>
                  <div className="font-serif text-[1.05rem] font-bold text-text mb-1">{a.name}</div>
                  <div className="text-[.78rem] text-muted">{a.sub}</div>
                </div>
                <div className="flex flex-col gap-3">
                  <div>
                    <div className="font-mono text-[.62rem] uppercase tracking-[.08em] text-dim mb-1">What it does</div>
                    <div className="text-[.82rem] text-text leading-[1.55]">{a.does}</div>
                  </div>
                  <div>
                    <div className="font-mono text-[.62rem] uppercase tracking-[.08em] text-dim mb-1">Clear AI relevance</div>
                    <div className="text-[.82rem] text-text leading-[1.55]">{a.relevance}</div>
                  </div>
                </div>
                {a.note && (
                  <div className="mt-auto pt-3 border-t border-border text-[.76rem] text-muted leading-[1.5]"
                    style={{ background: '#FDEFE5', border: '1px solid #FBE3D1', borderRadius: '8px', padding: '.7rem .9rem' }}>
                    <strong>Note:</strong> {a.note}
                  </div>
                )}
              </div>
            ))}
          </Reveal>
        </div>
      </section>

      <Divider />

      {/* 3. GRI Rules */}
      <section id="hs-interpretation" className="px-4 sm:px-8 lg:px-12 py-10 sm:py-14">
        <div className="max-w-[1160px] mx-auto">
          <SectionLabel num={GRI_SECTION.num}>{GRI_SECTION.label}</SectionLabel>
          <SectionTitle>Classification <em className="not-italic text-accent">{GRI_SECTION.titleAccent}</em></SectionTitle>
          <SectionDesc>{GRI_SECTION.desc}</SectionDesc>

          <Reveal className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-8">
            {GRI_RULES.map((r) => (
              <div key={r.id} className="bg-card border border-border rounded-xl px-5 py-5">
                <div className="font-mono text-[.6rem] uppercase tracking-[.1em] text-accent mb-2">
                  {r.id} — {r.label}
                </div>
                <div className="text-[.8rem] text-muted leading-[1.55]">{r.body}</div>
              </div>
            ))}
          </Reveal>

          <Callout variant="note" icon="📋" className="mt-8">
            <strong>Reference document:</strong>{' '}
            <a href={GRI_SECTION.referenceLink} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-[2px]">
              {GRI_SECTION.referenceDoc}
            </a>
          </Callout>
        </div>
      </section>

      <Divider />

      {/* 4. Rules, Sources & Assumptions */}
      <section id="rules" className="px-4 sm:px-8 lg:px-12 py-10 sm:py-14">
        <div className="max-w-[1160px] mx-auto">
          <SectionLabel num={SOURCES_SECTION.num}>{SOURCES_SECTION.label}</SectionLabel>
          <SectionTitle>Where the logic <em className="not-italic text-accent">{SOURCES_SECTION.titleAccent}</em></SectionTitle>
          <SectionDesc>{SOURCES_SECTION.desc}</SectionDesc>

          <Reveal className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-10">
            {SOURCE_TYPES.map((s) => {
              const cs = sourceColorStyles[s.colorKey];
              return (
                <div key={s.label} className="bg-card border border-border rounded-[14px] p-7">
                  <span
                    className="inline-block font-mono text-[.6rem] tracking-[.1em] uppercase px-[.7rem] py-[.25rem] rounded mb-4"
                    style={{ background: cs.bg, border: `1px solid ${cs.border}`, color: cs.color }}
                  >
                    {s.label}
                  </span>
                  <h4 className="font-display font-normal text-text mb-2">{s.title}</h4>
                  <p className="text-[.82rem] text-muted leading-[1.65]">{s.body}</p>
                </div>
              );
            })}
          </Reveal>
        </div>
      </section>

      <div className="px-4 sm:px-8 lg:px-12">
        <PageNav prev={NAV.prev} />
      </div>
    </Layout>
  );
}
