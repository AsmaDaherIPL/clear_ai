// ─── Architecture — Content (single source of truth) ─────
// Edit HERE → TSX page + generated markdown both update.

export const PAGE = {
  chapter: 'Chapter 03 · Engineering',
  pageTitle: 'Technical Architecture',
  hero: {
    kicker: 'Chapter 03 · Engineering',
    title: 'Technical architecture',
    titleAccent: 'architecture',
    lede: "The architecture separates concerns cleanly: where data enters, where AI works, where Saudi rules apply, where human review happens, and where output goes. Toggle between V1 (shipping) and V2 (planned) on the tabs below.",
  },
};

export const SYSTEM_ARCH = {
  num: '03',
  label: 'Architecture',
  title: 'System Architecture',
  desc: 'V1 is the MVP — single-machine, batch processing, proving the pipeline works end-to-end against Naqel\'s real invoice and tariff data. V2 is the production-grade system with API access, multi-tenant scale, and closed-loop learning.',
};

// ── Section A: Algorithm ──
export const ALGORITHM = {
  sectionLabel: 'A',
  sectionName: 'Resolution Algorithm',
  title: 'How a shipment row becomes a precise 12-digit Saudi HS code',
  desc: "Clear AI is a precise HS classifier — its job is to resolve a merchant's incomplete, wrong-jurisdiction, or missing HS code into the correct 12-digit Saudi ZATCA code. Each line item is classified by aggregating evidence from multiple signals: the merchant's declared code (if any), the product description in English/Arabic/Chinese, prefix candidates from the Saudi tariff master (19,138 codes), semantic candidates from a FAISS index over master descriptions, and an operational hint from Naqel's historical bucket-mapping ledger. A deterministic rule handles the easy cases; an LLM Reasoner adjudicates the ambiguous ones. The ledger is an input signal, not an oracle.",
  rationale: {
    title: 'Why evidence-aggregation beats short-circuit lookups',
    intro: "An earlier draft of this architecture treated Naqel's ledger as an authoritative cache — if the merchant's code matched a ledger entry, return the mapped code and stop. That design was wrong. Naqel's ledger encodes an automated bucket-mapping used for consolidated express clearance — the same Saudi code appears under 7 different merchant-code prefixes (e.g. 620442000000 reused 137×). Replaying that mapping makes Clear AI a re-implementation of Naqel's operational shortcut, not a real classifier. The resolver aggregates evidence instead.",
    points: [
      {
        heading: 'Signal 1 — Direct master match.',
        body: "When the merchant supplies a full 12-digit code that exists in HSCodeMaster, and the description is coherent with that code's Arabic tariff name and duty rate, the classification is effectively solved. This path handles the clean-data majority with zero inference cost.",
      },
      {
        heading: 'Signal 2 — Longest-prefix-wins traversal.',
        body: "Partial codes (4–11 digits) are common in merchant invoices. The system generates prefix variants by stripping digits from the right and joins each against HSCodeMaster, ordered by LEN(ClientHSCode) DESC, LEN(HSCode) ASC, taking the first row. This is Naqel's production algorithm — fully deterministic, no model call needed. It replaced the originally-planned Ranker LLM path.",
      },
      {
        heading: 'Signal 3 — FAISS semantic retrieval.',
        body: "An IndexFlatIP over L2-normalized MiniLM-L6-v2 embeddings of the 19,138 master descriptions returns top-K candidates by cosine similarity. Used as an independent corroborating signal alongside prefix matches, and as the primary candidate source when no usable merchant code is provided. Qualitative testing showed strong out-of-the-box performance — 'wireless bluetooth earbuds' → 'wireless headphones' at 0.73 cosine.",
      },
      {
        heading: "Signal 4 — Naqel's ledger as a hint, not a gate.",
        body: "If the merchant's code prefix maps to a Naqel bucket, that bucket code is surfaced to the Reasoner as 'Naqel's operations team historically declares code X for items like this.' It's weighted but not decisive. When the Reasoner's best classification disagrees with the bucket, both are recorded and the divergence is surfaced for review.",
      },
      {
        heading: 'The Reasoner aggregates evidence, not guesses blind.',
        body: "When signals diverge or the merchant data is too thin for deterministic resolution, a strong LLM (Opus via API, or a local fallback) is called with a structured evidence bundle — declared code, descriptions in all available languages, prefix candidates, FAISS candidates, ledger hint, and duty-rate context. It returns a 12-digit code, a confidence score, a rationale, and an explicit agrees_with_naqel flag.",
      },
      {
        heading: 'Confidence gating closes the loop.',
        body: "Below the configured threshold (default 0.75), rows route to review.csv. High-confidence classifications that nonetheless diverge from Naqel's bucket are also surfaced — those are the highest-value human-review items. Verified decisions write back into the Decision Ledger, making it a true institutional knowledge base rather than a replay cache.",
      },
    ],
  },
  diagram: '/diagrams/v1-flow-algorithm..excalidraw.svg',
  diagramAlt: 'V1 Algorithm — HS Code Resolution Flow',
};

// ── Section B: Deployment ──
export const DEPLOYMENT = {
  sectionLabel: 'B',
  sectionName: 'V1 Deployment',
  title: 'Single-machine Python CLI, Anthropic API, model tiering per task',
  desc: "A single-machine Python CLI with SQLite for lookups, FAISS for semantic search, and the Anthropic API for the rare inference calls. V1 is API-only — no local inference, no Ollama. Phase 1 (foundation & data layer) is complete: 9 SQLite tables loaded from Naqel's xlsx mapping files, FAISS index built over the full ZATCA tariff master, and a streaming invoice parser validated against the real 30MB / 353k-row sample file. Phase 2 (resolution engine) is the current focus.",
  rationale: {
    title: 'Why a single-machine Python CLI calling an API',
    intro: "V1 is intentionally simple — a Python CLI on a single machine, no UI, no self-hosted services. The only external dependency at runtime is the Anthropic API for the rare inference calls. This is a deliberate choice to keep the feedback loop tight while classification quality is being validated against ground truth, and to avoid committing to infrastructure (GPU rigs, model hosting) for a requirement V1 doesn't actually have.",
    points: [
      {
        heading: 'Python is the right language despite an Azure / C# / React destination.',
        body: "The classification core depends on FAISS, sentence-transformers, and the Anthropic SDK — none of which have first-class C# equivalents. Rewriting them is a multi-quarter detour for zero functional gain. The clean migration path is a Python-based classification service (Azure Functions Python runtime) behind a REST boundary, with the customer-facing app in React/C#. V1 builds that core in pure Python with no web framework coupling, so the REST wrapper is additive later.",
      },
      {
        heading: 'Three-tier model split, not backend switching.',
        body: "V1 is API-only. The flexibility axis is per-task model tiering — three clearly-separable tasks, three tiers, matched by narrowness: Haiku handles Arabic description translation (narrowest — tariff terminology lookup), Sonnet handles candidate ranking from a prefix shortlist (comparison judgement), Opus handles the full Reasoner path inferring a 12-digit code from description alone (genuine reasoning under GRI rules, only ~2.5% of rows). Each LLM call site picks its tier by task — no dynamic routing, no retry-on-low-confidence logic, no heuristic content classifiers. Override any tier via env:",
        code: 'TRANSLATION_MODEL · RANKER_MODEL · REASONER_MODEL',
      },
      {
        heading: 'Why three tiers and not just two.',
        body: "Earlier drafts used a two-tier split — cheap Ranker (Sonnet) for narrow tasks, strong Reasoner (Opus) for hard ones — with Arabic translation bundled under Ranker. On closer look, translation is meaningfully narrower than ranking and is likely the most frequently-called LLM site in the pipeline (every row that needs a fallback Arabic description). Running it on Sonnet works, but pays a Sonnet price for what Haiku handles reliably at roughly an order of magnitude lower cost. Three tiers stays boring (one env var per task, one default per env var), captures the real cost structure of the workload, and leaves the harder optimizations (confidence-based routing, content heuristics) off the table until V1 cost data justifies them.",
      },
      {
        heading: "Local inference was dropped from V1 scope.",
        body: "V1 isn't an offline/air-gapped deployment. Data residency is solved more cleanly at the API-vendor layer (regional endpoints / Bedrock) than by hosting open-source 70B models on a separate rig. Running a local inference server adds real operational complexity (GPU provisioning, model pulls, warm-keeping) and the accuracy ceiling of available open-source models is still measurably below Opus on the hardest classification cases. The HSReasoner interface still supports a second implementation if a future deployment genuinely requires offline inference — we'd reinstate local then, as a separate justified decision, not as speculative insurance now.",
      },
      {
        heading: 'SQLite is the right store for V1 at this scale.',
        body: "The HSCodeMaster is 19,138 rows, tabdul_city is ~1,000 unique entries, and the other six mapping tables are each under a few thousand rows. A single embedded SQLite file gives indexed prefix lookups (idx_master_prefix4, idx_master_prefix6), ACID writes for the ledger, and zero operational overhead. Concurrent multi-tenant access is a V2 problem — PostgreSQL becomes justified then, not before.",
      },
      {
        heading: 'Paths resolve against project root, not caller cwd.',
        body: "All file-path config vars run through a _get_path() helper that resolves relative paths against the directory containing config.py. Running db/setup.py from inside the db/ subdirectory produces the same clear_ai.db as running it from the project root. Absolute paths in env still win for deployment overrides.",
      },
      {
        heading: 'FAISS is built once at setup, loaded into memory at runtime.',
        body: "IndexFlatIP with L2-normalized MiniLM-L6-v2 embeddings gives cosine similarity scores in [-1, 1] — easier for the Reasoner to interpret than raw L2 distance. The 19,138-vector, 384-dim index is under 30MB on disk and loads instantly. hs_codes.json stores the parallel code list plus the embedding model name and dimension for versioning.",
      },
      {
        heading: 'The streaming invoice parser was validated against real data, not a 100-row probe.',
        body: "openpyxl read_only + iter_rows(values_only=True) handled the full 30MB / 353,622-row / 31,017-waybill sample without blowing memory. A pandas.read_excel approach would have OOM'd. The initial data probe suggested 50k rows; the real file is 7× larger — resource planning for Phase 3 (particularly LLM call budget) is sized to the real number.",
      },
      {
        heading: 'The comparator exists for operational trust, not test coverage.',
        body: "comparator.py diffs Clear AI's XML output against Naqel's baseline declarations field-by-field. The real ZATCA/SaudiEDI schema — SOAP-style namespaces (decsub, deccm, sau, cm, deckey), tags like tariffCode and goodsDescription — was extracted from five baseline XMLs Naqel provided and encoded as a Jinja2 template with a 27-entry BAYAN_CONSTANTS dict. The comparator is how the operations team audits agreement, disagreement, and improvement before any switchover.",
      },
    ],
  },
  diagram: '/diagrams/v1-deployment.svg',
  diagramAlt: 'V1 MVP — Single-machine deployment. Python CLI reads merchant invoice, resolves HS codes via SQLite lookups + FAISS semantic search, calls Anthropic API on a three-tier model split: Haiku (TRANSLATION_MODEL) for Arabic translation fallback, Sonnet (RANKER_MODEL) for candidate ranking when prefix matches are ambiguous, Opus (REASONER_MODEL) for full HS inference when deterministic paths fail. Emits Bayan XML + review.csv + audit.log.',
};

// ── V2 ──
export const V2 = {
  title: 'V2 Architecture',
  desc: 'V2 is the production-grade system with API access, multi-tenant data isolation, and closed-loop learning. Architecture design is in progress.',
  plannedItems: [
    'Azure Functions Python runtime behind a REST boundary',
    'Multi-tenant data split: shared classification DB (ZATCA tariff, country/currency) + per-tenant DB (ledger, source-company mappings) with tenant_id scoping',
    'PostgreSQL + pgvector replacing SQLite + FAISS when concurrent access is justified',
    'React / C# customer-facing app consuming the classification service',
    'Closed-loop learning — verified human reviews continuously feed the Decision Ledger and refine the Reasoner prompt / candidate weighting',
    'Bucket-divergence analytics — when Clear AI and Naqel\'s bucket disagree, track which one operations confirms over time',
  ],
};

// ── Navigation ──
export const NAV = {
  prev: { to: '/process',   label: 'Current Naqel Process' },
  next: { to: '/reference', label: 'Reference Material' },
};
