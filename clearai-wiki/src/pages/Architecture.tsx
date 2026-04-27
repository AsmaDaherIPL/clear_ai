import Layout, { PageHero } from '../components/Layout';
import {
  SectionLabel,
  SectionTitle,
  SectionDesc,
  SubHeading,
  VerticalTabs,
  PageNav,
  Reveal,
  Badge,
} from '../components/ui';
import {
  PAGE,
  SYSTEM_ARCH,
  TECH_STACK,
  DEPLOYMENT,
  CONTRACT,
  FLOW,
  DATA_MODEL,
  FAILURE,
  FRONTEND,
  V2,
  NAV,
} from '../content/architecture';

// ── Small primitives shared inside V1 panel ──────────────

function Card({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Reveal>
      <div
        className={`bg-card border border-border rounded-[14px] px-5 sm:px-7 lg:px-9 py-6 sm:py-7 ${className}`}
      >
        {children}
      </div>
    </Reveal>
  );
}

function StackTable({
  rows,
  cols,
}: {
  rows: Record<string, string>[];
  cols: { key: string; label: string; widthClass: string }[];
}) {
  return (
    <Reveal>
      {/* Mobile — stacked */}
      <div className="md:hidden flex flex-col gap-3">
        {rows.map((row, i) => (
          <div key={i} className="bg-card border border-border rounded-xl p-4">
            {cols.map((c) => (
              <div key={c.key} className="mb-2 last:mb-0">
                <span className="font-mono text-[.6rem] text-muted tracking-[.14em] uppercase block mb-0.5">
                  {c.label}
                </span>
                <span className="text-[.86rem] text-text leading-[1.6]">{row[c.key]}</span>
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* Desktop — table */}
      <div className="hidden md:block border border-border rounded-2xl overflow-hidden bg-card">
        <div
          className="grid border-b border-border"
          style={{ gridTemplateColumns: cols.map((c) => c.widthClass).join(' ') }}
        >
          {cols.map((c) => (
            <div key={c.key} className="px-5 py-3 border-r border-border last:border-r-0">
              <span className="font-mono text-[.6rem] text-muted tracking-[.14em] uppercase">
                {c.label}
              </span>
            </div>
          ))}
        </div>
        {rows.map((row, i) => (
          <div
            key={i}
            className="grid border-b border-border last:border-b-0 transition-colors duration-150 hover:bg-surface"
            style={{ gridTemplateColumns: cols.map((c) => c.widthClass).join(' ') }}
          >
            {cols.map((c) => (
              <div key={c.key} className="px-5 py-[0.95rem] border-r border-border last:border-r-0">
                <span className="text-[.84rem] text-text leading-[1.65]">{row[c.key]}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Reveal>
  );
}

function StepList({
  steps,
}: {
  steps: { step: string; name: string; where: string; detail: string }[];
}) {
  return (
    <ol className="flex flex-col gap-3">
      {steps.map((s) => (
        <Reveal key={s.step}>
          <li className="bg-card border border-border rounded-[12px] px-5 py-4 flex gap-4 items-start">
            <span
              className="font-mono text-[.7rem] text-white px-[.5rem] py-[.18rem] rounded shrink-0 mt-0.5 tracking-[.06em]"
              style={{ background: 'linear-gradient(135deg, #EA6A1F 0%, #94421C 100%)' }}
            >
              {s.step}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-1.5">
                <span className="font-sans text-[.95rem] font-semibold text-text">{s.name}</span>
                <code className="font-mono text-[.72rem] text-muted bg-surface border border-border rounded px-[.45rem] py-[.1rem]">
                  {s.where}
                </code>
              </div>
              <p className="text-[.85rem] text-muted leading-[1.7]">{s.detail}</p>
            </div>
          </li>
        </Reveal>
      ))}
    </ol>
  );
}

function EnumBlock({
  name,
  values,
}: {
  name: string;
  values: { v: string; desc: string }[];
}) {
  return (
    <Reveal>
      <div className="bg-card border border-border rounded-[12px] px-5 py-5">
        <div className="font-mono text-[.74rem] text-accent tracking-[.1em] uppercase mb-3">
          {name}
        </div>
        <ul className="flex flex-col gap-2">
          {values.map((row, i) => (
            <li key={i} className="text-[.86rem] leading-[1.6]">
              <code className="font-mono text-[.78rem] bg-surface border border-border rounded px-[.45rem] py-[.1rem] text-green mr-2">
                {row.v}
              </code>
              <span className="text-muted">{row.desc}</span>
            </li>
          ))}
        </ul>
      </div>
    </Reveal>
  );
}

function EndpointCard({
  method,
  path,
  input,
  output,
  llm,
}: {
  method: string;
  path: string;
  input: string;
  output: string;
  llm: string;
}) {
  return (
    <Reveal>
      <div className="bg-card border border-border rounded-[12px] px-5 py-5">
        <div className="flex items-center gap-3 mb-3">
          <Badge color="accent">{method}</Badge>
          <code className="font-mono text-[.86rem] text-text">{path}</code>
        </div>
        <dl className="grid gap-2 text-[.84rem]">
          <div>
            <dt className="font-mono text-[.66rem] text-muted tracking-[.12em] uppercase mb-0.5">
              Body
            </dt>
            <dd className="text-text leading-[1.6]">
              <code className="font-mono text-[.78rem] bg-surface border border-border rounded px-[.4rem] py-[.05rem]">
                {input}
              </code>
            </dd>
          </div>
          <div>
            <dt className="font-mono text-[.66rem] text-muted tracking-[.12em] uppercase mb-0.5">
              Returns
            </dt>
            <dd className="text-muted leading-[1.6]">{output}</dd>
          </div>
          <div>
            <dt className="font-mono text-[.66rem] text-muted tracking-[.12em] uppercase mb-0.5">
              LLM
            </dt>
            <dd className="text-muted leading-[1.6]">{llm}</dd>
          </div>
        </dl>
      </div>
    </Reveal>
  );
}

function TableCard({
  name,
  kind,
  cols,
  indexes,
  seeds,
}: {
  name: string;
  kind: string;
  cols: string[];
  indexes: string[];
  seeds?: string;
}) {
  return (
    <Reveal>
      <div className="bg-card border border-border rounded-[12px] px-5 py-5 h-full">
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <code className="font-mono text-[.92rem] text-accent">{name}</code>
          <Badge color="muted">{kind}</Badge>
        </div>
        <div className="font-mono text-[.62rem] text-muted tracking-[.14em] uppercase mb-1.5">
          Columns
        </div>
        <ul className="flex flex-col gap-1 mb-4">
          {cols.map((c, i) => (
            <li
              key={i}
              className="font-mono text-[.74rem] text-text leading-[1.55] bg-surface border border-border rounded px-[.5rem] py-[.18rem]"
            >
              {c}
            </li>
          ))}
        </ul>
        <div className="font-mono text-[.62rem] text-muted tracking-[.14em] uppercase mb-1.5">
          Indexes
        </div>
        <ul className="flex flex-col gap-1.5 mb-1">
          {indexes.map((c, i) => (
            <li key={i} className="text-[.8rem] text-muted leading-[1.55] flex gap-2">
              <span className="font-mono text-[.72rem] text-accent shrink-0">—</span>
              <span>{c}</span>
            </li>
          ))}
        </ul>
        {seeds && (
          <>
            <div className="font-mono text-[.62rem] text-muted tracking-[.14em] uppercase mt-3 mb-1.5">
              Seeded keys
            </div>
            <p className="font-mono text-[.74rem] text-muted leading-[1.55]">{seeds}</p>
          </>
        )}
      </div>
    </Reveal>
  );
}

// ─── V1 panel ─────────────────────────────────────────────

function V1Panel() {
  return (
    <div className="flex flex-col gap-16">
      {/* A — Tech Stack */}
      <section>
        <SectionLabel num={TECH_STACK.sectionLabel}>{TECH_STACK.sectionName}</SectionLabel>
        <Reveal>
          <h3
            className="font-display font-normal text-text mb-3"
            style={{ fontSize: 'clamp(1.4rem,2.2vw,1.8rem)' }}
          >
            {TECH_STACK.title}
          </h3>
        </Reveal>
        <SectionDesc>{TECH_STACK.desc}</SectionDesc>
        <StackTable
          rows={TECH_STACK.rows as unknown as Record<string, string>[]}
          cols={[
            { key: 'layer',  label: 'Layer',  widthClass: '1.1fr' },
            { key: 'choice', label: 'Choice', widthClass: '2.4fr' },
            { key: 'why',    label: 'Why',    widthClass: '3.5fr' },
          ]}
        />
      </section>

      <div className="h-px bg-border" />

      {/* B — Deployment */}
      <section>
        <SectionLabel num={DEPLOYMENT.sectionLabel}>{DEPLOYMENT.sectionName}</SectionLabel>
        <Reveal>
          <h3
            className="font-display font-normal text-text mb-3"
            style={{ fontSize: 'clamp(1.4rem,2.2vw,1.8rem)' }}
          >
            {DEPLOYMENT.title}
          </h3>
        </Reveal>
        <SectionDesc>{DEPLOYMENT.desc}</SectionDesc>

        <SubHeading>Provisioned resources</SubHeading>
        <div className="grid gap-3 sm:grid-cols-2 mb-8">
          {DEPLOYMENT.resources.map((r) => (
            <Reveal key={r.name}>
              <div className="bg-card border border-border rounded-[12px] px-5 py-4">
                <div className="font-sans text-[.92rem] font-semibold text-text mb-1">{r.name}</div>
                <p className="font-mono text-[.76rem] text-muted leading-[1.55]">{r.note}</p>
              </div>
            </Reveal>
          ))}
        </div>

        <SubHeading>Security & posture</SubHeading>
        <div className="flex flex-col gap-3">
          {DEPLOYMENT.posture.map((p, i) => (
            <Card key={i}>
              <strong className="text-accent block mb-1.5 text-[.92rem]">{p.heading}</strong>
              <p className="text-[.88rem] text-muted leading-[1.75]">
                {p.body}
                {p.code && (
                  <code className="inline-block font-mono text-[.78rem] bg-surface border border-border rounded px-[.45rem] py-[.1rem] text-green ml-1">
                    {p.code}
                  </code>
                )}
              </p>
            </Card>
          ))}
        </div>
      </section>

      <div className="h-px bg-border" />

      {/* C — Decision Contract */}
      <section>
        <SectionLabel num={CONTRACT.sectionLabel}>{CONTRACT.sectionName}</SectionLabel>
        <Reveal>
          <h3
            className="font-display font-normal text-text mb-3"
            style={{ fontSize: 'clamp(1.4rem,2.2vw,1.8rem)' }}
          >
            {CONTRACT.title}
          </h3>
        </Reveal>
        <SectionDesc>{CONTRACT.desc}</SectionDesc>

        <SubHeading>Closed enums</SubHeading>
        <div className="grid gap-3 mb-8">
          {CONTRACT.enums.map((e) => (
            <EnumBlock key={e.name} name={e.name} values={e.values} />
          ))}
        </div>

        <SubHeading>The three endpoints</SubHeading>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {CONTRACT.endpoints.map((ep) => (
            <EndpointCard key={ep.path} {...ep} />
          ))}
        </div>
      </section>

      <div className="h-px bg-border" />

      {/* D — End-to-end Flow */}
      <section>
        <SectionLabel num={FLOW.sectionLabel}>{FLOW.sectionName}</SectionLabel>
        <Reveal>
          <h3
            className="font-display font-normal text-text mb-3"
            style={{ fontSize: 'clamp(1.4rem,2.2vw,1.8rem)' }}
          >
            {FLOW.title}
          </h3>
        </Reveal>
        <SectionDesc>{FLOW.desc}</SectionDesc>

        <SubHeading>Shared prelude — runs on every request</SubHeading>
        <div className="mb-8">
          <StepList steps={FLOW.shared} />
        </div>

        <SubHeading>{FLOW.describe.title}</SubHeading>
        <Reveal>
          <p className="text-[.88rem] text-muted leading-[1.75] max-w-[760px] mb-4">
            {FLOW.describe.intro}
          </p>
        </Reveal>
        <div className="mb-8">
          <StepList steps={FLOW.describe.steps} />
        </div>

        <SubHeading>{FLOW.expand.title}</SubHeading>
        <Reveal>
          <p className="text-[.88rem] text-muted leading-[1.75] max-w-[760px] mb-4">
            {FLOW.expand.intro}
          </p>
        </Reveal>
        <div>
          <StepList steps={FLOW.expand.steps} />
        </div>
      </section>

      <div className="h-px bg-border" />

      {/* E — Data model */}
      <section>
        <SectionLabel num={DATA_MODEL.sectionLabel}>{DATA_MODEL.sectionName}</SectionLabel>
        <Reveal>
          <h3
            className="font-display font-normal text-text mb-3"
            style={{ fontSize: 'clamp(1.4rem,2.2vw,1.8rem)' }}
          >
            {DATA_MODEL.title}
          </h3>
        </Reveal>
        <SectionDesc>{DATA_MODEL.desc}</SectionDesc>

        <div className="grid gap-3 sm:grid-cols-2 mb-8">
          {DATA_MODEL.tables.map((t) => (
            <TableCard key={t.name} {...t} />
          ))}
        </div>

        <SubHeading>{DATA_MODEL.rrf.title}</SubHeading>
        <Card>
          <p className="text-[.9rem] text-muted leading-[1.85]">{DATA_MODEL.rrf.body}</p>
        </Card>
      </section>

      <div className="h-px bg-border" />

      {/* F — Failure Handling */}
      <section>
        <SectionLabel num={FAILURE.sectionLabel}>{FAILURE.sectionName}</SectionLabel>
        <Reveal>
          <h3
            className="font-display font-normal text-text mb-3"
            style={{ fontSize: 'clamp(1.4rem,2.2vw,1.8rem)' }}
          >
            {FAILURE.title}
          </h3>
        </Reveal>
        <SectionDesc>{FAILURE.desc}</SectionDesc>

        <StackTable
          rows={FAILURE.rows as unknown as Record<string, string>[]}
          cols={[
            { key: 'dep',        label: 'Dependency', widthClass: '1.4fr' },
            { key: 'timeout',    label: 'Budget',     widthClass: '1.6fr' },
            { key: 'on_failure', label: 'On failure', widthClass: '4fr' },
          ]}
        />
      </section>

      <div className="h-px bg-border" />

      {/* G — Frontend */}
      <section>
        <SectionLabel num={FRONTEND.sectionLabel}>{FRONTEND.sectionName}</SectionLabel>
        <Reveal>
          <h3
            className="font-display font-normal text-text mb-3"
            style={{ fontSize: 'clamp(1.4rem,2.2vw,1.8rem)' }}
          >
            {FRONTEND.title}
          </h3>
        </Reveal>
        <SectionDesc>{FRONTEND.desc}</SectionDesc>

        <SubHeading>Stack</SubHeading>
        <div className="mb-8">
          <StackTable
            rows={FRONTEND.stack as unknown as Record<string, string>[]}
            cols={[
              { key: 'layer',  label: 'Layer',  widthClass: '1.1fr' },
              { key: 'choice', label: 'Choice', widthClass: '2.6fr' },
              { key: 'why',    label: 'Why',    widthClass: '3.3fr' },
            ]}
          />
        </div>

        <SubHeading>Cloudflare deployment</SubHeading>
        <div className="grid gap-3">
          {FRONTEND.deployment.map((d) => (
            <Reveal key={d.item}>
              <div className="bg-card border border-border rounded-[12px] px-5 py-4">
                <div className="font-mono text-[.7rem] text-accent tracking-[.12em] uppercase mb-1">
                  {d.item}
                </div>
                <p className="text-[.88rem] text-muted leading-[1.7]">{d.detail}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>
    </div>
  );
}

// ─── V2 panel — high level only ───────────────────────────

function V2Panel() {
  return (
    <div
      className="rounded-2xl p-6 sm:p-12"
      style={{
        background:
          'linear-gradient(135deg, rgba(234,106,31,.06), rgba(148,66,28,.04))',
        border: '1px dashed rgba(148,66,28,.30)',
      }}
    >
      <div className="text-center mb-8">
        <span
          className="inline-block font-mono text-[.62rem] text-accent px-[.7rem] py-[.25rem] rounded mb-4 tracking-[.14em] uppercase"
          style={{ background: '#FDEFE5', border: '1px solid #FBE3D1' }}
        >
          Coming next
        </span>
        <h3 className="font-display font-normal text-[1.6rem] text-text mb-3">{V2.title}</h3>
        <p className="text-muted max-w-[720px] mx-auto leading-[1.75] text-[.92rem]">{V2.desc}</p>
      </div>

      <div
        className="grid gap-3 max-w-[920px] mx-auto"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}
      >
        {V2.plannedItems.map((item) => (
          <div key={item} className="bg-card border border-border rounded-[10px] px-5 py-4">
            <div className="font-mono text-[.6rem] text-purple tracking-[.12em] uppercase mb-1">
              Planned change
            </div>
            <p className="text-[.82rem] text-text leading-[1.65]">{item}</p>
          </div>
        ))}
      </div>

      {/* Tracker — still planned, but not a structural change */}
      <div className="max-w-[920px] mx-auto mt-10">
        <div className="font-mono text-[.62rem] text-muted tracking-[.14em] uppercase mb-3">
          {V2.trackerTitle}
        </div>
        <ul className="flex flex-col gap-2">
          {V2.trackerItems.map((item) => (
            <li
              key={item}
              className="bg-card border border-border rounded-[8px] px-4 py-3 text-[.8rem] text-muted leading-[1.6] flex gap-3"
            >
              <span className="font-mono text-[.7rem] text-accent shrink-0 mt-[.15rem]">—</span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ─── System Architecture HLD — visual overview ────────────

function SystemArchHLD() {
  return (
    <div className="flex flex-col gap-10 mb-2">
      {/* ── Identity: What + Why ── */}
      <div className="grid gap-4 md:grid-cols-2">
        <Reveal>
          <div
            className="rounded-[14px] p-6 h-full border"
            style={{ background: '#FDEFE5', borderColor: '#FBE3D1' }}
          >
            <div
              className="font-mono text-[.62rem] tracking-[.14em] uppercase mb-2"
              style={{ color: '#EA6A1F' }}
            >
              {SYSTEM_ARCH.identity.what.title}
            </div>
            <p className="text-[.92rem] text-text leading-[1.75]">
              {SYSTEM_ARCH.identity.what.body}
            </p>
          </div>
        </Reveal>
        <Reveal delay={80}>
          <div
            className="rounded-[14px] p-6 h-full border"
            style={{
              background: 'rgba(148,66,28,.05)',
              borderColor: 'rgba(148,66,28,.20)',
            }}
          >
            <div
              className="font-mono text-[.62rem] tracking-[.14em] uppercase mb-2"
              style={{ color: '#94421C' }}
            >
              {SYSTEM_ARCH.identity.why.title}
            </div>
            <p className="text-[.92rem] text-text leading-[1.75] mb-4">
              {SYSTEM_ARCH.identity.why.body}
            </p>
            <div className="flex flex-wrap gap-2">
              {SYSTEM_ARCH.identity.why.pillars.map((p) => (
                <span
                  key={p.tag}
                  className="font-mono text-[.68rem] uppercase tracking-[.1em] px-2.5 py-1 rounded-md"
                  style={{
                    background: 'white',
                    border: '1px solid rgba(148,66,28,.25)',
                    color: '#94421C',
                  }}
                  title={p.body}
                >
                  {p.tag}
                </span>
              ))}
            </div>
          </div>
        </Reveal>
      </div>

      {/* ── Core components — 5 HLD blocks ── */}
      <div>
        <SubHeading>Core components</SubHeading>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {SYSTEM_ARCH.components.map((c, i) => (
            <Reveal key={c.key} delay={i * 60}>
              <div className="bg-card border border-border rounded-[12px] p-5 h-full transition-colors hover:border-accent">
                <div className="font-mono text-[.66rem] text-accent tracking-[.12em] uppercase mb-1.5">
                  {c.tag}
                </div>
                <code className="block font-mono text-[.7rem] text-muted bg-surface border border-border rounded px-[.45rem] py-[.18rem] mb-3 leading-[1.5]">
                  {c.stack}
                </code>
                <p className="text-[.84rem] text-text leading-[1.7]">{c.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>

      {/* ── Request flow — horizontal step diagram ── */}
      <div>
        <SubHeading>{SYSTEM_ARCH.flowTitle}</SubHeading>
        <Reveal>
          <p className="text-[.92rem] text-muted leading-[1.8] max-w-[760px] mb-6">
            {SYSTEM_ARCH.flowIntro}
          </p>
        </Reveal>
        <Reveal>
          <div
            className="rounded-[16px] p-5 sm:p-7 border"
            style={{
              background:
                'linear-gradient(135deg, rgba(234,106,31,.04) 0%, rgba(148,66,28,.06) 100%)',
              borderColor: 'rgba(148,66,28,.18)',
            }}
          >
            <ol className="grid gap-3 lg:grid-cols-7 md:grid-cols-4 sm:grid-cols-2 grid-cols-1">
              {SYSTEM_ARCH.flow.map((s, i) => (
                <li
                  key={s.n}
                  className="relative bg-card border border-border rounded-[10px] p-4 flex flex-col gap-2"
                >
                  {/* Arrow on lg screens between cards */}
                  {i < SYSTEM_ARCH.flow.length - 1 && (
                    <span
                      aria-hidden
                      className="hidden lg:block absolute -right-[10px] top-1/2 -translate-y-1/2 font-mono text-[.9rem] z-10"
                      style={{ color: '#94421C' }}
                    >
                      ›
                    </span>
                  )}
                  <div className="flex items-center gap-2">
                    <span
                      className="font-mono text-[.62rem] text-white px-[.45rem] py-[.12rem] rounded tracking-[.06em] shrink-0"
                      style={{
                        background:
                          'linear-gradient(135deg, #EA6A1F 0%, #94421C 100%)',
                      }}
                    >
                      {s.n}
                    </span>
                    <span
                      className="text-[1.05rem] leading-none"
                      style={{ color: '#EA6A1F' }}
                      aria-hidden
                    >
                      {s.icon}
                    </span>
                  </div>
                  <div className="font-sans text-[.84rem] font-semibold text-text leading-[1.3]">
                    {s.name}
                  </div>
                  <p className="text-[.74rem] text-muted leading-[1.55]">{s.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </Reveal>
      </div>

      {/* ── Two business flows ── */}
      <div>
        <SubHeading>Two business flows, one skeleton</SubHeading>
        <div className="grid gap-4 md:grid-cols-2">
          {SYSTEM_ARCH.businessFlows.map((bf, i) => (
            <Reveal key={bf.key} delay={i * 80}>
              <div className="bg-card border border-border rounded-[14px] p-6 h-full">
                <div className="flex items-center gap-3 mb-2">
                  <Badge color="accent">{bf.tag}</Badge>
                  <span className="font-sans text-[.95rem] font-semibold text-text">
                    {bf.title}
                  </span>
                </div>
                <p className="text-[.86rem] text-muted leading-[1.7] mb-4">{bf.body}</p>
                <div className="font-mono text-[.62rem] text-muted tracking-[.14em] uppercase mb-2">
                  Steps used
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {bf.uses.map((u) => (
                    <span
                      key={u}
                      className="font-mono text-[.7rem] text-text bg-surface border border-border rounded px-[.5rem] py-[.18rem]"
                    >
                      {u}
                    </span>
                  ))}
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>

      {/* ── Why this is safe + practical ── */}
      <div>
        <SubHeading>{SYSTEM_ARCH.safetyTitle}</SubHeading>
        <div className="grid gap-3 sm:grid-cols-2">
          {SYSTEM_ARCH.safety.map((s, i) => (
            <Reveal key={s.tag} delay={i * 60}>
              <div className="bg-card border border-border rounded-[12px] p-5 h-full flex gap-4">
                <span
                  className="font-mono text-[.7rem] text-white px-[.5rem] py-[.18rem] rounded shrink-0 self-start tracking-[.06em]"
                  style={{
                    background: 'linear-gradient(135deg, #EA6A1F 0%, #94421C 100%)',
                  }}
                >
                  ✓
                </span>
                <div>
                  <div className="font-sans text-[.88rem] font-semibold text-text mb-1">
                    {s.tag}
                  </div>
                  <p className="text-[.82rem] text-muted leading-[1.65]">{s.body}</p>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────

export default function Architecture() {
  return (
    <Layout chapter={PAGE.chapter} pageTitle={PAGE.pageTitle}>
      <PageHero
        kicker={PAGE.hero.kicker}
        title={
          <>
            Technical <em className="not-italic text-accent">{PAGE.hero.titleAccent}</em>
          </>
        }
        lede={PAGE.hero.lede}
      />

      <section id="v1-panel" className="px-4 sm:px-8 lg:px-12 py-10 sm:py-14">
        <div className="max-w-[1160px] mx-auto">
          <SectionLabel num={SYSTEM_ARCH.num}>{SYSTEM_ARCH.label}</SectionLabel>
          <SectionTitle>{SYSTEM_ARCH.title}</SectionTitle>
          <SectionDesc>{SYSTEM_ARCH.oneLiner}</SectionDesc>

          <SystemArchHLD />

          <div className="mt-12">
            <VerticalTabs
              tabs={[
                { id: 'v1', label: 'V1 — Current', content: <V1Panel /> },
                { id: 'v2', label: 'V2 — Planned', content: <V2Panel /> },
              ]}
            />
          </div>
        </div>
      </section>

      <div className="px-4 sm:px-8 lg:px-12">
        <PageNav prev={NAV.prev} next={NAV.next} />
      </div>
    </Layout>
  );
}
