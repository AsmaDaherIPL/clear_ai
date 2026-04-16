### Why local-first with a pluggable LLM backend

The V1 deployment is intentionally simple — a Python CLI on a single machine, no cloud dependencies at runtime, no UI. This is a deliberate architecture choice, not a shortcut.

**1. Data residency is non-negotiable.**
Customs declarations contain merchant identities, shipment values, national IDs, and trade routes. For a Saudi logistics operator, keeping this data on-premises during processing isn't a nice-to-have — it's a regulatory expectation. A local-first architecture satisfies this by default.

**2. The LLM backend is pluggable — API or local, same interface.**
The `HSReasoner` abstraction means the pipeline doesn't care whether the model runs on Ollama locally or calls Sonnet/Opus via API. For the Ranker task (candidate ranking + Arabic translation), API models like Sonnet or Haiku are the primary choice — fast, cheap, and accurate for narrow tasks. For the Reasoner task (full GRI inference), Opus or GPT-4o is primary — strongest reasoning for the hardest classification problems. Local models (Phi-3, Llama-3-8B, Llama-3-70B) serve as offline fallbacks. Switching is a single config change: `LLM_BACKEND=api` or `LLM_BACKEND=local`.

**3. SQLite over PostgreSQL is the right call for V1.**
The tariff master is ~10,000 rows. The mapping tables total under 1,000 rows combined. A full database server adds operational overhead with zero benefit at this scale. SQLite is embedded, zero-config, and fast enough for single-threaded batch processing. When V2 introduces concurrent API users, PostgreSQL becomes justified — not before.

**4. The FAISS index is built once and queried rarely.**
Vector search over HSCodeMaster descriptions is only used by the Reasoner path (~2.5% of rows). Building the index at setup and loading it into memory at runtime means no external vector database dependency. At 10K rows, the index fits in <50MB of RAM.

**5. The comparator module exists for trust, not just testing.**
`comparator.py` diffs Clear AI's output against Naqel's current system output declaration-by-declaration. This isn't a test harness — it's the mechanism that builds operational trust. Before any switchover, the operations team can see exactly where the new system agrees, disagrees, and improves on the baseline.
