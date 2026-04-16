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

// ── HS Code Anatomy ───────────────────────────────────────
function HSAnatomy() {
  return (
    <Reveal>
      <div>
        {/* Layer labels */}
        <div className="hidden sm:flex gap-3 mb-1">
          <div className="flex-[3] text-center font-mono text-[.62rem] uppercase tracking-[.1em] font-semibold text-text px-2 py-1.5 rounded" style={{ background: 'rgba(14,23,41,.05)' }}>
            WCO Harmonized System · digits 1–6
          </div>
          <div className="w-4" />
          <div className="flex-1 text-center font-mono text-[.62rem] uppercase tracking-[.1em] font-semibold text-text px-2 py-1.5 rounded" style={{ background: 'rgba(45,90,142,.06)' }}>
            GCC · 7–8
          </div>
          <div className="w-4" />
          <div className="flex-[2] text-center font-mono text-[.62rem] uppercase tracking-[.1em] font-semibold text-text px-2 py-1.5 rounded" style={{ background: 'rgba(10,122,82,.06)' }}>
            Saudi Local · digits 9–12
          </div>
        </div>

        {/* Code blocks — scroll on mobile */}
        <div className="overflow-x-auto -mx-1 px-1">
        <div className="flex gap-2 mb-6 min-w-[480px]">
          {/* WCO 6 digits */}
          <div className="flex-[3] flex rounded-xl overflow-hidden border border-[rgba(14,23,41,.18)]">
            {[
              { digits: '85', label: 'Chapter', sub: 'digits 1–2', color: 'var(--gold)', bg: '#f0f3f8' },
              { digits: '17', label: 'Heading', sub: 'digits 3–4', color: 'var(--orange)', bg: '#eaeff5' },
              { digits: '12', label: 'Subheading', sub: 'digits 5–6', color: '#2d5a8e', bg: '#e4ebf3' },
            ].map((item, i) => (
              <div
                key={item.digits}
                className="flex-1 px-4 py-3"
                style={{
                  background: item.bg,
                  borderRight: i < 2 ? '1px solid rgba(14,23,41,.12)' : undefined,
                }}
              >
                <div className="font-mono text-[1.2rem] font-bold" style={{ color: item.color, letterSpacing: '.06em' }}>{item.digits}</div>
                <div className="text-[.72rem] text-muted mt-1">{item.label}</div>
                <div className="font-mono text-[.62rem] text-dim mt-0.5">{item.sub}</div>
              </div>
            ))}
          </div>
          {/* GCC */}
          <div className="flex-1 rounded-xl overflow-hidden border" style={{ borderColor: 'rgba(29,78,216,.25)' }}>
            <div className="px-4 py-3" style={{ background: '#f0f4ff' }}>
              <div className="font-mono text-[1.2rem] font-bold text-blue" style={{ letterSpacing: '.06em' }}>10</div>
              <div className="text-[.72rem] text-muted mt-1">GCC Tariff</div>
              <div className="font-mono text-[.62rem] text-dim mt-0.5">digits 7–8</div>
            </div>
          </div>
          {/* Saudi */}
          <div className="flex-[2] rounded-xl overflow-hidden border" style={{ borderColor: 'rgba(10,122,82,.25)' }}>
            <div className="px-4 py-3" style={{ background: '#edf7f2' }}>
              <div className="font-mono text-[1.2rem] font-bold text-green" style={{ letterSpacing: '.06em' }}>0000</div>
              <div className="text-[.72rem] text-muted mt-1">Saudi Local Sub-categories</div>
              <div className="font-mono text-[.62rem] text-dim mt-0.5">digits 9–12</div>
            </div>
          </div>
        </div>
        </div>{/* end overflow-x-auto */}

        {/* Example */}
        <div className="flex items-center gap-3 flex-wrap mb-4">
          <span className="font-mono text-[.72rem] text-muted">Example:</span>
          <div className="bg-surface border border-border rounded-lg px-3 py-1.5 inline-flex gap-0 items-center">
            <span className="font-mono text-[.95rem] font-bold" style={{ color: 'var(--gold)' }}>85</span>
            <span className="font-mono text-[.95rem] font-bold text-orange">17</span>
            <span className="font-mono text-[.95rem] font-bold" style={{ color: '#2d5a8e' }}>12</span>
            <span className="font-mono text-[.95rem] text-dim mx-1">·</span>
            <span className="font-mono text-[.95rem] font-bold text-blue">10</span>
            <span className="font-mono text-[.95rem] text-dim mx-1">·</span>
            <span className="font-mono text-[.95rem] font-bold text-green">0000</span>
          </div>
          <span className="text-[.75rem] text-muted">Smartphones — Saudi 12-digit format</span>
        </div>

        {/* Legend */}
        <div className="flex gap-5 flex-wrap mt-2">
          {[
            { color: 'var(--gold)',    label: 'Digits 1–6: WCO HS — universal across 200+ countries' },
            { color: 'var(--blue)',    label: 'Digits 7–8: GCC Common Tariff' },
            { color: 'var(--green)',   label: 'Digits 9–12: Saudi local sub-categories' },
          ].map((l) => (
            <div key={l.label} className="flex items-center gap-2 text-[.72rem] text-muted">
              <span className="w-[10px] h-[10px] rounded-[2px] inline-block shrink-0" style={{ background: l.color }} />
              {l.label}
            </div>
          ))}
        </div>
      </div>
    </Reveal>
  );
}

// ── Authority cards ───────────────────────────────────────
const AUTHORITIES = [
  {
    abbr: 'WCO',
    name: 'World Customs Organization',
    sub: 'Brussels · 186 member countries',
    does: 'Maintains the Harmonized System (HS) — the universal 6-digit product classification language. Publishes and updates the nomenclature every 5 years (current edition: HS 2022).',
    relevance: "The first 6 digits of every Saudi HS code are WCO-defined. Clear AI's classification engine is trained on WCO HS 2022 headings and the 6 GRI rules.",
  },
  {
    abbr: 'ZATCA',
    name: 'Zakat, Tax & Customs Authority',
    sub: 'Saudi Arabia · government customs body',
    does: "Governs all Saudi customs declarations via the Bayan system. Defines the 12-digit national tariff schedule, import duties, and the Arabic XML format for Bayan filings.",
    relevance: 'Clear AI generates ZATCA-compliant Bayan XML output with Arabic product descriptions. The Saudi-specific digits 7–12 follow ZATCA\'s national tariff schedule.',
  },
  {
    abbr: 'SABER',
    name: 'Saudi Product Registration Platform',
    sub: 'Run by SASO · separate from customs clearance',
    does: 'Handles conformity assessment for regulated product categories (electronics, toys, PPE, food contact materials). Products must obtain a SABER certificate before customs release.',
    relevance: 'Clear AI flags when a classified HS code falls under a SABER-regulated category. This is a downstream signal only — Clear AI does not file or manage SABER certificates.',
    note: 'SABER is pre-import product registration for specific regulated categories — not customs clearance.',
  },
];

// ── GRI Rules ─────────────────────────────────────────────
const GRI_RULES = [
  { id: 'GRI 1', label: 'Headings & Notes',            body: 'Classify by the exact wording of headings and any section/chapter notes — not by titles. Resolves the majority of classifications.' },
  { id: 'GRI 2', label: 'Incomplete & Mixtures',        body: 'Incomplete or disassembled articles classify as the finished item. Mixtures of materials follow the heading for that material; composite goods use Rule 3.' },
  { id: 'GRI 3', label: 'Specificity & Essential Character', body: 'When multiple headings fit: (a) most specific wins, (b) if tied, classify by essential character, (c) last resort — numerically highest code. This is where AI disambiguation operates.' },
  { id: 'GRI 4', label: 'Most Akin Goods',              body: 'If Rules 1–3 fail, classify under the heading for the most similar article. Rarely invoked — flags for human review.' },
  { id: 'GRI 5', label: 'Cases & Packaging',            body: 'Containers and packing materials classify with their contents when normally sold together. Reusable packaging is classified separately.' },
  { id: 'GRI 6', label: 'Subheading Level',             body: 'Apply GRI 1–5 at the subheading level. Subheadings only compare within the same heading — each level has its own specificity rules.' },
];

// ── Source type cards ─────────────────────────────────────
const SOURCE_TYPES = [
  {
    style: { bg: 'rgba(29,78,216,.08)', border: 'rgba(29,78,216,.2)', color: 'var(--blue)' },
    label: 'User Input',
    title: 'User-provided text',
    body: 'Product details, descriptions, and any HS codes the client has already declared. This is the primary classification input — variable quality, always present.',
  },
  {
    style: { bg: 'rgba(107,114,144,.1)', border: 'var(--border)', color: 'var(--muted)' },
    label: 'Global Standard',
    title: 'Global HS rules',
    body: 'General Rules for Interpretation, chapter notes, section notes, heading logic, essential character and specificity rules. Published by the WCO. This is the classification logic layer.',
  },
  {
    style: { bg: 'rgba(251,146,60,.1)', border: 'rgba(251,146,60,.3)', color: '#c2440e' },
    label: 'Saudi Layer',
    title: 'Saudi customs rules',
    body: 'ZATCA tariff structure, Saudi import instructions, Arabic description requirements, local certificate and clearance process requirements. Applied on top of the global HS rules — not a replacement for them.',
  },
  {
    style: { bg: 'rgba(52,211,153,.1)', border: 'rgba(52,211,153,.3)', color: '#0a7a52' },
    label: 'Internal',
    title: 'Internal knowledge',
    body: 'Expert-reviewed past cases, your own labelling data, human review decisions. Used as product knowledge only after validation — never as a primary rule source.',
  },
];

// ── Page ──────────────────────────────────────────────────
export default function Reference() {
  return (
    <Layout chapter="Chapter 04 · Domain context" pageTitle="Reference Material">
      <PageHero
        kicker="Chapter 04 · Domain context"
        title={<>Reference <em className="not-italic text-accent">material</em></>}
        lede="The classification system, regulatory authorities, and interpretation rules that govern every HS code decision. This chapter is the single reference for domain knowledge used across the product definition, operating model, and architecture."
      />

      {/* SharePoint link */}
      <div className="px-4 sm:px-8 lg:px-12 pt-2 pb-6">
        <div className="max-w-[1160px] mx-auto">
          <a
            href="https://infinitepl.sharepoint.com/:f:/s/ClearanceAI/IgCt83tlmi1qS7EfqqDAiCOqATRM8tPdR1yBBfhrvIFUVBA?e=y2fopm"
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[.85rem] text-blue hover:underline underline-offset-2"
          >
            SharePoint Folder — Sample Data &amp; Resources →
          </a>
        </div>
      </div>

      {/* 1. HS Code Anatomy */}
      <section id="hs-anatomy" className="px-4 sm:px-8 lg:px-12 py-10 sm:py-14">
        <div className="max-w-[1160px] mx-auto">
          <SectionLabel num="1">HS Code Structure</SectionLabel>
          <SectionTitle>Saudi HS Code <em className="not-italic text-accent">anatomy — 12 digits</em></SectionTitle>
          <SectionDesc>
            Every Saudi tariff code is 12 digits long, built from three layers controlled by different authorities.
          </SectionDesc>
          <HSAnatomy />
        </div>
      </section>

      <Divider />

      {/* 2. Authorities */}
      <section id="authorities" className="px-4 sm:px-8 lg:px-12 py-10 sm:py-14">
        <div className="max-w-[1160px] mx-auto">
          <SectionLabel num="2">The Authorities</SectionLabel>
          <SectionTitle>Who sets the <em className="not-italic text-accent">rules</em></SectionTitle>
          <SectionDesc>
            Three organisations govern what Clear AI classifies, how declarations are filed, and whether a product
            needs conformity registration before it clears customs.
          </SectionDesc>

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
                    style={{ background: 'rgba(29,78,216,.05)', border: '1px solid rgba(29,78,216,.15)', borderRadius: '8px', padding: '.7rem .9rem' }}>
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
          <SectionLabel num="3">WCO General Rules of Interpretation</SectionLabel>
          <SectionTitle>Classification <em className="not-italic text-accent">rules — GRI 1–6</em></SectionTitle>
          <SectionDesc>
            Six legally-binding rules that determine which HS code applies to any product. Applied in strict order
            — only advance to the next rule when the previous one cannot resolve.
          </SectionDesc>

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
            <a
              href="sharepoint/General/other/hs-interpretation-general-rules_0001_2012e_gir.pdf"
              target="_blank"
              rel="noreferrer"
              className="text-accent underline underline-offset-[2px]"
            >
              "General Rules for the Interpretation of the Harmonized System" (WCO, 2012 Edition)
            </a>
          </Callout>
        </div>
      </section>

      <Divider />

      {/* 4. Rules, Sources & Assumptions */}
      <section id="rules" className="px-4 sm:px-8 lg:px-12 py-10 sm:py-14">
        <div className="max-w-[1160px] mx-auto">
          <SectionLabel num="4">Rules, Sources &amp; Assumptions</SectionLabel>
          <SectionTitle>Where the logic <em className="not-italic text-accent">comes from</em></SectionTitle>
          <SectionDesc>
            V1 uses four distinct source types. These must be kept separate — mixing them creates ambiguity about
            what is legally binding, what is operationally required, and what is still a hypothesis.
          </SectionDesc>

          <Reveal className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-10">
            {SOURCE_TYPES.map((s) => (
              <div key={s.label} className="bg-card border border-border rounded-[14px] p-7">
                <span
                  className="inline-block font-mono text-[.6rem] tracking-[.1em] uppercase px-[.7rem] py-[.25rem] rounded mb-4"
                  style={{ background: s.style.bg, border: `1px solid ${s.style.border}`, color: s.style.color }}
                >
                  {s.label}
                </span>
                <h4 className="font-sans font-bold text-text mb-2">{s.title}</h4>
                <p className="text-[.82rem] text-muted leading-[1.65]">{s.body}</p>
              </div>
            ))}
          </Reveal>
        </div>
      </section>

      <div className="px-4 sm:px-8 lg:px-12">
        <PageNav
          prev={{ to: '/architecture', label: 'Technical Architecture' }}
        />
      </div>
    </Layout>
  );
}
