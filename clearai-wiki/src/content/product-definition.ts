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
  desc: 'ClearAI helps businesses pass ZATCA clearance faster by generating, refining, and validating HS code data before submission. Three distinct modes solve three distinct problems — **Create** a compliant classification from scratch when you have no code, **Expand** a partial code into submission-ready precision, and **Validate** the coherence of code, description, and value before the declaration leaves your hands.',
  modesIntro: 'The three modes are not three flavors of the same engine — they are three distinct products sharing one platform. Each exists because a user at a different stage of the customs workflow has a different starting point and needs a different answer. The shape of the input alone determines the mode: no code → Create, partial code → Expand, complete declaration → Validate.',
  modes: [
    {
      num: 'Mode 01 · Create',
      name: 'Generate',
      role: 'Free-text description → full 12-digit ZATCA code.',
      whenToUse: [
        'New SKUs with only a product name or short description',
        'Supplier spreadsheets with product names but no customs metadata',
        'First-time classification for a new product line or marketplace listing',
      ],
      badge: 'From scratch',
    },
    {
      num: 'Mode 02 · Expand',
      name: 'Expand',
      role: 'For products that already have a partial HS code prefix (4, 6, 8 or 10 digits). ClearAI drills down within that branch of the HS tree using your description to land on the precise 12-digit leaf.',
      whenToUse: [
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
        { label: 'Primary modes', items: ['Expand — drill partial or supplier-provided prefixes down to a 12-digit leaf', 'Validate — pre-submission coherence check before Bayan'] },
      ],
      badge: 'Expand · Validate',
    },
    {
      num: 'Segment B',
      name: 'Ecommerce businesses',
      role: 'Businesses shipping cross-border into KSA that need scalable classification at checkout or order processing to reduce clearance delays',
      subsections: [
        { label: 'What they care about', items: ['Automation at scale across large catalogs', 'Product data that is customs-ready from day one', 'Fewer clearance surprises for the end customer'] },
        { label: 'Primary modes', items: ['Create — generate classifications from sparse product data', 'Expand — improve existing catalog codes over time', 'Validate — screen declarations before they reach Bayan'] },
      ],
      badge: 'Create · Expand · Validate',
    },
    {
      num: 'Segment C',
      name: 'Independent clearance agents',
      role: 'Agents managing customs filings for multiple clients who need fast, accurate, and repeatable HS classification with less manual effort',
      subsections: [
        { label: 'What they care about', items: ['Moving quickly across many client inputs', 'Defensible classifications with clear rationale', 'Handling variable data quality from different clients'] },
        { label: 'Primary modes', items: ['All three — Create, Expand, and Validate depending on the shape of the client input and stage of the filing'] },
      ],
      badge: 'Create · Expand · Validate',
    },
  ],
  note: "Not every segment uses every mode equally. Some will rely mostly on Expand on top of existing supplier prefixes; others lean on Create when starting from raw descriptions — depending on the quality of input data and where they sit in the workflow.",
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
  { mode: 'p0', modeLabel: 'Create', feature: 'Flexible input',          description: 'Accepts input from description, image, or product attributes — works with whatever data the user has.' },
  { mode: 'p0', modeLabel: 'Create', feature: 'Full 12-digit HS code',   description: 'Outputs a complete Saudi 12-digit HS code, not just a heading or chapter-level guess.' },
  { mode: 'p0', modeLabel: 'Create', feature: 'ZATCA-ready description', description: 'Generates a compliant product description alongside the code, structured to match ZATCA submission format so it flows downstream without reformatting.' },
  { mode: 'p0', modeLabel: 'Create', feature: 'Confidence & rationale',  description: 'Every result shows a confidence score and the reasoning behind the chosen classification.' },
  { mode: 'p1', modeLabel: 'Expand', feature: 'Prefix-constrained drill-down', description: 'Takes a partial HS code (4, 6, 8 or 10 digits) and drills down within that branch of the HS tree to find the precise 12-digit leaf.' },
  { mode: 'p1', modeLabel: 'Expand', feature: 'Description-driven refinement', description: 'Uses the product description to disambiguate and select the most specific code under the given prefix.' },
  { mode: 'p1', modeLabel: 'Expand', feature: 'Before & after comparison', description: 'Shows the original prefix next to the resolved 12-digit code with a clear explanation of what drove the narrowing.' },
  { mode: 'p2', modeLabel: 'Validate', feature: 'Code · description · value coherence check', description: 'Verifies that the declared HS code, product description, and customs value tell a consistent story before the declaration is submitted.' },
  { mode: 'p2', modeLabel: 'Validate', feature: 'Mismatch & implausible-value flags',         description: 'Surfaces specific mismatches (e.g. code says "leather", description says "synthetic") and value bands that are out of range for the chosen code.' },
  { mode: 'p2', modeLabel: 'Validate', feature: 'Pre-submission audit trail',                  description: 'Produces a per-shipment audit record showing what was checked, what was flagged, and the rationale — defensible against ZATCA queries.' },
  { mode: 'p2', modeLabel: 'Validate', feature: 'Suspicious-combination screening',            description: 'Catches code-description-value combinations that statistically pattern-match to historical rejections or reclassifications.' },
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
  create: [
    { category: 'Quality',    title: 'Accepted without correction',     target: 'Target → % of generated classifications accepted without manual correction', note: 'Measures whether Create output is trusted end-to-end, not just directionally useful.' },
    { category: 'Speed',      title: 'Time to first valid HS code',     target: 'Target → average time from input to first valid HS code output',             note: 'Covers latency plus any required input enrichment to reach a usable code.' },
    { category: 'Compliance', title: 'ZATCA-ready output rate',         target: 'Target → % of Create outputs formatted and structured for ZATCA without rework', note: 'Measures whether Create output flows straight into downstream submission.' },
  ],
  expand: [
    { category: 'Lift',       title: 'Improved over baseline',          target: 'Target → % of classifications improved compared to the input prefix',         note: 'Measures whether Expand is actually adding classification value beyond what the user had.' },
    { category: 'Efficiency', title: 'Reduction in manual reclassification', target: 'Target → time saved vs manual reclassification effort',                  note: "Tracks Expand's ability to replace slow, manual review cycles in large catalogs." },
    { category: 'Accuracy',   title: 'Accuracy uplift over existing prefixes', target: 'Target → measured uplift in classification accuracy vs the supplied prefix', note: 'Confirms that the resolved 12-digit codes are actually more correct, not just longer.' },
  ],
  validate: [
    { category: 'Catch rate', title: 'Issues caught pre-submission',    target: 'Target → % of mismatches and implausible values flagged before reaching Bayan', note: 'Measures whether Validate is actually preventing rejections, not just commenting on them.' },
    { category: 'Precision',  title: 'False-flag rate',                  target: 'Target → low % of flagged declarations that turn out to be correct',           note: 'A noisy validator gets switched off — precision is what keeps it in the workflow.' },
    { category: 'Outcome',    title: 'Reduction in ZATCA rejections',    target: 'Target → fewer rejected declarations on Validate-screened shipments vs unscreened baseline', note: 'The headline outcome — proves Validate moves the needle on real clearance failures.' },
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
  placeholder: 'Reserved for phased delivery plan across Create, Expand, and Validate.',
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
