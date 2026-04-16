import Layout, { PageHero } from '../components/Layout';
import {
  SectionLabel,
  SectionTitle,
  SectionDesc,
  Divider,
  Callout,
  PersonaCard,
  MetricCard,
  FeatureTable,
  EmptyPlaceholder,
  SubHeading,
  PageNav,
  Reveal,
} from '../components/ui';

// ── Feature table data ────────────────────────────────────
const FEATURES = [
  { mode: 'p0' as const, modeLabel: 'Generate', feature: 'Flexible input',          description: 'Accepts input from description, image, or product attributes — works with whatever data the user has.' },
  { mode: 'p0' as const, modeLabel: 'Generate', feature: 'Full 12-digit HS code',   description: 'Outputs a complete Saudi 12-digit HS code, not just a heading or chapter-level guess.' },
  { mode: 'p0' as const, modeLabel: 'Generate', feature: 'ZATCA-ready description', description: 'Generates a compliant product description alongside the code, structured to match ZATCA submission format so it flows downstream without reformatting.' },
  { mode: 'p0' as const, modeLabel: 'Generate', feature: 'Confidence & rationale',  description: 'Every result shows a confidence score and the reasoning behind the chosen classification.' },
  { mode: 'p1' as const, modeLabel: 'Boost',    feature: 'Review existing codes',   description: 'Takes existing or partial HS codes as input and evaluates whether they are appropriate.' },
  { mode: 'p1' as const, modeLabel: 'Boost',    feature: 'Suggest better alternatives', description: 'Recommends a more accurate classification when the current code is close but not optimal.' },
  { mode: 'p1' as const, modeLabel: 'Boost',    feature: 'Current vs recommended',  description: 'Shows current code next to the recommended code so the user can compare and decide.' },
  { mode: 'p2' as const, modeLabel: 'Validate', feature: 'Consistency check',       description: 'Verifies that HS code, description, and declared value are internally consistent before submission.' },
  { mode: 'p2' as const, modeLabel: 'Validate', feature: 'Mismatch flagging',       description: 'Flags suspicious mismatches that are likely to be rejected or trigger manual customs review.' },
  { mode: 'p2' as const, modeLabel: 'Validate', feature: 'Unlikely combinations',   description: 'Detects unlikely combinations, such as premium brands declared at unusually low values.' },
  { mode: 'p2' as const, modeLabel: 'Validate', feature: 'Risk level & reason',     description: 'Every flag includes a risk level and a human-readable reason so reviewers can act quickly.' },
];

// ── Metrics data ──────────────────────────────────────────
const METRICS = {
  generate: [
    { category: 'Quality',    title: 'Accepted without correction',     target: 'Target → % of generated classifications accepted without manual correction', note: 'Measures whether Generate output is trusted end-to-end, not just directionally useful.' },
    { category: 'Speed',      title: 'Time to first valid HS code',     target: 'Target → average time from input to first valid HS code output',             note: 'Covers latency plus any required input enrichment to reach a usable code.' },
    { category: 'Compliance', title: 'ZATCA-ready output rate',         target: 'Target → % of Generate outputs formatted and structured for ZATCA without rework', note: 'Measures whether Generate output flows straight into downstream submission.' },
  ],
  boost: [
    { category: 'Lift',       title: 'Improved over baseline',          target: 'Target → % of classifications improved compared to the input code',           note: 'Measures whether Boost is actually adding classification value beyond what the user had.' },
    { category: 'Efficiency', title: 'Reduction in manual reclassification', target: 'Target → time saved vs manual reclassification effort',                  note: 'Tracks Boost\'s ability to replace slow, manual review cycles in large catalogs.' },
    { category: 'Accuracy',   title: 'Accuracy uplift over existing codes', target: 'Target → measured uplift in classification accuracy vs existing codes',    note: 'Validates that "improved" codes are actually more correct, not just different.' },
  ],
  validate: [
    { category: 'Detection',  title: 'Invalid entries flagged',         target: 'Target → % of invalid or suspicious entries flagged before submission',        note: 'Measures whether Validate catches the problems it is supposed to catch.' },
    { category: 'Outcome',    title: 'Reduction in clearance issues',   target: 'Target → drop in clearance issues caused by inconsistent data',               note: 'Links Validate output directly to real ZATCA clearance outcomes.' },
    { category: 'Workflow',   title: 'Review resolution time',          target: 'Target → median time to resolve flagged items in the review queue',            note: 'Tracks whether flags are actionable and reviewable at operational speed.' },
  ],
  overall: [
    { category: 'Clearance',  title: 'Faster customs clearance cycles', target: 'Target → shorter end-to-end clearance cycle time',                            note: 'The product\'s headline outcome — the reason customers care.' },
    { category: 'Compliance', title: 'Lower compliance error rate',     target: 'Target → fewer ZATCA rejections, reclassifications, and penalties',            note: 'Tracks risk reduction across the full classification workflow.' },
    { category: 'Consistency',title: 'Higher classification consistency',target: 'Target → lower variance in classifications across teams and clients',           note: 'Proves the product is scaling a consistent classification practice, not just helping individuals.' },
  ],
};

export default function ProductDefinition() {
  return (
    <Layout chapter="Chapter 01 · Business" pageTitle="Product Definition">
      <PageHero
        kicker="Chapter 01 · Business"
        title={<>An intelligent platform <em className="not-italic text-accent">for customs clearance</em></>}
        lede="An intelligent platform that improves accuracy before clearance, reduces manual effort, and supports faster, more consistent customs processing. It helps teams work with greater confidence, lower the risk of errors, and move shipments through the clearance process more smoothly."
      />

      {/* ── 1. Problem ── */}
      <section id="problem" className="px-4 sm:px-8 lg:px-12 py-10 sm:py-14">
        <div className="max-w-[1160px] mx-auto">
          <SectionLabel num="1">Problem Statement</SectionLabel>
          <SectionTitle>Why this needs to exist</SectionTitle>
          <SectionDesc>
            Businesses lose time and face compliance risk because product classification is manual, inconsistent,
            and often incomplete before customs submission. Existing tools are often siloed by carrier, shipper,
            or workflow, making it difficult to manage classification consistently across the business.
          </SectionDesc>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[
              { label: 'Issue 01', title: 'Slow clearance',          body: 'Manual review and back-and-forth between shippers, agents, and customs holds shipments at the border. Every vague description or missing field triggers another round trip.' },
              { label: 'Issue 02', title: 'Higher compliance risk',   body: 'Inaccurate or incomplete HS code data exposes businesses to penalties, reclassification, and rejected declarations — with costs that compound across shipments.' },
              { label: 'Issue 03', title: 'Fragmented workflows',     body: 'Classification tools are siloed by carrier, shipper, or workflow. Teams can\'t scale a consistent classification practice across clients, channels, and business units.' },
            ].map((card, i) => (
              <Reveal key={card.label} delay={i * 100}>
                <div className="bg-card border border-border rounded-[13px] p-6 transition-[border-color] duration-300 hover:border-accent h-full">
                  <div className="font-mono text-[.72rem] text-muted tracking-[.14em] uppercase mb-2">{card.label}</div>
                  <div className="font-sans text-[.95rem] font-semibold text-text mb-2">{card.title}</div>
                  <p className="text-[.9rem] text-muted leading-[1.7]">{card.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <Divider />

      {/* ── 2. Solution Overview ── */}
      <section id="solution" className="px-4 sm:px-8 lg:px-12 py-10 sm:py-14">
        <div className="max-w-[1160px] mx-auto">
          <SectionLabel num="2">Solution Overview</SectionLabel>
          <SectionTitle>An AI platform for <em className="not-italic text-accent">faster ZATCA clearance</em></SectionTitle>
          <SectionDesc>
            Clear AI helps businesses pass ZATCA clearance faster by generating, improving, and validating HS code
            data before submission. It solves the classification workflow in three ways — <strong>create</strong> compliant
            classifications from scratch, <strong>improve</strong> classifications that are close but not optimal, and{' '}
            <strong>check</strong> whether code, description, and value make sense together before filing.
          </SectionDesc>

          <SubHeading>Three product modes</SubHeading>
          <Reveal>
            <p className="text-muted text-[.98rem] leading-[1.8] mb-6 max-w-[680px]">
              The product works in three modes depending on the quality of the input data and the stage of the workflow.
              This keeps it modular and practical rather than one-size-fits-all — users engage with the mode that matches
              what they have in hand.
            </p>
          </Reveal>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <PersonaCard
              num="Mode 01 · Create"
              name="Generate"
              role="Use when there is no usable classification. The system creates a ZATCA-ready HS code and compliant description from product data."
              subsections={[{
                label: 'When to use',
                items: [
                  'New SKUs with only a product name or short description',
                  'Sparse catalog data from suppliers or marketplaces',
                  'First-time classification for a client or product line',
                ],
              }]}
              badge={{ label: 'From scratch', color: 'muted' }}
              delay={0}
            />
            <PersonaCard
              num="Mode 02 · Improve"
              name="Boost"
              role="Use when a code already exists but could be more accurate. The system suggests a better classification and improves over time through AI learning."
              subsections={[{
                label: 'When to use',
                items: [
                  'Supplier-provided codes that look approximate',
                  'Legacy catalogs needing refinement at scale',
                  'Reclassification after ruling or regulation changes',
                ],
              }]}
              badge={{ label: 'Improve existing', color: 'accent' }}
              delay={100}
            />
            <PersonaCard
              num="Mode 03 · Check"
              name="Validate"
              role="Use when the code must be checked before submission. The system verifies whether HS code, description, and declared value are consistent and flags mismatches."
              subsections={[{
                label: 'When to use',
                items: [
                  'Final pre-submission check before Bayan',
                  'Screening declarations for suspicious combinations',
                  'Audit trail of why a classification was accepted',
                ],
              }]}
              badge={{ label: 'Pre-submission check', color: 'muted' }}
              delay={200}
            />
          </div>
        </div>
      </section>

      <Divider />

      {/* ── 3. Target Customer ── */}
      <section id="target-market" className="px-4 sm:px-8 lg:px-12 py-10 sm:py-14">
        <div className="max-w-[1160px] mx-auto">
          <SectionLabel num="3">Target Customer</SectionLabel>
          <SectionTitle>Who we serve</SectionTitle>
          <SectionDesc>
            The product serves three segments across the customs value chain. Each has a different operating model,
            a different urgency, and a different mix of product modes — so packaging and go-to-market adapt to the
            segment while the backend stays shared.
          </SectionDesc>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <PersonaCard
              num="Segment A"
              name="Supply chain & logistics companies"
              role="Teams handling high shipment volumes that need faster, more consistent classification and customs documentation across many orders"
              subsections={[
                { label: 'What they care about', items: ['Operational efficiency and repeatability at scale', 'Visibility across shipments and teams', 'Keeping unit cost flat as shipment volume grows'] },
                { label: 'Primary modes', items: ['Boost — refine partial or supplier-provided codes', 'Validate — catch mismatches before Bayan submission'] },
              ]}
              badge={{ label: 'Boost · Validate', color: 'muted' }}
              delay={0}
            />
            <PersonaCard
              num="Segment B"
              name="Ecommerce businesses"
              role="Businesses shipping cross-border into KSA that need scalable classification at checkout or order processing to reduce clearance delays"
              subsections={[
                { label: 'What they care about', items: ['Automation at scale across large catalogs', 'Product data that is customs-ready from day one', 'Fewer clearance surprises for the end customer'] },
                { label: 'Primary modes', items: ['Generate — create classifications from sparse product data', 'Boost — improve existing catalog codes over time'] },
              ]}
              badge={{ label: 'Generate · Boost', color: 'muted' }}
              delay={100}
            />
            <PersonaCard
              num="Segment C"
              name="Independent clearance agents"
              role="Agents managing customs filings for multiple clients who need fast, accurate, and repeatable HS classification with less manual effort"
              subsections={[
                { label: 'What they care about', items: ['Moving quickly across many client inputs', 'Defensible classifications with clear rationale', 'Handling variable data quality from different clients'] },
                { label: 'Primary modes', items: ['All three — Generate, Boost, Validate depending on client data'] },
              ]}
              badge={{ label: 'Generate · Boost · Validate', color: 'accent' }}
              delay={200}
            />
          </div>

          <Reveal delay={300} className="mt-8">
            <Callout variant="note" icon="🧭">
              <strong style={{ color: '#6d28d9' }}>Note:</strong> Not every segment uses every mode equally.
              Some will rely mostly on Validate, others on Generate and Boost — depending on the quality of input
              data and where they sit in the workflow.
            </Callout>
          </Reveal>
        </div>
      </section>

      <Divider />

      {/* ── 4. Features ── */}
      <section id="features" className="px-4 sm:px-8 lg:px-12 py-10 sm:py-14">
        <div className="max-w-[1160px] mx-auto">
          <SectionLabel num="4">Features by Mode</SectionLabel>
          <SectionTitle>What each mode does</SectionTitle>
          <SectionDesc>
            Features are organised by product mode so it is clear what each mode delivers on its own. This structure
            can be expanded into detailed requirements per mode when we move into build planning.
          </SectionDesc>
          <FeatureTable rows={FEATURES} />
        </div>
      </section>

      <Divider />

      {/* ── 5. Metrics ── */}
      <section id="metrics" className="px-4 sm:px-8 lg:px-12 py-10 sm:py-14">
        <div className="max-w-[1160px] mx-auto">
          <SectionLabel num="5">Success Metrics by Mode</SectionLabel>
          <SectionTitle>How we know it's working</SectionTitle>
          <SectionDesc>
            Each product mode is measured against a small set of focused metrics, plus three overall product metrics
            that track business outcome.
          </SectionDesc>

          <SubHeading>Generate</SubHeading>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
            {METRICS.generate.map((m, i) => <MetricCard key={m.title} {...m} delay={i * 100} />)}
          </div>

          <SubHeading>Boost</SubHeading>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
            {METRICS.boost.map((m, i) => <MetricCard key={m.title} {...m} delay={i * 100} />)}
          </div>

          <SubHeading>Validate</SubHeading>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
            {METRICS.validate.map((m, i) => <MetricCard key={m.title} {...m} delay={i * 100} />)}
          </div>

          <SubHeading>Overall product success</SubHeading>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {METRICS.overall.map((m, i) => <MetricCard key={m.title} {...m} delay={i * 100} />)}
          </div>
        </div>
      </section>

      <Divider />

      {/* ── 6. Roadmap ── */}
      <section id="roadmap" className="px-4 sm:px-8 lg:px-12 py-10 sm:py-14">
        <div className="max-w-[1160px] mx-auto">
          <SectionLabel num="6">Roadmap</SectionLabel>
          <SectionTitle>What ships, when</SectionTitle>
          <EmptyPlaceholder>Reserved for phased delivery plan across Generate, Boost, and Validate.</EmptyPlaceholder>
        </div>
      </section>

      <Divider />

      {/* ── 7. Open Questions ── */}
      <section id="clear-openq" className="px-4 sm:px-8 lg:px-12 py-10 sm:py-14">
        <div className="max-w-[1160px] mx-auto">
          <SectionLabel num="7">Open Questions</SectionLabel>
          <SectionTitle>Open question parking lot</SectionTitle>
          <EmptyPlaceholder>Reserved for unresolved product, commercial, and operational questions.</EmptyPlaceholder>
        </div>
      </section>

      <div className="px-4 sm:px-8 lg:px-12">
        <PageNav
          next={{ to: '/process', label: 'Current Naqel Process' }}
        />
      </div>
    </Layout>
  );
}
