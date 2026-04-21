// ─── Process — Content (single source of truth) ─────────
// Edit HERE → TSX page + generated markdown both update.

export const PAGE = {
  chapter: 'Chapter 02 · Operating model',
  pageTitle: 'Current Naqel Process',
  hero: {
    kicker: 'Chapter 02 · Operating model',
    title: 'Current Naqel customs operating model',
    titleAccent: 'operating model',
    lede: "A working view of the live clearance flow today — handoffs, data inputs, HS code resolution, ZATCA XML structure, and the operational edge cases that shape where AI can help.",
  },
};

// ── Section 1: Big Picture ──
export const BIG_PICTURE = {
  num: '1',
  label: 'Level 1 — The Big Picture',
  title: 'Current flow',
  desc: 'Merchant ships a parcel → sends manifest and commercial invoice to Naqel → Naqel submits manifest to ZATCA first → on acceptance, builds and submits the declaration → ZATCA issues a **Bayan number** (the clearance document).',
  diagram: '/diagrams/naqel-customs-flow.svg',
  diagramAlt: 'Naqel customs clearance flow — Merchant → Naqel/SPL → ZATCA',
};

// ── Section 2: HV vs LV ──
export const HVLV = {
  num: '2',
  label: 'Level 2 — HV vs. LV',
  title: 'High Value vs. Low Value',
  desc: 'Every shipment is classified as High Value (≥ 1,000 SAR) or Low Value (< 1,000 SAR) based on its declared value. Both paths share the same core requirements — the threshold only changes how declarations are grouped and what fallbacks are available.',
  shared: [
    '12-digit HS code required per line item',
    'Arabic description required (sourced from HS code master)',
  ],
  sharedNote: 'How HS codes are resolved is covered in Section 4 — HS Code Resolution.',
  hv: {
    threshold: '≥ 1,000 SAR',
    badge: '⬆ High Value',
    rules: [
      { icon: '📋', text: '1 declaration per shipment — no batching' },
      { icon: '⚖️', text: 'Customs duty applies' },
      { icon: '🚫', text: 'No fallback — every item must have a resolved code' },
    ],
  },
  lv: {
    threshold: '< 1,000 SAR',
    badge: '⬇ Low Value',
    rules: [
      { icon: '📦', text: 'Multiple shipments batched per declaration' },
      { icon: '⚡', text: 'Simplified clearance — no customs duty' },
      { icon: '🔄', text: 'Fallback available — if no code is provided, defaults to `980300000001`' },
    ],
  },
};

// ── Section 3: Data Intake ──
export interface FieldRow {
  name: string;
  val: string;
  status: 'req' | 'miss' | 'opt';
}

export const DATA_INTAKE = {
  num: '3',
  label: 'Level 2 — Data Intake',
  title: 'Naqel has two ways to ingest commercial invoices',
  desc: 'API (SOAP/XML) and XLSX both feed the same engine',
  channels: [
    {
      badge: '🔌 API — SOAP/XML',
      title: 'Programmatic API',
      desc: 'Enterprise clients integrate directly. The client sends a SOAP CreateWaybill envelope containing shipment + consignee + invoice line items.',
      fields: [
        { name: 'WaybillNo / RefNo',           val: 'tracking + reference',               status: 'req' as const },
        { name: 'ConsigneeName',                val: 'recipient name',                     status: 'req' as const },
        { name: 'ConsigneeAddress / City',      val: 'full delivery address',              status: 'req' as const },
        { name: 'MobileNo / Email',             val: 'consignee contact',                  status: 'req' as const },
        { name: 'Description',                  val: 'English item description',           status: 'req' as const },
        { name: 'CustomsCommodityCode',         val: 'client HS code (may be incomplete)', status: 'req' as const },
        { name: 'UnitCost / Currency',          val: 'item value + currency',              status: 'req' as const },
        { name: 'DeclareValue',                 val: 'total declared customs value',       status: 'req' as const },
        { name: 'Weight',                       val: 'shipment weight',                    status: 'req' as const },
        { name: 'CODCharge / GoodsVATAmount',   val: 'operational flags',                  status: 'req' as const },
        { name: 'IsCustomDutyPayByConsignee',   val: 'duty payment instruction',           status: 'req' as const },
      ],
    },
    {
      badge: '📊 Excel Upload — XLSX',
      title: 'Web Portal Upload',
      desc: 'Smaller clients upload a standardised spreadsheet. The template only captures commercial invoice line-item data — it is a subset of what the API carries.',
      fields: [
        { name: 'WaybillNo',               val: 'tracking number',           status: 'req' as const },
        { name: 'ConsigneeName',            val: '—',                        status: 'miss' as const },
        { name: 'ConsigneeAddress',         val: '—',                        status: 'miss' as const },
        { name: 'MobileNo / Email',         val: '—',                        status: 'miss' as const },
        { name: 'Description',              val: 'English item description', status: 'req' as const },
        { name: 'CustomsCommodityCode',     val: 'client HS code',           status: 'req' as const },
        { name: 'UnitCost / CurrencyCode',  val: 'item value',              status: 'req' as const },
        { name: 'DeclaredValue',            val: 'total value',              status: 'req' as const },
        { name: 'Weight',                   val: '—',                        status: 'miss' as const },
        { name: 'CODCharge / VAT flags',    val: '—',                        status: 'miss' as const },
        { name: 'SKU / CPC',               val: 'optional reference fields', status: 'opt' as const },
      ],
    },
  ],
};

export const ENGINE_STEPS = [
  { num: '01', name: 'HV/LV Classify',      desc: 'Apply 1,000 SAR threshold — route to generic code or full HS resolution' },
  { num: '02', name: 'Resolve HS Code',     desc: 'Normalize format, complete to 12 digits via lookup table + algorithm' },
  { num: '03', name: 'Map Lookups',         desc: 'Currency ISO → ZATCA system ID. Station → ZATCA city code + Arabic name.' },
  { num: '04', name: 'Arabic Description',  desc: 'Pull Arabic goods description from HS master. Append words to avoid exact ZATCA match rejection.' },
  { num: '05', name: 'Build & Submit XML',  desc: 'Assemble ZATCA XML, submit to ZATCA system via H2H interface, receive Bayan number' },
];

// ── Section 4: HS Code Resolution ──
export const HS_CODE_SECTION = {
  num: '4',
  label: 'Level 3 — HS Code Resolution',
  title: 'How Naqel resolves the HS codes',
  desc: 'Each item needs a valid 12-digit ZATCA tariff code. Clients submit codes of varying quality — findings below are based on analysis of **353,623 line items** across **31,017 waybills**.',
};

export const HS_QUALITY_ROWS = [
  { label: 'Complete 12-digit code', count: '296,749', pct: '83.9%', color: '#2E7D57' },
  { label: 'Short code (4–11 digits)', count: '48,119', pct: '13.6%', color: '#EA6A1F' },
  { label: 'No HS code or <4 digits', count: '8,754', pct: '2.5%', color: '#94421C' },
];

export const ALGO_STEPS = [
  {
    num: 1,
    title: 'Clean the code',
    desc: 'Remove dots, spaces, and any non-numeric characters. Some merchants send codes like `610.821.00` — these become `61082100`.',
    searchKeys: null,
  },
  {
    num: 2,
    title: 'If shorter than 12 digits, build search keys',
    desc: 'Strip one digit from the right, repeatedly, down to 4 digits. Each shorter version becomes a candidate key to search against the master list.',
    searchKeys: ['61082100', '6108210', '610821', '61082', '6108'],
  },
  {
    num: 3,
    title: 'Look up each candidate in the ZATCA master list',
    desc: 'The system searches the HSCodeMaster table for each candidate key. It returns all 12-digit ZATCA codes that match, along with their Arabic description, duty rate, and a flag for how unit cost should be calculated.',
    searchKeys: null,
  },
  {
    num: 4,
    title: 'Pick the best match',
    desc: "From all results, prefer the one that matched the longest candidate key — meaning the client's original code was the most specific. If two results match equally, prefer the shorter ZATCA code (more general category).",
    searchKeys: null,
  },
  {
    num: 5,
    title: 'Use the top result',
    desc: 'The winning 12-digit code becomes the tariff code sent to ZATCA. Its Arabic name becomes the goods description. Non-Arabic characters are stripped from the description before submission.',
    searchKeys: null,
  },
];

export const WARNINGS = [
  {
    tag: 'Arabic description rule',
    body: 'ZATCA rejects descriptions that word-for-word match the official tariff text. Workaround: extra words are appended manually before submission.',
  },
  {
    tag: 'Country of origin',
    body: 'The ZATCA XML `countryOfOrigin` field is derived from a *client-level* lookup table (`CountryOfOriginClientMapping`), not from the per-item `CountryofManufacture` field on the invoice. All items from the same client get the same origin country — even when individual items originate from different countries.',
  },
];

// ── AI Opportunities ──
export const AI_OPPORTUNITIES = [
  {
    pct: '83.9%',
    color: '#2E7D57',
    title: 'Complete 12-digit code',
    today: 'Normalised and passed through as-is. No validation against the item description. ZATCA does not auto-reject mismatches — but customs staff may manually reject in rare cases (confirmed by Naqel team).',
    ai: "Pre-submission validation — cross-check the code against the item description and flag mismatches before ZATCA submission. This catches the silent errors the current system cannot detect.",
  },
  {
    pct: '13.6%',
    color: '#EA6A1F',
    title: 'Short code (4–11 digits)',
    today: "Prefix algorithm (Steps 1–5 above) finds candidates in HSCodeMaster, picks the first match by table order. Item description is ignored. If 5 valid leaf codes share the same prefix, the algorithm always picks the first — regardless of what the item actually is.",
    ai: "Disambiguation — AI reads the item description and selects the correct leaf code instead of defaulting to table order. e.g. client sends `62046200`, system finds 5 matches (trousers, shorts, overalls…) — AI picks the right one.",
  },
  {
    pct: '2.5%',
    color: '#94421C',
    title: 'No HS code or <4 digits',
    today: "The gateway team identifies the closest HS code based on the goods description — and in rare cases physically inspects the item. The code is submitted directly through the ZATCA portal, **bypassing InfoTrack entirely**. The corrected code lives only in ZATCA/Bayan and is never written back upstream. For LV shipments, the fallback code `980300000001` is used instead.",
    ai: 'Classification from scratch — AI classifies from the item description alone, eliminating the manual gateway portal workaround and keeping the corrected code in the data pipeline.',
  },
];

// ── Section 5: ZATCA XML ──
export type FieldSource = 'client' | 'derived' | 'fixed' | 'mapped';

export interface XmlField {
  name: string;
  value: string;
  source: FieldSource;
  note?: string;
}

export interface XmlSection {
  name: string;
  tag: string;
  fields: XmlField[];
  wide?: boolean;
}

export const ZATCA_SECTION = {
  num: '5',
  label: 'Level 3 — ZATCA XML Structure',
  title: 'What gets sent to Saudi Customs',
  desc: 'XML declaration. 7 sections — fields come from the client, system derivation, lookup tables, or hardcoded constants.',
};

export const SOURCE_LABELS: Record<FieldSource, string> = {
  client: 'client',
  derived: 'derived',
  fixed: 'fixed',
  mapped: 'mapped',
};

export const ZATCA_SECTIONS: XmlSection[] = [
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

// ── Worked Example ──
export const WORKED_EXAMPLE = {
  title: 'Worked example — clothing item (from HS Code Mapping Logic file)',
  clientSends: { code: '610.821.00', note: 'Dot-formatted, 8 digits — incomplete' },
  step1: { from: '610.821.00', to: '61082100', note: 'dots removed' },
  searchKeys: ['61082100', '6108210', '610821', '61082', '6108'],
  lookupNote: 'The lookup returns **21 candidates** across all 5 search keys. Sorted by longest matching key (DESC) then shortest HS code (ASC) — picks the first row.',
  lookupRows: [
    { code: '610821000000', desc: 'ـ ـ من قطن',       duty: '5%', key: '61082100 ← picked', picked: true },
    { code: '610822000000', desc: 'من ألياف تركيبية',  duty: '5%', key: '61082',             picked: false },
    { code: '610829000000', desc: 'من مواد نسجية أُخر', duty: '5%', key: '61082',             picked: false },
    { code: '610831000000', desc: 'ـ ـ من قطن',       duty: '5%', key: '6108',              picked: false },
    { code: '610832000001', desc: 'قمصان للنوم',       duty: '5%', key: '6108',              picked: false },
  ],
  result: { tariffCode: '610821000000', goodsDescription: 'ـ ـ من قطن', badge: '✓ Clean resolution — one candidate, unambiguous' },
  completeCodeNote: 'If the client sends a full 12-digit code like `851713000000` (smartphones, exempted), the system uses it directly. Step 1 only runs to strip any dots — no search needed.',
};

// ── Navigation ──
export const NAV = {
  prev: { to: '/',             label: 'Product Definition' },
  next: { to: '/architecture', label: 'Technical Architecture' },
};
