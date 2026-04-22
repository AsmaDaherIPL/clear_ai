// ─── Product Definition — Content (single source of truth) ───
// Edit HERE → TSX page + generated markdown both update.

export const PAGE = {
  chapter: 'Chapter 01 · Business',
  pageTitle: 'Product Definition',
  hero: {
    kicker: 'Chapter 01 · Business',
    title: 'An intelligent platform for customs clearance',
    titleAccent: 'for customs clearance',
    lede: "An intelligent platform that improves accuracy before clearance, reduces manual effort, and supports faster, more consistent customs processing. It helps teams work with greater confidence, lower the risk of errors, and move shipments through the clearance process more smoothly.",
  },
};

// ── Section 1: Problem ──
export const PROBLEM = {
  num: '1',
  label: 'Problem Statement',
  title: 'Why this needs to exist',
  desc: "Businesses lose time and face compliance risk because product classification is manual, inconsistent, and often incomplete before customs submission. Existing tools are often siloed by carrier, shipper, or workflow, making it difficult to manage classification consistently across the business.",
  issues: [
    {
      label: 'Issue 01',
      title: 'Slow clearance',
      body: 'Manual review and back-and-forth between shippers, agents, and customs holds shipments at the border. Every vague description or missing field triggers another round trip.',
    },
    {
      label: 'Issue 02',
      title: 'Higher compliance risk',
      body: 'Inaccurate or incomplete HS code data exposes businesses to penalties, reclassification, and rejected declarations — with costs that compound across shipments.',
    },
    {
      label: 'Issue 03',
      title: 'Fragmented workflows',
      body: "Classification tools are siloed by carrier, shipper, or workflow. Teams can't scale a consistent classification practice across clients, channels, and business units.",
    },
  ],
};

// ── Section 2: Solution ──
export const SOLUTION = {
  num: '2',
  label: 'Solution Overview',
  title: 'An AI platform for faster ZATCA clearance',
  titleAccent: 'faster ZATCA clearance',
  desc: 'ClearAI helps businesses pass ZATCA clearance faster by generating, refining, and validating HS code data before submission. Three distinct modes solve three distinct problems — **Generate** a compliant classification from scratch when you have no code, **Boost** a partial code into submission-ready precision, and **Validate** that code, description, and value are consistent before filing.',
  modesIntro: 'The three modes are not three flavors of the same engine — they are three distinct products sharing one platform. Each exists because a user at a different stage of the customs workflow has a different starting point and needs a different answer. The shape of the input alone determines the mode: no code → Generate, partial code → Boost, full code + value → Validate.',
  modes: [
    {
      num: 'Mode 01 · Create',
      name: 'Generate',
      role: 'For new products with no prior classification. ClearAI reads your product description and produces a full, submission-ready 12-digit HS code and ZATCA-compliant description from scratch — with justification and confidence scoring.',
      whenToUse: [
        'New SKUs with only a product name or short description',
        'Supplier spreadsheets with product names but no customs metadata',
        'First-time classification for a new product line or marketplace listing',
      ],
      badge: 'From scratch',
    },
    {
      num: 'Mode 02 · Improve',
      name: 'Boost',
      role: 'For products that already have a partial or chapter-level HS code. ClearAI drills down within the HS tree using your description and declared value to refine a generic code into a specific, submission-ready one.',
      whenToUse: [
        'ERP codes stuck at 4 or 6 digits that Bayan will reject',
        'Supplier-provided chapter headings that need subheading precision',
        'Legacy catalogs built before subheading-level classification was required',
      ],
      badge: 'Sharpen existing',
    },
    {
      num: 'Mode 03 · Check',
      name: 'Validate',
      role: 'For declarations that are ready to submit. ClearAI verifies that your HS code, description, and declared value tell a consistent story — flagging mismatches, implausible values, and suspicious combinations before they reach Bayan.',
      whenToUse: [
        'Final pre-submission coherence check before Bayan',
        'Compliance screening for suspicious code-description-value combinations',
        'Audit trail proving due diligence was performed on a declaration',
      ],
      badge: 'Pre-submission audit',
    },
  ],
};

// ── Section 3: Target Customer ──
export const TARGET_CUSTOMER = {
  num: '3',
  label: 'Target Customer',
  title: 'Who we serve',
  desc: "The product serves three segments across the customs value chain. Each has a different operating model, a different urgency, and a different mix of product modes — so packaging and go-to-market adapt to the segment while the backend stays shared.",
  segments: [
    {
      num: 'Segment A',
      name: 'Supply chain & logistics companies',
      role: 'Teams handling high shipment volumes that need faster, more consistent classification and customs documentation across many orders',
      subsections: [
        { label: 'What they care about', items: ['Operational efficiency and repeatability at scale', 'Visibility across shipments and teams', 'Keeping unit cost flat as shipment volume grows'] },
        { label: 'Primary modes', items: ['Boost — refine partial or supplier-provided codes', 'Validate — catch mismatches before Bayan submission'] },
      ],
      badge: 'Boost · Validate',
    },
    {
      num: 'Segment B',
      name: 'Ecommerce businesses',
      role: 'Businesses shipping cross-border into KSA that need scalable classification at checkout or order processing to reduce clearance delays',
      subsections: [
        { label: 'What they care about', items: ['Automation at scale across large catalogs', 'Product data that is customs-ready from day one', 'Fewer clearance surprises for the end customer'] },
        { label: 'Primary modes', items: ['Generate — create classifications from sparse product data', 'Boost — improve existing catalog codes over time'] },
      ],
      badge: 'Generate · Boost',
    },
    {
      num: 'Segment C',
      name: 'Independent clearance agents',
      role: 'Agents managing customs filings for multiple clients who need fast, accurate, and repeatable HS classification with less manual effort',
      subsections: [
        { label: 'What they care about', items: ['Moving quickly across many client inputs', 'Defensible classifications with clear rationale', 'Handling variable data quality from different clients'] },
        { label: 'Primary modes', items: ['All three — Generate, Boost, Validate depending on client data'] },
      ],
      badge: 'Generate · Boost · Validate',
    },
  ],
  note: "Not every segment uses every mode equally. Some will rely mostly on Validate, others on Generate and Boost — depending on the quality of input data and where they sit in the workflow.",
};

// ── Section 4: Features ──
export type FeatureMode = 'p0' | 'p1' | 'p2';

export interface Feature {
  mode: FeatureMode;
  modeLabel: string;
  feature: string;
  description: string;
}

export const FEATURES_SECTION = {
  num: '4',
  label: 'Features by Mode',
  title: 'What each mode does',
  desc: 'Features are organised by product mode so it is clear what each mode delivers on its own. This structure can be expanded into detailed requirements per mode when we move into build planning.',
};

export const FEATURES: Feature[] = [
  { mode: 'p0', modeLabel: 'Generate', feature: 'Flexible input',          description: 'Accepts input from description, image, or product attributes — works with whatever data the user has.' },
  { mode: 'p0', modeLabel: 'Generate', feature: 'Full 12-digit HS code',   description: 'Outputs a complete Saudi 12-digit HS code, not just a heading or chapter-level guess.' },
  { mode: 'p0', modeLabel: 'Generate', feature: 'ZATCA-ready description', description: 'Generates a compliant product description alongside the code, structured to match ZATCA submission format so it flows downstream without reformatting.' },
  { mode: 'p0', modeLabel: 'Generate', feature: 'Confidence & rationale',  description: 'Every result shows a confidence score and the reasoning behind the chosen classification.' },
  { mode: 'p1', modeLabel: 'Boost',    feature: 'Prefix-constrained drill-down', description: 'Takes a partial HS code (2–8 digits) and drills down within that branch of the HS tree to find the precise subheading.' },
  { mode: 'p1', modeLabel: 'Boost',    feature: 'Description-driven refinement', description: 'Uses the product description — and optionally declared value — to disambiguate and select the most specific code under the given prefix.' },
  { mode: 'p1', modeLabel: 'Boost',    feature: 'Before & after comparison', description: 'Shows the original generic code next to the refined code with a clear explanation of what drove the narrowing.' },
  { mode: 'p2', modeLabel: 'Validate', feature: 'Code ↔ Description check', description: 'Verifies the product description plausibly fits the HS code\'s official scope — catches mismatches like a leather code on a synthetic product.' },
  { mode: 'p2', modeLabel: 'Validate', feature: 'Description ↔ Value check', description: 'Flags implausible declared values — a Rolex at $20 or a pencil at $5,000 — before they trigger customs review.' },
  { mode: 'p2', modeLabel: 'Validate', feature: 'Pass / Warn / Fail verdict', description: 'Returns a clear verdict with per-check breakdown so reviewers know exactly what triggered and why.' },
  { mode: 'p2', modeLabel: 'Validate', feature: 'Audit-ready rationale',   description: 'Every flag includes a plain-language explanation, providing a compliance audit trail for every declaration checked.' },
];

// ── Section 5: Metrics ──
export interface Metric {
  category: string;
  title: string;
  target: string;
  note: string;
}

export const METRICS_SECTION = {
  num: '5',
  label: 'Success Metrics by Mode',
  title: "How we know it's working",
  desc: 'Each product mode is measured against a small set of focused metrics, plus three overall product metrics that track business outcome.',
};

export const METRICS: Record<string, Metric[]> = {
  generate: [
    { category: 'Quality',    title: 'Accepted without correction',     target: 'Target → % of generated classifications accepted without manual correction', note: 'Measures whether Generate output is trusted end-to-end, not just directionally useful.' },
    { category: 'Speed',      title: 'Time to first valid HS code',     target: 'Target → average time from input to first valid HS code output',             note: 'Covers latency plus any required input enrichment to reach a usable code.' },
    { category: 'Compliance', title: 'ZATCA-ready output rate',         target: 'Target → % of Generate outputs formatted and structured for ZATCA without rework', note: 'Measures whether Generate output flows straight into downstream submission.' },
  ],
  boost: [
    { category: 'Lift',       title: 'Improved over baseline',          target: 'Target → % of classifications improved compared to the input code',           note: 'Measures whether Boost is actually adding classification value beyond what the user had.' },
    { category: 'Efficiency', title: 'Reduction in manual reclassification', target: 'Target → time saved vs manual reclassification effort',                  note: "Tracks Boost's ability to replace slow, manual review cycles in large catalogs." },
    { category: 'Accuracy',   title: 'Accuracy uplift over existing codes', target: 'Target → measured uplift in classification accuracy vs existing codes',    note: 'Validates that "improved" codes are actually more correct, not just different.' },
  ],
  validate: [
    { category: 'Detection',  title: 'Invalid entries flagged',         target: 'Target → % of invalid or suspicious entries flagged before submission',        note: 'Measures whether Validate catches the problems it is supposed to catch.' },
    { category: 'Outcome',    title: 'Reduction in clearance issues',   target: 'Target → drop in clearance issues caused by inconsistent data',               note: 'Links Validate output directly to real ZATCA clearance outcomes.' },
    { category: 'Workflow',   title: 'Review resolution time',          target: 'Target → median time to resolve flagged items in the review queue',            note: 'Tracks whether flags are actionable and reviewable at operational speed.' },
  ],
  overall: [
    { category: 'Clearance',  title: 'Faster customs clearance cycles', target: 'Target → shorter end-to-end clearance cycle time',                            note: "The product's headline outcome — the reason customers care." },
    { category: 'Compliance', title: 'Lower compliance error rate',     target: 'Target → fewer ZATCA rejections, reclassifications, and penalties',            note: 'Tracks risk reduction across the full classification workflow.' },
    { category: 'Consistency',title: 'Higher classification consistency',target: 'Target → lower variance in classifications across teams and clients',           note: 'Proves the product is scaling a consistent classification practice, not just helping individuals.' },
  ],
};

// ── Section 6 & 7: Placeholders ──
export const ROADMAP = {
  num: '6',
  label: 'Roadmap',
  title: 'What ships, when',
  placeholder: 'Reserved for phased delivery plan across Generate, Boost, and Validate.',
};

export const OPEN_QUESTIONS = {
  num: '7',
  label: 'Open Questions',
  title: 'Open question parking lot',
  placeholder: 'Reserved for unresolved product, commercial, and operational questions.',
};

// ── Navigation ──
export const NAV = {
  next: { to: '/process', label: 'Current Naqel Process' },
};
