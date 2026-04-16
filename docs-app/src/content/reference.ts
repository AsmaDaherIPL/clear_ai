// ─── Reference — Content (single source of truth) ────────
// Edit HERE → TSX page + generated markdown both update.

export const PAGE = {
  chapter: 'Chapter 04 · Domain context',
  pageTitle: 'Reference Material',
  hero: {
    kicker: 'Chapter 04 · Domain context',
    title: 'Reference material',
    titleAccent: 'material',
    lede: 'The classification system, regulatory authorities, and interpretation rules that govern every HS code decision. This chapter is the single reference for domain knowledge used across the product definition, operating model, and architecture.',
  },
  sharepointLink: 'https://infinitepl.sharepoint.com/:f:/s/ClearanceAI/IgCt83tlmi1qS7EfqqDAiCOqATRM8tPdR1yBBfhrvIFUVBA?e=y2fopm',
};

// ── Section 1: HS Code Structure ──
export const HS_ANATOMY = {
  num: '1',
  label: 'HS Code Structure',
  title: 'Saudi HS Code anatomy — 12 digits',
  titleAccent: 'anatomy — 12 digits',
  desc: 'Every Saudi tariff code is 12 digits long, built from three layers controlled by different authorities.',
  layers: [
    { digits: '85', label: 'Chapter',    sub: 'digits 1–2' },
    { digits: '17', label: 'Heading',    sub: 'digits 3–4' },
    { digits: '12', label: 'Subheading', sub: 'digits 5–6' },
  ],
  gcc: { digits: '10', label: 'GCC Tariff', sub: 'digits 7–8' },
  saudi: { digits: '0000', label: 'Saudi Local Sub-categories', sub: 'digits 9–12' },
  example: { code: '851712100000', display: 'Smartphones — Saudi 12-digit format' },
  legend: [
    'Digits 1–6: WCO HS — universal across 200+ countries',
    'Digits 7–8: GCC Common Tariff',
    'Digits 9–12: Saudi local sub-categories',
  ],
};

// ── Section 2: Authorities ──
export const AUTHORITIES_SECTION = {
  num: '2',
  label: 'The Authorities',
  title: 'Who sets the rules',
  titleAccent: 'rules',
  desc: 'Three organisations govern what Clear AI classifies, how declarations are filed, and whether a product needs conformity registration before it clears customs.',
};

export const AUTHORITIES = [
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
    does: 'Governs all Saudi customs declarations via the Bayan system. Defines the 12-digit national tariff schedule, import duties, and the Arabic XML format for Bayan filings.',
    relevance: "Clear AI generates ZATCA-compliant Bayan XML output with Arabic product descriptions. The Saudi-specific digits 7–12 follow ZATCA's national tariff schedule.",
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

// ── Section 3: GRI Rules ──
export const GRI_SECTION = {
  num: '3',
  label: 'WCO General Rules of Interpretation',
  title: 'Classification rules — GRI 1–6',
  titleAccent: 'rules — GRI 1–6',
  desc: 'Six legally-binding rules that determine which HS code applies to any product. Applied in strict order — only advance to the next rule when the previous one cannot resolve.',
  referenceDoc: '"General Rules for the Interpretation of the Harmonized System" (WCO, 2012 Edition)',
  referenceLink: 'sharepoint/General/other/hs-interpretation-general-rules_0001_2012e_gir.pdf',
};

export const GRI_RULES = [
  { id: 'GRI 1', label: 'Headings & Notes',            body: 'Classify by the exact wording of headings and any section/chapter notes — not by titles. Resolves the majority of classifications.' },
  { id: 'GRI 2', label: 'Incomplete & Mixtures',        body: 'Incomplete or disassembled articles classify as the finished item. Mixtures of materials follow the heading for that material; composite goods use Rule 3.' },
  { id: 'GRI 3', label: 'Specificity & Essential Character', body: 'When multiple headings fit: (a) most specific wins, (b) if tied, classify by essential character, (c) last resort — numerically highest code. This is where AI disambiguation operates.' },
  { id: 'GRI 4', label: 'Most Akin Goods',              body: 'If Rules 1–3 fail, classify under the heading for the most similar article. Rarely invoked — flags for human review.' },
  { id: 'GRI 5', label: 'Cases & Packaging',            body: 'Containers and packing materials classify with their contents when normally sold together. Reusable packaging is classified separately.' },
  { id: 'GRI 6', label: 'Subheading Level',             body: 'Apply GRI 1–5 at the subheading level. Subheadings only compare within the same heading — each level has its own specificity rules.' },
];

// ── Section 4: Rules, Sources & Assumptions ──
export const SOURCES_SECTION = {
  num: '4',
  label: 'Rules, Sources & Assumptions',
  title: 'Where the logic comes from',
  titleAccent: 'comes from',
  desc: 'V1 uses four distinct source types. These must be kept separate — mixing them creates ambiguity about what is legally binding, what is operationally required, and what is still a hypothesis.',
};

export const SOURCE_TYPES = [
  {
    label: 'User Input',
    title: 'User-provided text',
    body: 'Product details, descriptions, and any HS codes the client has already declared. This is the primary classification input — variable quality, always present.',
    colorKey: 'blue' as const,
  },
  {
    label: 'Global Standard',
    title: 'Global HS rules',
    body: 'General Rules for Interpretation, chapter notes, section notes, heading logic, essential character and specificity rules. Published by the WCO. This is the classification logic layer.',
    colorKey: 'gray' as const,
  },
  {
    label: 'Saudi Layer',
    title: 'Saudi customs rules',
    body: 'ZATCA tariff structure, Saudi import instructions, Arabic description requirements, local certificate and clearance process requirements. Applied on top of the global HS rules — not a replacement for them.',
    colorKey: 'orange' as const,
  },
  {
    label: 'Internal',
    title: 'Internal knowledge',
    body: 'Expert-reviewed past cases, your own labelling data, human review decisions. Used as product knowledge only after validation — never as a primary rule source.',
    colorKey: 'green' as const,
  },
];

// ── Navigation ──
export const NAV = {
  prev: { to: '/architecture', label: 'Technical Architecture' },
};
