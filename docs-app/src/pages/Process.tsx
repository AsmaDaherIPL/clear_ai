import Layout, { PageHero } from '../components/Layout';
import {
  SectionLabel,
  SectionTitle,
  SectionDesc,
  Divider,
  PageNav,
  Reveal,
} from '../components/ui';

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
  rules: { icon: string; text: string; code?: string }[];
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
              <span className="text-muted">
                <strong className="text-text">{r.text}</strong>
                {r.code && (
                  <code className="font-mono text-[.72rem] bg-surface border border-border rounded px-1.5 py-0.5 text-green ml-1">
                    {r.code}
                  </code>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>
    </Reveal>
  );
}

// ── Channel Card ──────────────────────────────────────────
interface FieldRow { name: string; val: string; status: 'req' | 'miss' | 'opt' }

function ChannelCard({
  badge,
  title,
  desc,
  fields,
  delay = 0,
}: {
  badge: string;
  title: string;
  desc: string;
  fields: FieldRow[];
  delay?: number;
  side?: 'left' | 'right';
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
        <h3 className="font-sans text-[1.15rem] font-bold text-text mb-2">{title}</h3>
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
const ENGINE_STEPS = [
  { num: '01', name: 'HV/LV Classify',      desc: 'Apply 1,000 SAR threshold — route to generic code or full HS resolution' },
  { num: '02', name: 'Resolve HS Code',     desc: 'Normalize format, complete to 12 digits via lookup table + algorithm' },
  { num: '03', name: 'Map Lookups',         desc: 'Currency ISO → ZATCA system ID. Station → ZATCA city code + Arabic name.' },
  { num: '04', name: 'Arabic Description',  desc: 'Pull Arabic goods description from HS master. Append words to avoid exact ZATCA match rejection.' },
  { num: '05', name: 'Build & Submit XML',  desc: 'Assemble ZATCA XML, submit to ZATCA system via H2H interface, receive Bayan number' },
];

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
const HS_QUALITY_ROWS = [
  { label: 'Complete 12-digit code', count: '296,749', pct: '83.9%', color: '#0a7a52' },
  { label: 'Short code (4–11 digits)', count: '48,119', pct: '13.6%', color: '#c2440e' },
  { label: 'No HS code or <4 digits', count: '8,754', pct: '2.5%', color: '#c0392b' },
];

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

// ── Algo steps ────────────────────────────────────────────
const ALGO_STEPS = [
  {
    num: 1,
    title: 'Clean the code',
    desc: (
      <>
        Remove dots, spaces, and any non-numeric characters. Some merchants send codes like{' '}
        <code className="font-mono text-[.78rem]">610.821.00</code> — these become{' '}
        <code className="font-mono text-[.78rem]">61082100</code>.
      </>
    ),
    extra: null,
  },
  {
    num: 2,
    title: 'If shorter than 12 digits, build search keys',
    desc: 'Strip one digit from the right, repeatedly, down to 4 digits. Each shorter version becomes a candidate key to search against the master list.',
    extra: (
      <div className="flex flex-wrap items-center gap-2 mt-3">
        <code className="font-mono text-[.76rem] bg-surface border border-border rounded px-2 py-1 text-accent">61082100</code>
        <span className="text-dim text-sm">→</span>
        {['6108210', '610821', '61082', '6108'].map(k => (
          <code key={k} className="font-mono text-[.76rem] bg-surface border border-border rounded px-2 py-1 text-muted">{k}</code>
        ))}
      </div>
    ),
  },
  {
    num: 3,
    title: 'Look up each candidate in the ZATCA master list',
    desc: 'The system searches the HSCodeMaster table for each candidate key. It returns all 12-digit ZATCA codes that match, along with their Arabic description, duty rate, and a flag for how unit cost should be calculated.',
    extra: null,
  },
  {
    num: 4,
    title: 'Pick the best match',
    desc: "From all results, prefer the one that matched the longest candidate key — meaning the client's original code was the most specific. If two results match equally, prefer the shorter ZATCA code (more general category).",
    extra: null,
  },
  {
    num: 5,
    title: 'Use the top result',
    desc: 'The winning 12-digit code becomes the tariff code sent to ZATCA. Its Arabic name becomes the goods description. Non-Arabic characters are stripped from the description before submission.',
    extra: null,
  },
];

// ── ZATCA XML field types ─────────────────────────────────
type FieldSource = 'client' | 'derived' | 'fixed' | 'mapped';

const sourceStyles: Record<FieldSource, { bg: string; border: string; color: string; label: string }> = {
  client:  { bg: 'rgba(96,165,250,.1)',   border: 'rgba(96,165,250,.25)',  color: '#1d4ed8', label: 'client' },
  derived: { bg: 'rgba(167,139,250,.1)',  border: 'rgba(167,139,250,.25)', color: '#6d28d9', label: 'derived' },
  fixed:   { bg: 'rgba(107,113,144,.15)', border: '#d8dce8',               color: '#546178', label: 'fixed' },
  mapped:  { bg: 'rgba(14,23,41,.06)',    border: 'rgba(30,58,95,.2)',      color: '#1e3a5f', label: 'mapped' },
};

interface XmlField { name: string; value: string; source: FieldSource; note?: string }
interface XmlSec { name: string; tag: string; fields: XmlField[]; delay?: number; wide?: boolean }

const ZATCA_SECTIONS: XmlSec[] = [
  {
    name: '① Reference',
    tag: '<decsub:reference>',
    fields: [
      { name: 'docRefNo',        value: 'Naqel waybill number',                               source: 'client' },
      { name: 'userid / acctId', value: 'Broker credentials',                                  source: 'fixed' },
      { name: 'regPort',         value: 'Port code — looked up per shipment (e.g. 23 = Dubai air gateway)', source: 'mapped' },
    ],
  },
  {
    name: '② Declaration Header',
    tag: '<decsub:declarationHeader>',
    fields: [
      { name: 'declarationType',   value: '2 = Import',          source: 'fixed' },
      { name: 'finalCountry',      value: 'SA',                  source: 'fixed' },
      { name: 'totalNoOfInvoice',  value: 'Count of invoices',   source: 'derived' },
    ],
  },
  {
    name: '③ Invoice',
    tag: '<decsub:invoices>',
    fields: [
      { name: 'invoiceNo',              value: 'Air waybill number',                                    source: 'client' },
      { name: 'invoiceCost',            value: 'DeclaredValue',                                         source: 'client' },
      { name: 'invoiceCurrency',        value: 'SAR=100, AED=120, USD=410… (mapped to numeric ID)',     source: 'mapped' },
      { name: 'totalGrossWeight',       value: 'Waybill weight (kg)',                                   source: 'client' },
      { name: 'sourceCompanyName/No',   value: 'Looked up by port code (not ClientID)',                 source: 'mapped' },
    ],
  },
  {
    name: '④ Invoice Item (HV only)',
    tag: '<decsub:items>',
    fields: [
      { name: 'tariffCode',          value: '12-digit resolved HS code',                   source: 'derived' },
      { name: 'goodsDescription',    value: 'Arabic from HS master (+ appended words)',    source: 'derived' },
      { name: 'countryOfOrigin',     value: 'Client or per-ClientID default',              source: 'mapped' },
      { name: 'itemCost',            value: 'Item amount from invoice',                    source: 'client' },
      { name: 'unitInvoiceCost',     value: 'Only if UnitPerPrice = 1',                   source: 'derived' },
      { name: 'grossWeight / netWeight', value: 'Total weight ÷ item count',              source: 'derived' },
    ],
  },
  {
    name: '⑤ Air Waybill',
    tag: '<decsub:exportAirBL>',
    fields: [
      { name: 'airBLNo',       value: 'Air waybill number',          source: 'client' },
      { name: 'carrierPrefix', value: 'First 3 digits of AWB',       source: 'derived' },
      { name: 'airBLDate',     value: 'Invoice / shipment date',     source: 'client' },
    ],
  },
  {
    name: '⑥ Express Mail Info',
    tag: '<decsub:expressMailInfomation>',
    fields: [
      { name: 'transportID',     value: 'Consignee national ID',                           source: 'client' },
      { name: 'transportIDType', value: '5 if ID starts with 1, else 3',                   source: 'derived' },
      { name: 'name',            value: 'Consignee name',                                  source: 'client' },
      { name: 'city',            value: 'CITY_CD from ZATCA system lookup',                source: 'mapped' },
      { name: 'address',         value: 'Arabic city name (ZATCA system)',                 source: 'mapped' },
      { name: 'zipCode / poBox', value: '1111 / 11 — placeholders ⚠',                    source: 'fixed' },
    ],
  },
  {
    name: '⑦ Declaration Documents',
    tag: '<decsub:declarationDocuments>',
    wide: true,
    fields: [
      { name: 'documentType',    value: '3 = commercial invoice',    source: 'fixed' },
      { name: 'documentNo',      value: 'Air waybill number',        source: 'client' },
      { name: 'documentDate',    value: 'Invoice date',              source: 'client' },
      { name: 'documentSeqNo',   value: 'Sequential (1)',            source: 'derived' },
    ],
  },
];

function ZatcaSection({ sec }: { sec: XmlSec }) {
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
    <Layout chapter="Chapter 02 · Operating model" pageTitle="Current Naqel Process">
      <PageHero
        kicker="Chapter 02 · Operating model"
        title={<>Current Naqel customs <em className="not-italic text-accent">operating model</em></>}
        lede="A working view of the live clearance flow today — handoffs, data inputs, HS code resolution, ZATCA XML structure, and the operational edge cases that shape where AI can help."
      />

      {/* 1. Big Picture */}
      <section id="big-picture" className="px-4 sm:px-8 lg:px-12 py-10 sm:py-14">
        <div className="max-w-[1160px] mx-auto">
          <SectionLabel num="1">Level 1 — The Big Picture</SectionLabel>
          <SectionTitle>Current flow</SectionTitle>
          <SectionDesc>
            Merchant ships a parcel → sends manifest and commercial invoice to Naqel → Naqel submits manifest to
            ZATCA first → on acceptance, builds and submits the declaration → ZATCA issues a{' '}
            <strong className="text-text">Bayan number</strong> (the clearance document).
          </SectionDesc>
          <Reveal className="mt-2 text-center">
            <img
              src="/diagrams/naqel-customs-flow.svg"
              alt="Naqel customs clearance flow — Merchant → Naqel/SPL → ZATCA"
              className="max-w-full h-auto rounded-xl border border-border"
            />
          </Reveal>
        </div>
      </section>

      <Divider />

      {/* 2. HV vs LV */}
      <section id="hvlv" className="px-4 sm:px-8 lg:px-12 py-10 sm:py-14">
        <div className="max-w-[1160px] mx-auto">
          <SectionLabel num="2">Level 2 — HV vs. LV</SectionLabel>
          <SectionTitle>High Value vs. Low Value</SectionTitle>
          <SectionDesc>
            Every shipment is classified as High Value (≥ 1,000 SAR) or Low Value (&lt; 1,000 SAR) based on its
            declared value. Both paths share the same core requirements — the threshold only changes how declarations
            are grouped and what fallbacks are available.
          </SectionDesc>

          <Reveal className="mb-6 bg-card border border-border rounded-xl px-7 py-6">
            <div className="text-[.7rem] uppercase tracking-[.12em] text-accent font-semibold mb-3">
              Applies to both HV &amp; LV
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-[.82rem] text-muted">
              <div>12-digit HS code required per line item</div>
              <div>Arabic description required (sourced from HS code master)</div>
            </div>
            <div className="text-[.76rem] text-dim mt-3">
              How HS codes are resolved is covered in{' '}
              <a href="#hscode" className="text-accent underline underline-offset-[3px]">
                Section 4 — HS Code Resolution
              </a>.
            </div>
          </Reveal>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <HVLVCard
              type="hv"
              threshold="≥ 1,000 SAR"
              badge="⬆ High Value"
              rules={[
                { icon: '📋', text: '1 declaration per shipment — no batching' },
                { icon: '⚖️', text: 'Customs duty applies' },
                { icon: '🚫', text: 'No fallback — every item must have a resolved code' },
              ]}
              delay={0}
            />
            <HVLVCard
              type="lv"
              threshold="< 1,000 SAR"
              badge="⬇ Low Value"
              rules={[
                { icon: '📦', text: 'Multiple shipments batched per declaration' },
                { icon: '⚡', text: 'Simplified clearance — no customs duty' },
                { icon: '🔄', text: 'Fallback available — if no code is provided, defaults to', code: '980300000001' },
              ]}
              delay={100}
            />
          </div>
        </div>
      </section>

      <Divider />

      {/* 3. Data Intake */}
      <section id="intake" className="px-4 sm:px-8 lg:px-12 py-10 sm:py-14">
        <div className="max-w-[1160px] mx-auto">
          <SectionLabel num="3">Level 2 — Data Intake</SectionLabel>
          <SectionTitle>Naqel has two ways to ingest commercial invoices</SectionTitle>
          <SectionDesc>API (SOAP/XML) and XLSX both feed the same engine</SectionDesc>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <ChannelCard
              badge="🔌 API — SOAP/XML"
              title="Programmatic API"
              desc="Enterprise clients integrate directly. The client sends a SOAP CreateWaybill envelope containing shipment + consignee + invoice line items."
              fields={[
                { name: 'WaybillNo / RefNo',           val: 'tracking + reference',               status: 'req' },
                { name: 'ConsigneeName',                val: 'recipient name',                     status: 'req' },
                { name: 'ConsigneeAddress / City',      val: 'full delivery address',              status: 'req' },
                { name: 'MobileNo / Email',             val: 'consignee contact',                  status: 'req' },
                { name: 'Description',                  val: 'English item description',           status: 'req' },
                { name: 'CustomsCommodityCode',         val: 'client HS code (may be incomplete)', status: 'req' },
                { name: 'UnitCost / Currency',          val: 'item value + currency',              status: 'req' },
                { name: 'DeclareValue',                 val: 'total declared customs value',       status: 'req' },
                { name: 'Weight',                       val: 'shipment weight',                    status: 'req' },
                { name: 'CODCharge / GoodsVATAmount',   val: 'operational flags',                  status: 'req' },
                { name: 'IsCustomDutyPayByConsignee',   val: 'duty payment instruction',           status: 'req' },
              ]}
              delay={0}
            />
            <ChannelCard
              badge="📊 Excel Upload — XLSX"
              title="Web Portal Upload"
              desc="Smaller clients upload a standardised spreadsheet. The template only captures commercial invoice line-item data — it is a subset of what the API carries."
              fields={[
                { name: 'WaybillNo',           val: 'tracking number',          status: 'req' },
                { name: 'ConsigneeName',        val: '—',                        status: 'miss' },
                { name: 'ConsigneeAddress',     val: '—',                        status: 'miss' },
                { name: 'MobileNo / Email',     val: '—',                        status: 'miss' },
                { name: 'Description',          val: 'English item description', status: 'req' },
                { name: 'CustomsCommodityCode', val: 'client HS code',           status: 'req' },
                { name: 'UnitCost / CurrencyCode', val: 'item value',            status: 'req' },
                { name: 'DeclaredValue',        val: 'total value',              status: 'req' },
                { name: 'Weight',               val: '—',                        status: 'miss' },
                { name: 'CODCharge / VAT flags', val: '—',                       status: 'miss' },
                { name: 'SKU / CPC',            val: 'optional reference fields', status: 'opt' },
              ]}
              delay={150}
              side="right"
            />
          </div>

          <EngineBox />
        </div>
      </section>

      <Divider />

      {/* 4. HS Code Resolution */}
      <section id="hscode" className="px-4 sm:px-8 lg:px-12 py-10 sm:py-14">
        <div className="max-w-[1160px] mx-auto">
          <SectionLabel num="4">Level 3 — HS Code Resolution</SectionLabel>
          <SectionTitle>How Naqel resolves the HS codes</SectionTitle>
          <SectionDesc>
            Each item needs a valid 12-digit ZATCA tariff code. Clients submit codes of varying quality — findings
            below are based on analysis of <strong className="text-text">353,623 line items</strong> across{' '}
            <strong className="text-text">31,017 waybills</strong>.
          </SectionDesc>

          <HSQualityTable />

          {/* Algo layout */}
          <div className="grid gap-8 grid-cols-1 xl:grid-cols-2">
            {/* Left: algo steps */}
            <div className="flex flex-col gap-5">
              {ALGO_STEPS.map((step, i) => (
                <Reveal key={step.num} delay={i * 80}>
                  <div className="bg-card border border-border rounded-[13px] p-6">
                    <div
                      className="font-mono text-[.58rem] tracking-[.12em] uppercase mb-2"
                      style={{ color: '#2d5a8e' }}
                    >
                      Step {step.num}
                    </div>
                    <div className="font-sans font-bold text-text text-[.92rem] mb-2">{step.title}</div>
                    <div className="text-[.82rem] text-muted leading-[1.65]">{step.desc}</div>
                    {step.extra}
                  </div>
                </Reveal>
              ))}

              {/* Warnings */}
              <Reveal delay={450}>
                <div className="bg-card border border-border rounded-[13px] p-5" style={{ background: 'rgba(251,146,60,.04)', borderColor: 'rgba(251,146,60,.25)' }}>
                  <div className="font-mono text-[.6rem] text-orange tracking-[.1em] uppercase mb-2">⚠ Arabic description rule</div>
                  <div className="text-[.8rem] text-muted leading-[1.65]">
                    ZATCA rejects descriptions that word-for-word match the official tariff text. Workaround: extra words are appended manually before submission.
                  </div>
                </div>
              </Reveal>
              <Reveal delay={500}>
                <div className="bg-card border border-border rounded-[13px] p-5" style={{ background: 'rgba(251,146,60,.04)', borderColor: 'rgba(251,146,60,.25)' }}>
                  <div className="font-mono text-[.6rem] text-orange tracking-[.1em] uppercase mb-2">⚠ Country of origin</div>
                  <div className="text-[.8rem] text-muted leading-[1.65]">
                    The ZATCA XML <code className="font-mono text-[.75rem] bg-surface border border-border rounded px-1 py-0.5">countryOfOrigin</code> field is derived from a{' '}
                    <em>client-level</em> lookup table (<code className="font-mono text-[.75rem] bg-surface border border-border rounded px-1 py-0.5">CountryOfOriginClientMapping</code>),
                    not from the per-item <code className="font-mono text-[.75rem] bg-surface border border-border rounded px-1 py-0.5">CountryofManufacture</code> field on the invoice.
                    All items from the same client get the same origin country — even when individual items originate from different countries.
                  </div>
                </div>
              </Reveal>
            </div>

            {/* Right: worked example */}
            <Reveal delay={200}>
              <div className="bg-card border border-border rounded-[14px] p-4 sm:p-7 xl:sticky xl:top-[100px] xl:self-start">
                <div className="font-mono text-[.6rem] text-muted tracking-[.1em] uppercase mb-5">
                  Worked example — clothing item (from HS Code Mapping Logic file)
                </div>

                {/* Row: client sends */}
                <div className="mb-4 pb-4 border-b border-border">
                  <div className="font-mono text-[.62rem] text-dim uppercase tracking-[.08em] mb-1">Client sends</div>
                  <div className="font-mono text-[.82rem]">
                    CustomsCommodityCode: <span className="text-accent font-bold">610.821.00</span>
                  </div>
                  <div className="text-[.72rem] text-muted mt-1">Dot-formatted, 8 digits — incomplete</div>
                </div>

                {/* Row: Step 1 */}
                <div className="mb-4 pb-4 border-b border-border">
                  <div className="font-mono text-[.62rem] text-dim uppercase tracking-[.08em] mb-1">Step 1 — Clean</div>
                  <div className="font-mono text-[.82rem]">
                    <span className="text-accent">610.821.00</span>
                    {' → '}
                    <span className="text-green font-bold">61082100</span>
                    {' '}(dots removed)
                  </div>
                </div>

                {/* Row: Step 2 */}
                <div className="mb-4 pb-4 border-b border-border">
                  <div className="font-mono text-[.62rem] text-dim uppercase tracking-[.08em] mb-1">Step 2 — Search keys</div>
                  <div className="font-mono text-[.78rem] leading-[2.1] flex flex-wrap gap-x-2">
                    {['61082100', '6108210', '610821', '61082', '6108'].map(k => (
                      <span key={k} className="text-accent">{k}</span>
                    ))}
                  </div>
                </div>

                {/* Row: lookup table */}
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
                        <tr className="text-green font-bold">
                          <td className="pr-2 py-0.5">610821000000</td>
                          <td className="pr-2">ـ ـ من قطن</td>
                          <td className="pr-2">5%</td>
                          <td>61082100 ← picked</td>
                        </tr>
                        {[
                          ['610822000000', 'من ألياف تركيبية', '5%', '61082'],
                          ['610829000000', 'من مواد نسجية أُخر', '5%', '61082'],
                          ['610831000000', 'ـ ـ من قطن', '5%', '6108'],
                          ['610832000001', 'قمصان للنوم', '5%', '6108'],
                        ].map(([code, desc, duty, key]) => (
                          <tr key={code} className="text-dim">
                            <td className="pr-2 py-0.5">{code}</td>
                            <td className="pr-2">{desc}</td>
                            <td className="pr-2">{duty}</td>
                            <td>{key}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="text-[.7rem] text-muted leading-[1.6] mt-2">
                    The lookup returns <strong className="text-text">21 candidates</strong> across all 5 search keys. Sorted by longest matching key (DESC) then shortest HS code (ASC) — picks the first row.
                  </div>
                </div>

                {/* Row: result */}
                <div className="mb-4 pb-4 border-b border-border">
                  <div className="font-mono text-[.62rem] text-dim uppercase tracking-[.08em] mb-1">Result</div>
                  <div className="font-mono text-[.82rem]">tariffCode: <span className="text-green font-bold">610821000000</span></div>
                  <div className="font-mono text-[.82rem] mt-1">goodsDescription: <span className="text-muted">ـ ـ من قطن</span></div>
                  <span
                    className="inline-block mt-2 font-mono text-[.62rem] tracking-[.06em] px-[.7rem] py-[.25rem] rounded"
                    style={{ background: 'rgba(52,211,153,.1)', border: '1px solid rgba(52,211,153,.25)', color: '#0a7a52' }}
                  >
                    ✓ Clean resolution — one candidate, unambiguous
                  </span>
                </div>

                {/* Blue note */}
                <div className="rounded-[10px] p-4 mt-1" style={{ background: 'rgba(96,165,250,.05)', border: '1px solid rgba(96,165,250,.2)' }}>
                  <div className="font-mono text-[.6rem] text-blue tracking-[.1em] uppercase mb-1">✓ Complete code — no algorithm needed</div>
                  <div className="text-[.72rem] text-muted leading-[1.65]">
                    If the client sends a full 12-digit code like <strong className="text-text">851713000000</strong> (smartphones, exempted), the system uses it directly. Step 1 only runs to strip any dots — no search needed.
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
              {[
                {
                  pct: '83.9%',
                  color: '#0a7a52',
                  title: 'Complete 12-digit code',
                  today: 'Normalised and passed through as-is. No validation against the item description. ZATCA does not auto-reject mismatches — but customs staff may manually reject in rare cases (confirmed by Naqel team).',
                  ai: 'Pre-submission validation — cross-check the code against the item description and flag mismatches before ZATCA submission. This catches the silent errors the current system cannot detect.',
                },
                {
                  pct: '13.6%',
                  color: '#c2440e',
                  title: 'Short code (4–11 digits)',
                  today: 'Prefix algorithm (Steps 1–5 above) finds candidates in HSCodeMaster, picks the first match by table order. Item description is ignored. If 5 valid leaf codes share the same prefix, the algorithm always picks the first — regardless of what the item actually is.',
                  ai: <>Disambiguation — AI reads the item description and selects the correct leaf code instead of defaulting to table order. e.g. client sends <code className="font-mono text-[.75rem] text-blue">62046200</code>, system finds 5 matches (trousers, shorts, overalls…) — AI picks the right one.</>,
                },
                {
                  pct: '2.5%',
                  color: '#c0392b',
                  title: 'No HS code or <4 digits',
                  today: <>The gateway team identifies the closest HS code based on the goods description — and in rare cases physically inspects the item. The code is submitted directly through the ZATCA portal, <strong className="text-text">bypassing InfoTrack entirely</strong>. The corrected code lives only in ZATCA/Bayan and is never written back upstream. For LV shipments, the fallback code <code className="font-mono text-[.78rem]">980300000001</code> is used instead.</>,
                  ai: 'Classification from scratch — AI classifies from the item description alone, eliminating the manual gateway portal workaround and keeping the corrected code in the data pipeline.',
                },
              ].map((row) => (
                <Reveal key={row.pct}>
                  <div className="bg-card border border-border rounded-[14px] px-7 py-6">
                    <div className="flex items-center gap-3 mb-3">
                      <span className="font-mono text-[1rem] font-bold" style={{ color: row.color }}>{row.pct}</span>
                      <span className="text-[.85rem] font-semibold text-text">{row.title}</span>
                    </div>
                    <div className="text-[.82rem] text-muted leading-[1.65] mb-4">
                      <strong className="text-text">Today:</strong>{' '}{row.today}
                    </div>
                    <div className="bg-surface border border-border rounded-[8px] px-4 py-3 text-[.78rem] text-text">
                      <strong className="text-accent">AI opportunity:</strong>{' '}{row.ai}
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
          <SectionLabel num="5">Level 3 — ZATCA XML Structure</SectionLabel>
          <SectionTitle>What gets sent <em className="not-italic text-accent">to Saudi Customs</em></SectionTitle>
          <SectionDesc>
            XML declaration. 7 sections — fields come from the client, system derivation, lookup tables, or hardcoded constants.
          </SectionDesc>

          {/* Legend */}
          <Reveal className="flex flex-wrap gap-5 mb-8">
            {(Object.entries(sourceStyles) as [FieldSource, typeof sourceStyles[FieldSource]][]).map(([, s]) => (
              <div key={s.label} className="flex items-center gap-2 text-[.78rem] text-muted font-mono">
                <span
                  className="w-[10px] h-[10px] rounded-[3px] inline-block"
                  style={{ background: s.bg, border: `1px solid ${s.border}` }}
                />
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
        <PageNav
          prev={{ to: '/',             label: 'Product Definition' }}
          next={{ to: '/architecture', label: 'Technical Architecture' }}
        />
      </div>
    </Layout>
  );
}
