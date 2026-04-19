import Layout, { PageHero } from '../components/Layout';
import {
  SectionLabel,
  SectionTitle,
  SectionDesc,
  VerticalTabs,
  PageNav,
  Reveal,
} from '../components/ui';
import { PAGE, SYSTEM_ARCH, ALGORITHM, DEPLOYMENT, V2, NAV } from '../content/architecture';

// ── Rationale block ───────────────────────────────────────
function RationaleBlock({
  title,
  intro,
  points,
}: {
  title: string;
  intro?: string;
  points: { heading: string; body: string; code?: string }[];
}) {
  return (
    <Reveal>
      <div className="bg-card border border-border rounded-[14px] px-5 sm:px-8 lg:px-10 py-6 sm:py-8 leading-[1.8] text-text">
        <h4 className="font-display text-[1.05rem] font-normal text-accent mb-3">{title}</h4>
        {intro && <p className="text-[.9rem] text-muted leading-[1.8] mb-1">{intro}</p>}
        {points.map((p, i) => (
          <div key={i} className="mt-5">
            <strong className="text-accent block mb-1 text-[.92rem]">{i + 1}. {p.heading}</strong>
            <p className="text-[.9rem] text-muted leading-[1.8]">
              {p.body}
              {p.code && (
                <code className="inline-block font-mono text-[.82rem] bg-surface border border-border rounded px-1.5 py-0.5 text-green ml-1">
                  {p.code}
                </code>
              )}
            </p>
          </div>
        ))}
      </div>
    </Reveal>
  );
}

// ── V1 content ────────────────────────────────────────────
function V1Panel() {
  return (
    <div>
      {/* A — Algorithm */}
      <div className="mb-14">
        <SectionLabel num={ALGORITHM.sectionLabel}>{ALGORITHM.sectionName}</SectionLabel>
        <Reveal>
          <h3 className="font-display font-normal text-text mb-3" style={{ fontSize: 'clamp(1.4rem,2.2vw,1.8rem)' }}>
            {ALGORITHM.title}
          </h3>
        </Reveal>
        <SectionDesc>{ALGORITHM.desc}</SectionDesc>

        <Reveal className="my-8 border border-border rounded-[14px] overflow-hidden bg-card">
          <img
            src={ALGORITHM.diagram}
            alt={ALGORITHM.diagramAlt}
            className="w-full block"
          />
        </Reveal>

        <div id="algo-rationale">
          <RationaleBlock
            title={ALGORITHM.rationale.title}
            intro={ALGORITHM.rationale.intro}
            points={ALGORITHM.rationale.points}
          />
        </div>
      </div>

      <div className="h-px bg-border my-12" />

      {/* B — Deployment */}
      <div id="deploy-rationale">
        <SectionLabel num={DEPLOYMENT.sectionLabel}>{DEPLOYMENT.sectionName}</SectionLabel>
        <Reveal>
          <h3 className="font-display font-normal text-text mb-3" style={{ fontSize: 'clamp(1.4rem,2.2vw,1.8rem)' }}>
            {DEPLOYMENT.title}
          </h3>
        </Reveal>
        <SectionDesc>{DEPLOYMENT.desc}</SectionDesc>

        <Reveal className="my-8 border border-border rounded-[14px] overflow-hidden bg-card">
          <img
            src={DEPLOYMENT.diagram}
            alt={DEPLOYMENT.diagramAlt}
            className="w-full block"
          />
        </Reveal>

        <RationaleBlock
          title={DEPLOYMENT.rationale.title}
          intro={DEPLOYMENT.rationale.intro}
          points={DEPLOYMENT.rationale.points}
        />
      </div>
    </div>
  );
}

// ── V2 placeholder ────────────────────────────────────────
function V2Panel() {
  return (
    <div
      className="rounded-2xl p-6 sm:p-12 text-center"
      style={{ background: 'linear-gradient(135deg, rgba(167,139,250,.05), rgba(96,165,250,.04))', border: '1px dashed rgba(109,40,217,.3)' }}
    >
      <span
        className="inline-block font-mono text-[.62rem] text-purple px-[.7rem] py-[.25rem] rounded mb-4 tracking-[.14em] uppercase"
        style={{ background: 'rgba(167,139,250,.1)', border: '1px solid rgba(167,139,250,.3)' }}
      >
        Coming next
      </span>
      <h3 className="font-display font-normal text-[1.6rem] text-text mb-3">{V2.title}</h3>
      <p className="text-muted max-w-[620px] mx-auto leading-[1.75] text-[.9rem] mb-8">
        {V2.desc}
      </p>
      <div className="grid gap-4 max-w-[820px] mx-auto text-left" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
        {V2.plannedItems.map((item) => (
          <div key={item} className="bg-card border border-border rounded-[10px] px-5 py-4">
            <h4 className="font-mono text-[.6rem] text-purple tracking-[.12em] uppercase mb-1">Planned</h4>
            <p className="text-[.78rem] text-muted leading-[1.6]">{item}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────
export default function Architecture() {
  return (
    <Layout chapter={PAGE.chapter} pageTitle={PAGE.pageTitle}>
      <PageHero
        kicker={PAGE.hero.kicker}
        title={<>Technical <em className="not-italic text-accent">{PAGE.hero.titleAccent}</em></>}
        lede={PAGE.hero.lede}
      />

      <section id="v1-panel" className="px-4 sm:px-8 lg:px-12 py-10 sm:py-14">
        <div className="max-w-[1160px] mx-auto">
          <SectionLabel num={SYSTEM_ARCH.num}>{SYSTEM_ARCH.label}</SectionLabel>
          <SectionTitle>{SYSTEM_ARCH.title}</SectionTitle>
          <SectionDesc>{SYSTEM_ARCH.desc}</SectionDesc>

          <VerticalTabs
            tabs={[
              { id: 'v1', label: 'V1 — Current', content: <V1Panel /> },
              { id: 'v2', label: 'V2 — Planned',  content: <V2Panel /> },
            ]}
          />
        </div>
      </section>

      <div className="px-4 sm:px-8 lg:px-12">
        <PageNav
          prev={NAV.prev}
          next={NAV.next}
        />
      </div>
    </Layout>
  );
}
