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
