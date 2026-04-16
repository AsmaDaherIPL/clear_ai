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
  desc: 'V1 covers the MVP — single-machine, batch processing, proving the pipeline works. V2 is the production-grade system with API access, multi-tenant scale, and closed-loop learning.',
};

// ── Section A: Algorithm ──
export const ALGORITHM = {
  sectionLabel: 'A',
  sectionName: 'Resolution Algorithm',
  title: 'How a shipment row becomes a classified HS code',
  desc: "Each line item is resolved based on how much of the HS code the merchant provided. A full 12-digit code goes straight to a master lookup. A partial code (4–11 digits) triggers prefix traversal — the system finds all matching candidates and picks deterministically if only one exists, or calls a Ranker model if several are plausible. Below 4 digits, or when no code is provided at all, the system infers from the item description using the Reasoner. The 4-digit floor comes from Naqel's operational data: at heading level (4 digits) there is still enough structure to traverse meaningfully.",
  rationale: {
    title: 'Why deterministic-first, not AI-first',
    intro: "The resolution pipeline is ordered by cost and certainty — table lookups before inference, cached decisions before fresh ones. This isn't a preference; it's a constraint of the domain.",
    points: [
      {
        heading: 'The HS Decision Ledger front-loads institutional knowledge.',
        body: "Naqel's operations team has already classified thousands of commodity codes through daily work. These verified mappings are the highest-confidence signal available — higher than any model output. Checking the ledger first means ~40% of rows resolve in microseconds with zero compute cost and zero risk of regression.",
      },
      {
        heading: 'Direct master lookup eliminates the majority of remaining rows.',
        body: 'When the merchant provides a full 12-digit HS code and it exists in the Saudi tariff master (HSCodeMaster), there is no ambiguity — the code maps to exactly one Arabic tariff name and duty rate. No model call is justified here. This path handles the bulk of traffic.',
      },
      {
        heading: 'Prefix traversal with a Ranker handles partial codes without over-engineering.',
        body: "Partial codes (4–11 digits) are common in merchant invoices. Rather than immediately escalating to a large model, the system strips digits from the right and collects all matching candidates from the master. If exactly one candidate remains, it's deterministic. If multiple candidates exist, a lightweight Ranker model picks the best match against the item description — a narrow, well-scoped task that small models handle reliably.",
      },
      {
        heading: 'The Reasoner is the path of last resort, not the default.',
        body: 'Full GRI-based inference from a free-text description is genuinely hard — it requires understanding specificity rules (3a), essential character (3b), and subheading rules (6). This is where a strong model earns its cost. But constraining this path to only missing/unresolvable codes (~2.5% of volume) keeps inference costs proportional to actual complexity, not total volume.',
      },
      {
        heading: 'The Confidence Gate enforces human-in-the-loop where it matters.',
        body: "Every resolution path outputs a confidence score. Below threshold, the row routes to review.csv for human verification — and those verified decisions write back to the Ledger, closing the feedback loop. The system gets better with use without requiring retraining.",
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
  title: 'Local-first, pluggable LLM, zero cloud dependency',
  desc: "A single-machine Python CLI with SQLite for lookups and Ollama or API models for the rare inference calls. Everything runs offline after initial setup.",
  rationale: {
    title: 'Why local-first with a pluggable LLM backend',
    intro: "The V1 deployment is intentionally simple — a Python CLI on a single machine, no cloud dependencies at runtime, no UI. This is a deliberate architecture choice, not a shortcut.",
    points: [
      {
        heading: 'Data residency is non-negotiable.',
        body: "Customs declarations contain merchant identities, shipment values, national IDs, and trade routes. For a Saudi logistics operator, keeping this data on-premises during processing isn't a nice-to-have — it's a regulatory expectation. A local-first architecture satisfies this by default.",
      },
      {
        heading: 'The LLM backend is pluggable — API or local, same interface.',
        body: "The HSReasoner abstraction means the pipeline doesn't care whether the model runs on Ollama locally or calls Sonnet/Opus via API. For the Ranker task, API models like Sonnet or Haiku are primary — fast, cheap, accurate for narrow tasks. For the Reasoner task, Opus or GPT-4o is primary — strongest reasoning for the hardest problems. Local models serve as offline fallbacks. Switching is a single config change:",
        code: 'LLM_BACKEND=api|local',
      },
      {
        heading: 'SQLite over PostgreSQL is the right call for V1.',
        body: 'The tariff master is ~10,000 rows. The mapping tables total under 1,000 rows combined. A full database server adds operational overhead with zero benefit at this scale. SQLite is embedded, zero-config, and fast enough for single-threaded batch processing. When V2 introduces concurrent API users, PostgreSQL becomes justified — not before.',
      },
      {
        heading: 'The FAISS index is built once and queried rarely.',
        body: 'Vector search over HSCodeMaster descriptions is only used by the Reasoner path (~2.5% of rows). Building the index at setup and loading it into memory at runtime means no external vector database dependency. At 10K rows, the index fits in <50MB of RAM.',
      },
      {
        heading: 'The comparator module exists for trust, not just testing.',
        body: "comparator.py diffs Clear AI's output against Naqel's current system output declaration-by-declaration. This isn't a test harness — it's the mechanism that builds operational trust. Before any switchover, the operations team can see exactly where the new system agrees, disagrees, and improves on the baseline.",
      },
    ],
  },
  diagram: '/diagrams/v1-local-deployment.svg',
  diagramAlt: 'V1 MVP — Local Deployment Architecture',
};

// ── V2 ──
export const V2 = {
  title: 'V2 Architecture',
  desc: 'V2 is the production-grade system with API access, multi-tenant scale, and closed-loop learning. Architecture design is in progress.',
  plannedItems: [
    'Multi-tenant API layer',
    'PostgreSQL + pgvector',
    'Real-time confidence feedback',
    'Closed-loop learning pipeline',
  ],
};

// ── Navigation ──
export const NAV = {
  prev: { to: '/process',   label: 'Current Naqel Process' },
  next: { to: '/reference', label: 'Reference Material' },
};
