import Layout, { PageHero } from '../components/Layout';
import {
  SectionLabel,
  SectionTitle,
  SectionDesc,
  Divider,
  PageNav,
  Reveal,
} from '../components/ui';
import {
  PAGE, BIG_PICTURE, HVLV, DATA_INTAKE, ENGINE_STEPS,
  HS_CODE_SECTION, HS_QUALITY_ROWS, ALGO_STEPS, WARNINGS,
  AI_OPPORTUNITIES, ZATCA_SECTION, ZATCA_SECTIONS, WORKED_EXAMPLE, NAV,
  type FieldSource,
} from '../content/process';

// ── Inline markdown helper ───────────────────────────────
// Converts simple markdown (backticks, **bold**, *italic*) to React elements
function Md({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('`') && part.endsWith('`'))
          return <code key={i} className="font-mono text-[.78rem] bg-surface border border-border rounded px-1 py-0.5">{part.slice(1, -1)}</code>;
        if (part.startsWith('**') && part.endsWith('**'))
          return <strong key={i} className="text-text">{part.slice(2, -2)}</strong>;
        if (part.startsWith('*') && part.endsWith('*'))
          return <em key={i}>{part.slice(1, -1)}</em>;
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

// ── HV/LV Cards ───────────────────────────────────────────
function HVLVCard({
  type,
  threshold,
  badge,
  rules,
  delay = 0,
}: {
  type: 'hv' | 'lv';
  threshold: string;
  badge: string;
  rules: { icon: string; text: string }[];
  delay?: number;
}) {
  const isHV = type === 'hv';
  return (
    <Reveal delay={delay}>
      <div
        className="rounded-2xl p-5 sm:p-8 border"
        style={{
          background: isHV
            ? 'linear-gradient(135deg, rgba(14,23,41,.05) 0%, #fff 60%)'
            : 'linear-gradient(135deg, rgba(52,211,153,.06) 0%, #fff 60%)',
          borderColor: isHV ? 'rgba(30,58,95,.2)' : 'rgba(52,211,153,.25)',
        }}
      >
        <span
          className="inline-flex items-center gap-1 font-mono text-[.72rem] tracking-[.08em] uppercase px-[.7rem] py-[.25rem] rounded-md mb-4"
          style={
            isHV
              ? { background: 'rgba(14,23,41,.06)', color: '#1e3a5f', border: '1px solid rgba(30,58,95,.2)' }
              : { background: 'rgba(52,211,153,.1)', color: '#0a7a52', border: '1px solid rgba(52,211,153,.25)' }
          }
        >
          {badge}
        </span>
        <div
          className="font-mono text-[1.4rem] sm:text-[1.8rem] font-bold mb-1"
          style={{ color: isHV ? '#1e3a5f' : '#0a7a52' }}
        >
          {threshold}
        </div>
        <div className="flex flex-col gap-3 mt-5">
          {rules.map((r, i) => (
            <div key={i} className="flex gap-3 text-[.8rem] leading-[1.5]">
              <span className="shrink-0">{r.icon}</span>
              <span className="text-muted"><Md text={r.text} /></span>
            </div>
          ))}
        </div>
      </div>
    </Reveal>
  );
}

// ── Channel Card ──────────────────────────────────────────
function ChannelCard({
  badge, title, desc, fields, delay = 0,
}: {
  badge: string;
  title: string;
  desc: string;
  fields: { name: string; val: string; status: 'req' | 'miss' | 'opt' }[];
  delay?: number;
}) {
  const statusColor = { req: '#1e3a5f', miss: '#c0392b', opt: '#546178' };
  const statusLabel = { req: '✓', miss: '✗ absent', opt: 'opt' };

  return (
    <Reveal delay={delay}>
      <div className="bg-card border border-border rounded-2xl p-5 sm:p-8 h-full transition-[border-color] duration-300 hover:border-accent">
        <div
          className="inline-flex items-center gap-2 font-mono text-[.72rem] tracking-[.08em] uppercase px-3 py-[.3rem] rounded-md mb-4"
          style={{ background: 'rgba(14,23,41,.06)', border: '1px solid rgba(30,58,95,.2)', color: '#1e3a5f' }}
        >
          {badge}
        </div>
        <h3 className="font-display text-[1.15rem] font-normal text-text mb-2">{title}</h3>
        <p className="text-[.82rem] text-muted leading-[1.7] mb-5">{desc}</p>
        <div className="flex flex-col gap-2">
          {fields.map((f, i) => (
            <div key={i} className="flex items-baseline gap-2 font-mono text-[.68rem]">
              <span className="w-1 h-1 rounded-full bg-dim shrink-0 mt-1" />
              <span className="text-blue shrink-0">{f.name}</span>
              <span className="text-muted flex-1">{f.val}</span>
              <span style={{ color: statusColor[f.status], fontSize: '.58rem' }}>{statusLabel[f.status]}</span>
            </div>
          ))}
        </div>
      </div>
    </Reveal>
  );
}

// ── Engine Steps ──────────────────────────────────────────
function EngineBox() {
  return (
    <Reveal delay={200} className="bg-card border border-border rounded-[20px] p-5 sm:p-8 lg:p-10 mt-8">
      <div className="flex items-center gap-3 font-mono text-[.92rem] text-accent tracking-[.1em] uppercase mb-7">
        <span>⚙</span> What happens inside Naqel's processing engine
      </div>
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-5">
        {ENGINE_STEPS.map((s, i) => (
          <Reveal key={s.num} delay={i * 70}>
            <div className="bg-surface border border-border rounded-xl px-4 py-5 text-center transition-all duration-300 hover:border-accent hover:bg-[rgba(14,23,41,.04)]">
              <div className="font-mono text-[1.1rem] text-dim font-bold mb-1">{s.num}</div>
              <div className="font-sans text-[.85rem] font-semibold text-text mb-1">{s.name}</div>
              <div className="text-[.74rem] text-muted leading-[1.5]">{s.desc}</div>
            </div>
          </Reveal>
        ))}
      </div>
    </Reveal>
  );
}

// ── HS Code quality table ─────────────────────────────────
function HSQualityTable() {
  return (
    <Reveal className="mb-12">
      <div className="bg-card border border-border rounded-xl overflow-hidden text-[.85rem]">
        <div className="grid border-b border-border" style={{ gridTemplateColumns: '1fr minmax(90px, auto) minmax(70px, auto)' }}>
          {['Category', 'Count', '%'].map((h, i) => (
            <div key={h} className={`px-3 sm:px-5 py-3 font-semibold text-muted border-r border-border last:border-r-0 ${i > 0 ? 'text-right' : ''}`}>{h}</div>
          ))}
        </div>
        {HS_QUALITY_ROWS.map((r) => (
          <div key={r.label} className="grid border-b border-border last:border-b-0" style={{ gridTemplateColumns: '1fr minmax(90px, auto) minmax(70px, auto)' }}>
            <div className="px-3 sm:px-5 py-3 border-r border-border font-semibold" style={{ color: r.color }}>{r.label}</div>
            <div className="px-3 sm:px-5 py-3 border-r border-border text-right font-mono text-text">{r.count}</div>
            <div className="px-3 sm:px-5 py-3 text-right font-mono font-bold" style={{ color: r.color }}>{r.pct}</div>
          </div>
        ))}
      </div>
    </Reveal>
  );
}

// ── ZATCA XML ─────────────────────────────────────────────
const sourceStyles: Record<FieldSource, { bg: string; border: string; color: string; label: string }> = {
  client:  { bg: 'rgba(96,165,250,.1)',   border: 'rgba(96,165,250,.25)',  color: '#1d4ed8', label: 'client' },
  derived: { bg: 'rgba(167,139,250,.1)',  border: 'rgba(167,139,250,.25)', color: '#6d28d9', label: 'derived' },
  fixed:   { bg: 'rgba(107,113,144,.15)', border: '#d8dce8',               color: '#546178', label: 'fixed' },
  mapped:  { bg: 'rgba(14,23,41,.06)',    border: 'rgba(30,58,95,.2)',      color: '#1e3a5f', label: 'mapped' },
};

function ZatcaSection({ sec }: { sec: typeof ZATCA_SECTIONS[number] & { delay?: number } }) {
  return (
    <Reveal delay={sec.delay ?? 0}>
      <div
        className="bg-card border border-border rounded-[13px] p-5"
        style={sec.wide ? { gridColumn: '1/-1' } : undefined}
      >
        <div className="flex justify-between items-start mb-4 pb-3 border-b border-border">
          <span className="font-mono text-[.82rem] text-accent font-semibold">{sec.name}</span>
          <code className="font-mono text-[.65rem] text-muted bg-surface border border-border rounded px-2 py-0.5">{sec.tag}</code>
        </div>
        <div className="flex flex-col gap-2">
          {sec.fields.map((f) => {
            const s = sourceStyles[f.source];
            return (
              <div key={f.name} className="flex items-baseline gap-2 font-mono text-[.72rem]">
                <span className="text-blue shrink-0 min-w-[100px] sm:min-w-[150px]">{f.name}</span>
                <span className="text-muted flex-1 text-[.7rem]">{f.value}</span>
                <span
                  className="text-[.6rem] rounded px-1.5 py-0.5 whitespace-nowrap shrink-0"
                  style={{ background: s.bg, border: `1px solid ${s.border}`, color: s.color }}
                >
                  {s.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </Reveal>
  );
}

// ── Page ──────────────────────────────────────────────────
export default function Process() {
  return (
    <Layout chapter={PAGE.chapter} pageTitle={PAGE.pageTitle}>
      <PageHero
        kicker={PAGE.hero.kicker}
        title={<>Current Naqel customs <em className="not-italic text-accent">{PAGE.hero.titleAccent}</em></>}
        lede={PAGE.hero.lede}
      />

      {/* 1. Big Picture */}
      <section id="big-picture" className="px-4 sm:px-8 lg:px-12 py-10 sm:py-14">
        <div className="max-w-[1160px] mx-auto">
          <SectionLabel num={BIG_PICTURE.num}>{BIG_PICTURE.label}</SectionLabel>
          <SectionTitle>{BIG_PICTURE.title}</SectionTitle>
          <SectionDesc><Md text={BIG_PICTURE.desc} /></SectionDesc>
          <Reveal className="mt-2 text-center">
            <img src={BIG_PICTURE.diagram} alt={BIG_PICTURE.diagramAlt} className="max-w-full h-auto rounded-xl border border-border" />
          </Reveal>
        </div>
      </section>

      <Divider />

      {/* 2. HV vs LV */}
      <section id="hvlv" className="px-4 sm:px-8 lg:px-12 py-10 sm:py-14">
        <div className="max-w-[1160px] mx-auto">
          <SectionLabel num={HVLV.num}>{HVLV.label}</SectionLabel>
          <SectionTitle>{HVLV.title}</SectionTitle>
          <SectionDesc>{HVLV.desc}</SectionDesc>

          <Reveal className="mb-6 bg-card border border-border rounded-xl px-7 py-6">
            <div className="text-[.7rem] uppercase tracking-[.12em] text-accent font-semibold mb-3">
              Applies to both HV &amp; LV
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-[.82rem] text-muted">
              {HVLV.shared.map((item) => <div key={item}>{item}</div>)}
            </div>
            <div className="text-[.76rem] text-dim mt-3">
              {HVLV.sharedNote}
            </div>
          </Reveal>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <HVLVCard type="hv" threshold={HVLV.hv.threshold} badge={HVLV.hv.badge} rules={HVLV.hv.rules} delay={0} />
            <HVLVCard type="lv" threshold={HVLV.lv.threshold} badge={HVLV.lv.badge} rules={HVLV.lv.rules} delay={100} />
          </div>
        </div>
      </section>

      <Divider />

      {/* 3. Data Intake */}
      <section id="intake" className="px-4 sm:px-8 lg:px-12 py-10 sm:py-14">
        <div className="max-w-[1160px] mx-auto">
          <SectionLabel num={DATA_INTAKE.num}>{DATA_INTAKE.label}</SectionLabel>
          <SectionTitle>{DATA_INTAKE.title}</SectionTitle>
          <SectionDesc>{DATA_INTAKE.desc}</SectionDesc>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {DATA_INTAKE.channels.map((ch, i) => (
              <ChannelCard key={ch.title} badge={ch.badge} title={ch.title} desc={ch.desc} fields={ch.fields} delay={i * 150} />
            ))}
          </div>

          <EngineBox />
        </div>
      </section>

      <Divider />

      {/* 4. HS Code Resolution */}
      <section id="hscode" className="px-4 sm:px-8 lg:px-12 py-10 sm:py-14">
        <div className="max-w-[1160px] mx-auto">
          <SectionLabel num={HS_CODE_SECTION.num}>{HS_CODE_SECTION.label}</SectionLabel>
          <SectionTitle>{HS_CODE_SECTION.title}</SectionTitle>
          <SectionDesc><Md text={HS_CODE_SECTION.desc} /></SectionDesc>

          <HSQualityTable />

          {/* Algo layout */}
          <div className="grid gap-8 grid-cols-1 xl:grid-cols-2">
            {/* Left: algo steps */}
            <div className="flex flex-col gap-5">
              {ALGO_STEPS.map((step, i) => (
                <Reveal key={step.num} delay={i * 80}>
                  <div className="bg-card border border-border rounded-[13px] p-6">
                    <div className="font-mono text-[.58rem] tracking-[.12em] uppercase mb-2" style={{ color: '#2d5a8e' }}>
                      Step {step.num}
                    </div>
                    <div className="font-sans font-bold text-text text-[.92rem] mb-2">{step.title}</div>
                    <div className="text-[.82rem] text-muted leading-[1.65]"><Md text={step.desc} /></div>
                    {step.searchKeys && (
                      <div className="flex flex-wrap items-center gap-2 mt-3">
                        <code className="font-mono text-[.76rem] bg-surface border border-border rounded px-2 py-1 text-accent">{step.searchKeys[0]}</code>
                        <span className="text-dim text-sm">→</span>
                        {step.searchKeys.slice(1).map(k => (
                          <code key={k} className="font-mono text-[.76rem] bg-surface border border-border rounded px-2 py-1 text-muted">{k}</code>
                        ))}
                      </div>
                    )}
                  </div>
                </Reveal>
              ))}

              {/* Warnings */}
              {WARNINGS.map((w, i) => (
                <Reveal key={w.tag} delay={450 + i * 50}>
                  <div className="bg-card border border-border rounded-[13px] p-5" style={{ background: 'rgba(251,146,60,.04)', borderColor: 'rgba(251,146,60,.25)' }}>
                    <div className="font-mono text-[.6rem] text-orange tracking-[.1em] uppercase mb-2">⚠ {w.tag}</div>
                    <div className="text-[.8rem] text-muted leading-[1.65]"><Md text={w.body} /></div>
                  </div>
                </Reveal>
              ))}
            </div>

            {/* Right: worked example */}
            <Reveal delay={200}>
              <div className="bg-card border border-border rounded-[14px] p-4 sm:p-7 xl:sticky xl:top-[100px] xl:self-start">
                <div className="font-mono text-[.6rem] text-muted tracking-[.1em] uppercase mb-5">
                  {WORKED_EXAMPLE.title}
                </div>

                {/* Client sends */}
                <div className="mb-4 pb-4 border-b border-border">
                  <div className="font-mono text-[.62rem] text-dim uppercase tracking-[.08em] mb-1">Client sends</div>
                  <div className="font-mono text-[.82rem]">
                    CustomsCommodityCode: <span className="text-accent font-bold">{WORKED_EXAMPLE.clientSends.code}</span>
                  </div>
                  <div className="text-[.72rem] text-muted mt-1">{WORKED_EXAMPLE.clientSends.note}</div>
                </div>

                {/* Step 1 */}
                <div className="mb-4 pb-4 border-b border-border">
                  <div className="font-mono text-[.62rem] text-dim uppercase tracking-[.08em] mb-1">Step 1 — Clean</div>
                  <div className="font-mono text-[.82rem]">
                    <span className="text-accent">{WORKED_EXAMPLE.step1.from}</span>
                    {' → '}
                    <span className="text-green font-bold">{WORKED_EXAMPLE.step1.to}</span>
                    {' '}({WORKED_EXAMPLE.step1.note})
                  </div>
                </div>

                {/* Step 2 */}
                <div className="mb-4 pb-4 border-b border-border">
                  <div className="font-mono text-[.62rem] text-dim uppercase tracking-[.08em] mb-1">Step 2 — Search keys</div>
                  <div className="font-mono text-[.78rem] leading-[2.1] flex flex-wrap gap-x-2">
                    {WORKED_EXAMPLE.searchKeys.map(k => (
                      <span key={k} className="text-accent">{k}</span>
                    ))}
                  </div>
                </div>

                {/* Lookup table */}
                <div className="mb-4 pb-4 border-b border-border">
                  <div className="font-mono text-[.62rem] text-dim uppercase tracking-[.08em] mb-2">Steps 3 & 4 — Lookup & pick best</div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-[.68rem] font-mono">
                      <thead>
                        <tr className="text-dim text-[.6rem]">
                          <th className="text-left pb-1 pr-2">ZATCA 12-digit</th>
                          <th className="text-left pb-1 pr-2">Arabic description</th>
                          <th className="text-left pb-1 pr-2">Duty</th>
                          <th className="text-left pb-1">Matched key</th>
                        </tr>
                      </thead>
                      <tbody>
                        {WORKED_EXAMPLE.lookupRows.map((row) => (
                          <tr key={row.code} className={row.picked ? 'text-green font-bold' : 'text-dim'}>
                            <td className="pr-2 py-0.5">{row.code}</td>
                            <td className="pr-2">{row.desc}</td>
                            <td className="pr-2">{row.duty}</td>
                            <td>{row.key}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="text-[.7rem] text-muted leading-[1.6] mt-2">
                    <Md text={WORKED_EXAMPLE.lookupNote} />
                  </div>
                </div>

                {/* Result */}
                <div className="mb-4 pb-4 border-b border-border">
                  <div className="font-mono text-[.62rem] text-dim uppercase tracking-[.08em] mb-1">Result</div>
                  <div className="font-mono text-[.82rem]">tariffCode: <span className="text-green font-bold">{WORKED_EXAMPLE.result.tariffCode}</span></div>
                  <div className="font-mono text-[.82rem] mt-1">goodsDescription: <span className="text-muted">{WORKED_EXAMPLE.result.goodsDescription}</span></div>
                  <span
                    className="inline-block mt-2 font-mono text-[.62rem] tracking-[.06em] px-[.7rem] py-[.25rem] rounded"
                    style={{ background: 'rgba(52,211,153,.1)', border: '1px solid rgba(52,211,153,.25)', color: '#0a7a52' }}
                  >
                    {WORKED_EXAMPLE.result.badge}
                  </span>
                </div>

                {/* Blue note */}
                <div className="rounded-[10px] p-4 mt-1" style={{ background: 'rgba(96,165,250,.05)', border: '1px solid rgba(96,165,250,.2)' }}>
                  <div className="font-mono text-[.6rem] text-blue tracking-[.1em] uppercase mb-1">✓ Complete code — no algorithm needed</div>
                  <div className="text-[.72rem] text-muted leading-[1.65]">
                    <Md text={WORKED_EXAMPLE.completeCodeNote} />
                  </div>
                </div>
              </div>
            </Reveal>
          </div>

          {/* What happens today vs where AI fits */}
          <div className="mt-12">
            <Reveal>
              <div className="font-mono text-[.6rem] text-muted tracking-[.14em] uppercase mb-5">
                What happens today — and where AI changes it
              </div>
            </Reveal>
            <div className="flex flex-col gap-4">
              {AI_OPPORTUNITIES.map((row) => (
                <Reveal key={row.pct}>
                  <div className="bg-card border border-border rounded-[14px] px-7 py-6">
                    <div className="flex items-center gap-3 mb-3">
                      <span className="font-mono text-[1rem] font-bold" style={{ color: row.color }}>{row.pct}</span>
                      <span className="text-[.85rem] font-semibold text-text">{row.title}</span>
                    </div>
                    <div className="text-[.82rem] text-muted leading-[1.65] mb-4">
                      <strong className="text-text">Today:</strong>{' '}<Md text={row.today} />
                    </div>
                    <div className="bg-surface border border-border rounded-[8px] px-4 py-3 text-[.78rem] text-text">
                      <strong className="text-accent">AI opportunity:</strong>{' '}<Md text={row.ai} />
                    </div>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </div>
      </section>

      <Divider />

      {/* 5. ZATCA XML */}
      <section id="zatca" className="px-4 sm:px-8 lg:px-12 py-10 sm:py-14">
        <div className="max-w-[1160px] mx-auto">
          <SectionLabel num={ZATCA_SECTION.num}>{ZATCA_SECTION.label}</SectionLabel>
          <SectionTitle>What gets sent <em className="not-italic text-accent">to Saudi Customs</em></SectionTitle>
          <SectionDesc>{ZATCA_SECTION.desc}</SectionDesc>

          {/* Legend */}
          <Reveal className="flex flex-wrap gap-5 mb-8">
            {(Object.entries(sourceStyles) as [FieldSource, typeof sourceStyles[FieldSource]][]).map(([, s]) => (
              <div key={s.label} className="flex items-center gap-2 text-[.78rem] text-muted font-mono">
                <span className="w-[10px] h-[10px] rounded-[3px] inline-block" style={{ background: s.bg, border: `1px solid ${s.border}` }} />
                {s.label}
              </div>
            ))}
          </Reveal>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {ZATCA_SECTIONS.map((sec, i) => (
              <ZatcaSection key={sec.name} sec={{ ...sec, delay: i * 70 }} />
            ))}
          </div>
        </div>
      </section>

      <div className="px-4 sm:px-8 lg:px-12">
        <PageNav prev={NAV.prev} next={NAV.next} />
      </div>
    </Layout>
  );
}
