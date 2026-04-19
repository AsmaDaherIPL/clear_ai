# ClearAI — Architecture Decision Record

## ADR-001: Local-first Python CLI

**Decision:** Build as a Python CLI with no server, no UI, no cloud dependency at runtime.

**Context:** The tool is for internal customs operations. It processes merchant invoice files and outputs ZATCA-compliant XML. The operators run it locally on their machines.

**Consequences:**
- All data stays local (compliance-friendly)
- No infrastructure to maintain
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

## ADR-004: Pluggable LLM backend

**Decision:** Abstract LLM calls behind `HSReasoner` interface with API and local implementations.

**Context:** Need to support both cloud APIs (Anthropic) for production accuracy and local models (Ollama) for offline/development use.

**Consequences:**
- Resolution logic is backend-agnostic
- Can switch backends via env var
- Local dev doesn't require API keys
- Different accuracy/speed tradeoffs per backend

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
