# ClearAI — Architecture Decision Record

## ADR-001: Single-machine Python CLI

**Decision:** Build V1 as a Python CLI with no server, no UI. Data processing and storage are local to the developer's machine; the only external dependency at runtime is the Anthropic API for LLM inference.

**Context:** The tool is for internal customs operations. It processes merchant invoice files and outputs ZATCA-compliant XML. The operators run it locally on their machines. V1 is not an offline/air-gapped deployment — it assumes outbound internet for the API. A future multi-tenant deployment will sit behind an Azure Functions Python runtime with a REST boundary.

**Consequences:**
- Data files, SQLite, and generated XML stay on the operator's machine
- Only LLM requests leave the box (to Anthropic, with region-appropriate routing as compliance requires)
- No infrastructure to maintain for V1
- Easy to distribute and run
- No real-time collaboration features

---

## ADR-002: SQLite as unified data store

**Decision:** Load all mapping xlsx files into a single SQLite database at startup.

**Context:** Six different xlsx mapping files need to be queried during resolution. Reading xlsx at runtime is slow and error-prone. SQLite gives us indexed lookups, SQL joins, and ACID writes for the feedback ledger.

**Consequences:**
- One-time setup step (`db/setup.py`)
- Fast lookups during processing
- Ledger write-back is transactional
- Must re-run setup if mapping files change

---

## ADR-003: 4-path resolution hierarchy

**Decision:** Resolve HS codes via ledger > direct > prefix > reasoner, in that order.

**Context:** LLM calls are slow and expensive. Most codes can be resolved deterministically from existing mappings. The hierarchy ensures we only call the LLM when simpler paths fail.

**Paths:**
1. **Ledger** — exact match from human-verified decisions (confidence: 1.0)
2. **Direct** — 12-digit code exists in master table (confidence: 0.98)
3. **Prefix** — partial code matches 1 or few candidates in master (confidence: 0.70-0.95)
4. **Reasoner** — LLM inference with FAISS-retrieved candidates (confidence: varies)

**Consequences:**
- Predictable performance characteristics
- LLM costs scale only with ambiguous items
- Feedback loop (path 1) gets stronger over time

---

## ADR-004: API-only LLM with per-task model tiering (V1)

**Decision:** V1 is API-only (Anthropic). No local/Ollama backend. The `HSReasoner` interface exposes a single Anthropic-backed implementation. Flexibility comes from a **three-tier model split**, matching each LLM task to the smallest model that does it well:

- `TRANSLATION_MODEL` (default: **Haiku**) — Arabic description translation fallback when the master table has no Arabic name. Very narrow task, runs often. Cheapest tier.
- `RANKER_MODEL` (default: **Sonnet**) — candidate ranking when prefix traversal returns multiple plausible matches. Needs comparison judgement. Middle tier.
- `REASONER_MODEL` (default: **Opus**) — full HS classification from a free-text description, with FAISS candidates + Naqel bucket hint as evidence. Only runs when deterministic paths fail (~2.5% of rows). Strongest tier earns its cost here.

**Context:** An earlier draft planned both API and local (Ollama) backends. The rationale was offline/on-prem deployment and data residency. Neither is a real V1 requirement — the tool is not shipped for air-gapped operation, and data residency is solved at the API-vendor layer (regional endpoints / Bedrock) more cleanly than by hosting open-source models on a separate rig. Running a local inference server adds real operational complexity (GPU provisioning, model pulls, warm-keeping) and the accuracy ceiling of an open-source 70B model is genuinely below Opus on the hardest classification cases. Dropping local inference removes complexity, doesn't compromise any real requirement, and lets us pick the right model per task independently.

The three-tier split (vs a simpler two-tier "cheap Ranker / strong Reasoner") exists because translation is meaningfully narrower than ranking. Haiku handles "translate 'cotton blouse' to Arabic tariff terminology" reliably at roughly an order of magnitude lower cost than Sonnet. Running translation on Sonnet would work, but it would be paying a Sonnet price for a Haiku-class task on what is likely the most frequently-called LLM site in the pipeline.

**What we explicitly did NOT do (and why):**
- **Confidence-based routing** ("Haiku first, escalate to Sonnet if unsure"): attractive on paper but in practice doubles the call count on ambiguous rows, requires calibrating a confidence threshold on a model known to be overconfident, and adds retry/latency complexity. Revisit only if real cost data from V1 runs justifies it.
- **Content-based routing** (heuristic picks the model): hand-written "is this easy?" rules are exactly what LLMs are supposed to do for you. Would be brittle.

**Consequences:**
- No `llm/local_backend.py`, no `ollama` dependency, no `LLM_BACKEND` switch
- Three env vars (`TRANSLATION_MODEL`, `RANKER_MODEL`, `REASONER_MODEL`) — one per task, each defaulting to the right tier
- Each LLM call site in the code picks the right model by task, no dynamic routing logic
- If a future deployment genuinely needs offline inference, the `HSReasoner` interface still supports a second implementation — we'd reinstate local as a separate, justified decision then, not as speculative insurance now

---

## ADR-005: FAISS for semantic search

**Decision:** Use FAISS with sentence-transformers embeddings for HS code candidate retrieval.

**Context:** When the code-based paths fail, we need to find relevant HS codes by product description similarity. ~10,000 HS codes need sub-second search.

**Consequences:**
- One-time index build during setup
- Sub-millisecond search at runtime
- `all-MiniLM-L6-v2` is small and fast
- Index must be rebuilt if master table changes

---

## ADR-006: Confidence-gated output

**Decision:** Every resolved code carries a confidence score. Below `CONFIDENCE_THRESHOLD` (default 0.75) = flagged for human review.

**Context:** Incorrect HS codes cause customs delays and fines. Better to flag uncertain results than to silently output wrong codes.

**Consequences:**
- `review.csv` captures all uncertain resolutions
- Human reviewers focus only on flagged items
- Verified corrections feed back into the ledger (ADR-003, path 1)
- Threshold is configurable per deployment

---

## ADR-007: ClearAI is a precise HS classifier; Naqel's ledger is a hint, not an oracle

**Decision:** Treat the product as a precise HS classification tool (analogous to Zonos' HS/HTS lookup). The Naqel `hs_decision_ledger` is an **input signal** — one evidence stream among several — not the authoritative output.

**Context:** Initial framing treated Naqel's ledger as either (a) "human-corrected mappings" (wrong — it's automated) or (b) the authoritative bucket-map that defines ClearAI's output space (also wrong — that collapses us into a re-implementation of Naqel's operational shortcut). The user clarified: the product's job is to resolve a merchant's incomplete/ambiguous HS code into the **correct** 12-digit Saudi ZATCA code. Naqel's ledger encodes an operational bucket-mapping used for consolidated express/e-commerce clearance — useful as a hint when precise classification is ambiguous, but not the end goal.

**Signal hierarchy (inputs to the Reasoner):**
1. Merchant's declared code (may be partial, wrong jurisdiction, or HS-6 international)
2. Product description (EN / AR / CN if present)
3. FAISS semantic candidates from ZATCA tariff master (ground truth of valid Saudi codes)
4. Prefix-traversal candidates (longest-prefix-wins against master)
5. **Naqel ledger bucket hint** — "for items like this, Naqel historically declares code X" (advisory, not authoritative)
6. Duty-rate and description coherence across candidates

**Output:** a precise 12-digit Saudi code with confidence score. When the Reasoner's top candidate disagrees with the Naqel bucket, both are surfaced; reviewer decides.

**Consequences:**
- The 4-path resolver no longer short-circuits on ledger match. Ledger is a **prior**, not a gate.
- Path 1 ("ledger hit") becomes "ledger-consistent classification": if the merchant code maps to a bucket, and FAISS/prefix agree the bucket is plausible for the description, confidence goes up. Disagreement triggers the Reasoner.
- Reasoner prompt explicitly names the ledger hint as one of several evidence streams, not as the answer key.
- Confidence scoring reflects **classification correctness**, with agreement-with-Naqel as a secondary signal.
- Review queue surfaces cases where correct-classification and Naqel-bucket diverge — these are the highest-value human-review items.

**What this rules out:**
- Treating ledger lookups as 1.0-confidence outputs
- Defaulting to Naqel's bucket code when the description clearly indicates a different chapter

## ADR-008: Hexagonal (ports-and-adapters) layout inside clearai-backend

**Decision:** The backend is organised as a strict hexagonal architecture with a single inward-pointing dependency direction. Core domain logic is a Python package (`clearai/`) that knows nothing about HTTP, CLIs, or LLM providers. Integration surfaces (`api/`, `cli/`) and concrete provider implementations (`clearai/adapters/`) sit outside the core and depend on it through explicit interfaces (`clearai/ports/`).

**Context:** The Phase 2 layout had every module (`config.py`, `hs_resolver.py`, `lookup_engine.py`, `llm/api_backend.py`, …) sitting flat at the repo root. That worked for a CLI-only prototype but blocked everything downstream: a FastAPI surface, a future Azure AI Foundry backend, batch-mode CLI entry points, and test isolation all wanted to import into the flat tree in incompatible ways. When the user asked for a web UI in Migration V1, the choice was either bolt FastAPI onto the flat tree (guaranteeing an eventual big-ball-of-mud rewrite) or take one disruptive commit now to install real boundaries.

**Layout:**

```
clearai-backend/
├── clearai/                        ← the core; no framework imports
│   ├── config.py
│   ├── domain/                     pure types (reserved)
│   ├── ports/                      abstract interfaces
│   │   └── reasoner.py             HSReasoner (4 tasks: translate, rank,
│   │                               infer, justify) + Candidate, RankerInput,
│   │                               ReasonerInput, ReasonerResult,
│   │                               JustificationInput, JustificationResult,
│   │                               ReasonerError
│   ├── adapters/                   concrete implementations of ports
│   │   └── anthropic_reasoner.py   AnthropicReasoner (V1 only impl)
│   ├── services/                   orchestration over ports + DB + FAISS
│   │   ├── hs_resolver.py
│   │   ├── lookup_engine.py
│   │   └── arabic_translation_engine.py
│   ├── parsing/                    invoice intake
│   │   └── invoice_parser.py
│   ├── rendering/                  Bayan XML builder (Phase 3; stub)
│   └── data_setup/                 one-time DB + FAISS builders
│       ├── setup.py
│       └── build_faiss.py
├── api/                            ← FastAPI surface (outside the core)
├── cli/                            ← CLI entry points (outside the core)
└── tests/
    ├── unit/
    ├── integration/
    └── api/
```

**Import rules (enforced by import-linter in CI):**

1. `api/` and `cli/` MAY import from `clearai.*`.
   `clearai.*` MUST NEVER import from `api/` or `cli/`.
2. Within `clearai/`, dependencies point inward only:
   - `services/` may import from `ports/`, `domain/`, `config`, `parsing/`.
   - `adapters/` may import from `ports/`, `domain/`, `config`.
   - `ports/` may import from `domain/` only — NEVER from `adapters/` or `services/`.
   - `domain/` imports from nothing inside the project.
3. `data_setup/` is an isolated outer ring: it may import from `config` and nothing else in `clearai/`. It is invoked once at bootstrap via `python -m clearai.data_setup.{setup,build_faiss}`; services never import from it.
4. Tests may import from anywhere. Tests have no architectural privileges; they are free to reach in so they can exercise any layer in isolation.

**Why this specific shape:**
- **Swappable reasoner:** a future Azure AI Foundry or local-inference backend is a new file in `adapters/`. Services don't move. No PR touching `hs_resolver.py` has ever shipped just because a vendor changed.
- **Swappable surface:** FastAPI today, a gRPC service or a SQS worker tomorrow — all new code lands in sibling folders of `api/`. The core is reused verbatim.
- **Testable core:** the services package has zero HTTP / CLI / vendor dependencies, so unit tests run in milliseconds with stubbed `HSReasoner` and an in-memory SQLite.
- **No import cycles, by construction:** the dependency direction is a DAG, so circular imports can't happen without the linter screaming.

**Enforcement mechanism:** `import-linter` (declared in `[project.optional-dependencies].dev`) runs against the contract file `.importlinter` at the repo root. `lint-imports` is a required CI check before merge. Violations fail the build; the contract file is the single source of truth for the rules above.

**Consequences:**
- Every new module is born in exactly one of: `ports/`, `adapters/`, `services/`, `parsing/`, `rendering/`, `data_setup/`, `api/`, `cli/`, or `tests/`. If it doesn't fit, the module is doing two jobs and must be split.
- Adding a second LLM provider is a two-file change: one new adapter, one config switch. The resolver does not change.
- `config.py` is intentionally at the package root (not in `domain/`) because it reads environment variables — a side effect `domain/` must not own.
- The data dataclasses (`Candidate`, `ReasonerInput`, `ReasonerResult`, …) live in `ports/reasoner.py` rather than `domain/` for V1. Rationale: they only exist as the data shape crossing the `HSReasoner` interface. If a second port emerges and these shapes are shared, they migrate to `domain/` — but speculative splitting would cost import ceremony for zero payoff today.

**What this rules out:**
- Importing FastAPI, Typer, Uvicorn, or any transport concern anywhere under `clearai/`.
- Instantiating `AnthropicReasoner` (or any adapter class) inside `services/`. Services receive an `HSReasoner` via dependency injection; they never name a concrete implementation.
- Adding "just one" utility file at the `clearai-backend/` root. Every file has a layer.
- Sys.path manipulation. All execution uses either the installed editable package or `python -m clearai.<module>`.


## ADR-010: Complexity-hint-driven tier escalation (rejecting Foundry Model Router)

**Decision:** Within the three-tier split from ADR-004, ClearAI escalates from a
lower tier to a higher tier using a **deterministic, logged rule** driven by a
`ComplexityHint` computed from inputs the resolver already has (description
length, Arabic-script ratio, FAISS top-1/top-2 score gap, candidate count). We
**do not** adopt Azure Foundry's `model-router` deployment or any other
dynamic-routing service.

**Context:** During Migration V2 (Foundry integration) the obvious question was
whether to replace ADR-004's hardcoded task→tier mapping with Foundry's
`model-router`, which picks a model per prompt using a Quality / Cost / Balanced
policy and can span vendors (Anthropic, OpenAI, Grok, DeepSeek). On the surface
that would subsume the tiering decision into infrastructure and save a
classification of "which tier is this?" at every call site.

**Why the router loses here:**

- **Cost of wrong choice is regulatory, not cosmetic.** ClearAI's output becomes
  a ZATCA customs declaration. A router that silently downshifts Sonnet → Haiku
  on a borderline line produces a wrong HS code → wrong duty → audit exposure.
  Generic chatbots tolerate "the answer was slightly worse"; we cannot.
- **Prompt/schema stability.** The WCO 7-section justification schema is
  prompt-tuned per model family. Letting the router swap Claude → GPT → Grok
  between calls breaks the Pydantic parser the moment the response shape drifts.
- **Auditability.** Router decisions are opaque and not reliably logged on a
  per-call basis. When a filing is challenged six months from now, "a router
  picked the model" is not a defence; "rule R1 fired because tie-width=8 and
  confidence=0.62" is.
- **Vendor lock.** The router is an Azure-only feature. Baking it in couples
  routing policy to Azure Foundry in a way that surviving a future move to
  Bedrock, Vertex, or a self-hosted deployment would not.
- **We already have a router. It's three lines of a dict.** ADR-004's per-task
  mapping is not technical debt — it's the smallest possible correct design for
  a pipeline whose tasks are stable and well-characterised.

**What we build instead:**

- `clearai/ports/reasoner.py` carries a `ComplexityHint` dataclass (pure
  evidence, no policy).
- `clearai/services/complexity.py` owns the builder (`compute_complexity_hint`),
  the derived predicates (`is_long`, `is_arabic_heavy`, `faiss_is_ambiguous`,
  `prefix_tie_is_wide`), and the escalation rules (`should_escalate_ranker`).
- `clearai/services/hs_resolver.py` computes the hint once per call site,
  attaches it to `RankerInput` / `ReasonerInput` (so adapters can use it in
  prompting if they choose), logs it with `as_log_dict`, and — only at the
  Ranker site — checks `should_escalate_ranker`. If escalation fires, the row
  is re-classified via `infer_hs_code` (top tier) with both FAISS and prefix
  candidates attached.

**Escalation rules (v1):**

- **R1 — wide tie + low confidence:** Ranker confidence below
  `CONFIDENCE_THRESHOLD` AND prefix tie wider than 5 candidates. Indicates the
  mid-tier conceded on a broad ambiguity the full-evidence Reasoner can
  disambiguate.
- **R2 — long Arabic-heavy + low confidence:** Ranker confidence below
  `CONFIDENCE_THRESHOLD` AND description ≥60 tokens AND ≥30% Arabic script.
  Known weak spot of Sonnet on ClearAI's dataset; escalating gives the top
  tier more room without blanket-paying for it.

Rules are **additive**: starting conservative (one site, two rules) so the
first production weeks produce audit data that either justifies new rules or
retires these. Every invocation of `should_escalate_ranker` returns a
`reason_code` that is logged, so escalation frequency and effect are
measurable, not assumed.

**What we explicitly leave out of v1:**

- **Escalation at the Translator site.** Translation errors are cheap to catch
  downstream (Arabic output visibly broken on the review screen). Not worth
  doubling Haiku cost to chase it.
- **Auto-downshift rules (Reasoner → Ranker for easy cases).** The Reasoner
  only runs on Path 3, which is ~2.5% of rows by design. Saving cost here is
  pennies; the risk of downshifting a genuinely hard call is not worth it.
- **Vendor cross-over rules (Claude → GPT).** Separate decision; would require
  re-validating the justification schema across families. Revisit only with
  evidence.

**Enforcement:** The `ComplexityHint` lives in `ports/`, so the import-linter
`ports-pure` contract continues to forbid `ports/` depending on `services/`
(builder logic stays in `services/`). Unit tests in
`tests/unit/test_complexity.py` pin the rule contracts — any change to
threshold constants or rule logic is a deliberate, reviewed change, not a
drift.

**Consequences:**

- Every LLM call site logs a `ComplexityHint` line before dispatch. Production
  logs become the audit trail for "why did this row get Sonnet instead of
  Haiku."
- Adapters can optionally read `ReasonerInput.complexity_hint` to adjust
  prompts (e.g. add "be extra careful — this is a mixed Arabic/English
  description" for R2 cases). Not required; adapters ignoring the hint still
  satisfy the contract.
- Adding a new escalation rule = a new function in `complexity.py`, a new call
  site in the resolver, and new tests. No router re-configuration, no vendor
  lock.
- If Foundry later adds a router that is transparent (per-call decisions
  logged with reason, deterministic on re-run, schema-stable across families),
  this ADR is revisited. Today's router does not meet those bars.
