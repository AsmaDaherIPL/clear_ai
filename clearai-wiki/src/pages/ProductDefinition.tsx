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
import {
  PAGE, PROBLEM, SOLUTION, TARGET_CUSTOMER, FEATURES_SECTION, FEATURES,
  METRICS_SECTION, METRICS, ROADMAP, OPEN_QUESTIONS, NAV,
} from '../content/product-definition';

export default function ProductDefinition() {
  return (
    <Layout chapter={PAGE.chapter} pageTitle={PAGE.pageTitle}>
      <PageHero
        kicker={PAGE.hero.kicker}
        title={<>An intelligent platform <em className="not-italic text-accent">{PAGE.hero.titleAccent}</em></>}
        lede={PAGE.hero.lede}
      />

      {/* ── 1. Problem ── */}
      <section id="problem" className="px-4 sm:px-8 lg:px-12 py-10 sm:py-14">
        <div className="max-w-[1160px] mx-auto">
          <SectionLabel num={PROBLEM.num}>{PROBLEM.label}</SectionLabel>
          <SectionTitle>{PROBLEM.title}</SectionTitle>
          <SectionDesc>{PROBLEM.desc}</SectionDesc>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {PROBLEM.issues.map((card, i) => (
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
          <SectionLabel num={SOLUTION.num}>{SOLUTION.label}</SectionLabel>
          <SectionTitle>An AI platform for <em className="not-italic text-accent">{SOLUTION.titleAccent}</em></SectionTitle>
          <SectionDesc>
            Clear AI helps businesses pass ZATCA clearance faster by generating, improving, and validating HS code
            data before submission. It solves the classification workflow in three ways — <strong>create</strong> compliant
            classifications from scratch, <strong>improve</strong> classifications that are close but not optimal, and{' '}
            <strong>check</strong> whether code, description, and value make sense together before filing.
          </SectionDesc>

          <SubHeading>Three product modes</SubHeading>
          <Reveal>
            <p className="text-muted text-[.98rem] leading-[1.8] mb-6 max-w-[680px]">
              {SOLUTION.modesIntro}
            </p>
          </Reveal>

          {/* Modes diagram */}
          <Reveal className="mb-12">
            <img
              src="/diagrams/MODES.svg"
              alt="Three product modes: Generate, Boost, Validate"
              className="w-full max-w-[800px] mx-auto"
            />
          </Reveal>

          {/* Three-card layout */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {SOLUTION.modes.map((mode, i) => {
              const modeColors = [
                { bg: '#FDEFE5',                      border: '#FBE3D1',                      accent: '#EA6A1F', glow: 'rgba(234,106,31,.18)' }, // orange-1 (bright)
                { bg: 'rgba(148,66,28,.05)',          border: 'rgba(148,66,28,.20)',          accent: '#94421C', glow: 'rgba(148,66,28,.18)' }, // orange-2 (deep)
                { bg: '#E6F1EC',                      border: 'rgba(46,125,87,.25)',          accent: '#2E7D57', glow: 'rgba(46,125,87,.18)' }, // green ok
              ];
              const color = modeColors[i];

              return (
                <Reveal key={mode.name} delay={i * 100}>
                  <div
                    className="rounded-[16px] p-6 border transition-all duration-500 h-full flex flex-col group cursor-default"
                    style={{
                      background: color.bg,
                      borderColor: color.border,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.boxShadow = `0 0 24px ${color.glow}`;
                      e.currentTarget.style.borderColor = color.accent;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.boxShadow = 'none';
                      e.currentTarget.style.borderColor = color.border;
                    }}
                  >
                    {/* Mode header */}
                    <div className="mb-4">
                      <div className="font-mono text-[.65rem] uppercase tracking-[.12em] mb-1 transition-colors duration-300" style={{ color: color.accent }}>
                        {mode.num}
                      </div>
                      <h3 className="text-[1.1rem] font-semibold text-text">{mode.name}</h3>
                    </div>

                    {/* Badge with animated background */}
                    <div className="mb-4">
                      <span
                        className="inline-block font-mono text-[.6rem] uppercase tracking-[.08em] px-2.5 py-1 rounded-md transition-all duration-300 group-hover:shadow-md"
                        style={{ background: color.accent, color: 'white' }}
                      >
                        {mode.badge}
                      </span>
                    </div>

                    {/* Role description */}
                    <p className="text-[.9rem] text-muted leading-[1.6] mb-5 flex-grow">
                      {mode.role}
                    </p>

                    {/* When to use */}
                    <div>
                      <div className="font-mono text-[.65rem] uppercase tracking-[.1em] text-dim mb-3">When to use</div>
                      <ul className="space-y-2">
                        {mode.whenToUse.map((item, idx) => (
                          <li key={idx} className="text-[.82rem] text-text leading-[1.5] flex gap-2 transition-transform duration-300 group-hover:translate-x-1">
                            <span className="shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full transition-all duration-300 group-hover:scale-125" style={{ background: color.accent }} />
                            <span>{item}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </Reveal>
              );
            })}
          </div>
        </div>
      </section>

      <Divider />

      {/* ── 3. Target Customer ── */}
      <section id="target-market" className="px-4 sm:px-8 lg:px-12 py-10 sm:py-14">
        <div className="max-w-[1160px] mx-auto">
          <SectionLabel num={TARGET_CUSTOMER.num}>{TARGET_CUSTOMER.label}</SectionLabel>
          <SectionTitle>{TARGET_CUSTOMER.title}</SectionTitle>
          <SectionDesc>{TARGET_CUSTOMER.desc}</SectionDesc>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {TARGET_CUSTOMER.segments.map((seg, i) => (
              <PersonaCard
                key={seg.name}
                num={seg.num}
                name={seg.name}
                role={seg.role}
                subsections={seg.subsections}
                badge={{ label: seg.badge, color: i === 2 ? 'accent' : 'muted' }}
                delay={i * 100}
              />
            ))}
          </div>

          <Reveal delay={300} className="mt-8">
            <Callout variant="note" icon="🧭">
              <strong style={{ color: '#94421C' }}>Note:</strong> {TARGET_CUSTOMER.note}
            </Callout>
          </Reveal>
        </div>
      </section>

      <Divider />

      {/* ── 4. Features ── */}
      <section id="features" className="px-4 sm:px-8 lg:px-12 py-10 sm:py-14">
        <div className="max-w-[1160px] mx-auto">
          <SectionLabel num={FEATURES_SECTION.num}>{FEATURES_SECTION.label}</SectionLabel>
          <SectionTitle>{FEATURES_SECTION.title}</SectionTitle>
          <SectionDesc>{FEATURES_SECTION.desc}</SectionDesc>
          <FeatureTable rows={FEATURES} />
        </div>
      </section>

      <Divider />

      {/* ── 5. Metrics ── */}
      <section id="metrics" className="px-4 sm:px-8 lg:px-12 py-10 sm:py-14">
        <div className="max-w-[1160px] mx-auto">
          <SectionLabel num={METRICS_SECTION.num}>{METRICS_SECTION.label}</SectionLabel>
          <SectionTitle>{METRICS_SECTION.title}</SectionTitle>
          <SectionDesc>{METRICS_SECTION.desc}</SectionDesc>

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
          <SectionLabel num={ROADMAP.num}>{ROADMAP.label}</SectionLabel>
          <SectionTitle>{ROADMAP.title}</SectionTitle>
          <EmptyPlaceholder>{ROADMAP.placeholder}</EmptyPlaceholder>
        </div>
      </section>

      <Divider />

      {/* ── 7. Open Questions ── */}
      <section id="clear-openq" className="px-4 sm:px-8 lg:px-12 py-10 sm:py-14">
        <div className="max-w-[1160px] mx-auto">
          <SectionLabel num={OPEN_QUESTIONS.num}>{OPEN_QUESTIONS.label}</SectionLabel>
          <SectionTitle>{OPEN_QUESTIONS.title}</SectionTitle>
          <EmptyPlaceholder>{OPEN_QUESTIONS.placeholder}</EmptyPlaceholder>
        </div>
      </section>

      <div className="px-4 sm:px-8 lg:px-12">
        <PageNav next={NAV.next} />
      </div>
    </Layout>
  );
}
