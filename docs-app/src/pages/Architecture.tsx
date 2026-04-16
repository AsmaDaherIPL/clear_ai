import Layout, { PageHero } from '../components/Layout';
import {
  SectionLabel,
  SectionTitle,
  SectionDesc,
  VerticalTabs,
  PageNav,
  Reveal,
} from '../components/ui';

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
        <h4 className="font-sans text-[1.05rem] font-bold text-accent mb-3">{title}</h4>
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
        <SectionLabel num="A">Resolution Algorithm</SectionLabel>
        <Reveal>
          <h3 className="font-sans font-bold text-text mb-3" style={{ fontSize: 'clamp(1.4rem,2.2vw,1.8rem)' }}>
            How a shipment row becomes a classified HS code
          </h3>
        </Reveal>
        <SectionDesc>
          Each line item is resolved based on how much of the HS code the merchant provided. A full 12-digit code
          goes straight to a master lookup. A partial code (4–11 digits) triggers prefix traversal — the system finds
          all matching candidates and picks deterministically if only one exists, or calls a Ranker model if several
          are plausible. Below 4 digits, or when no code is provided at all, the system infers from the item
          description using the Reasoner. The 4-digit floor comes from Naqel's operational data: at heading level
          (4 digits) there is still enough structure to traverse meaningfully.
        </SectionDesc>

        <Reveal className="my-8 border border-border rounded-[14px] overflow-hidden bg-card">
          <img
            src="/diagrams/v1-flow-algorithm..excalidraw.svg"
            alt="V1 Algorithm — HS Code Resolution Flow"
            className="w-full block"
          />
        </Reveal>

        <div id="algo-rationale">
          <RationaleBlock
            title="Why deterministic-first, not AI-first"
            intro="The resolution pipeline is ordered by cost and certainty — table lookups before inference, cached decisions before fresh ones. This isn't a preference; it's a constraint of the domain."
            points={[
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
            ]}
          />
        </div>
      </div>

      <div className="h-px bg-border my-12" />

      {/* B — Deployment */}
      <div id="deploy-rationale">
        <SectionLabel num="B">V1 Deployment</SectionLabel>
        <Reveal>
          <h3 className="font-sans font-bold text-text mb-3" style={{ fontSize: 'clamp(1.4rem,2.2vw,1.8rem)' }}>
            Local-first, pluggable LLM, zero cloud dependency
          </h3>
        </Reveal>
        <SectionDesc>
          A single-machine Python CLI with SQLite for lookups and Ollama or API models for the rare inference calls.
          Everything runs offline after initial setup.
        </SectionDesc>

        <Reveal className="my-8 border border-border rounded-[14px] overflow-hidden bg-card">
          <img
            src="/diagrams/v1-local-deployment.svg"
            alt="V1 MVP — Local Deployment Architecture"
            className="w-full block"
          />
        </Reveal>

        <RationaleBlock
          title="Why local-first with a pluggable LLM backend"
          intro="The V1 deployment is intentionally simple — a Python CLI on a single machine, no cloud dependencies at runtime, no UI. This is a deliberate architecture choice, not a shortcut."
          points={[
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
          ]}
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
      <h3 className="font-sans font-bold text-[1.6rem] text-text mb-3">V2 Architecture</h3>
      <p className="text-muted max-w-[620px] mx-auto leading-[1.75] text-[.9rem] mb-8">
        V2 is the production-grade system with API access, multi-tenant scale, and closed-loop learning.
        Architecture design is in progress.
      </p>
      <div className="grid gap-4 max-w-[820px] mx-auto text-left" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
        {['Multi-tenant API layer', 'PostgreSQL + pgvector', 'Real-time confidence feedback', 'Closed-loop learning pipeline'].map((item) => (
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
    <Layout chapter="Chapter 03 · Engineering" pageTitle="Technical Architecture">
      <PageHero
        kicker="Chapter 03 · Engineering"
        title={<>Technical <em className="not-italic text-accent">architecture</em></>}
        lede="The architecture separates concerns cleanly: where data enters, where AI works, where Saudi rules apply, where human review happens, and where output goes. Toggle between V1 (shipping) and V2 (planned) on the tabs below."
      />

      <section id="v1-panel" className="px-4 sm:px-8 lg:px-12 py-10 sm:py-14">
        <div className="max-w-[1160px] mx-auto">
          <SectionLabel num="03">Architecture</SectionLabel>
          <SectionTitle>System Architecture</SectionTitle>
          <SectionDesc>
            V1 covers the MVP — single-machine, batch processing, proving the pipeline works. V2 is the
            production-grade system with API access, multi-tenant scale, and closed-loop learning.
          </SectionDesc>

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
          prev={{ to: '/process',    label: 'Current Naqel Process' }}
          next={{ to: '/reference',  label: 'Reference Material' }}
        />
      </div>
    </Layout>
  );
}
