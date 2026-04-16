### Why deterministic-first, not AI-first

The resolution pipeline is ordered by cost and certainty — table lookups before inference, cached decisions before fresh ones. This isn't a preference; it's a constraint of the domain.

**1. The HS Decision Ledger front-loads institutional knowledge.**
Naqel's operations team has already classified thousands of commodity codes through daily work. These verified mappings are the highest-confidence signal available — higher than any model output. Checking the ledger first means ~40% of rows resolve in microseconds with zero compute cost and zero risk of regression.

**2. Direct master lookup eliminates the majority of remaining rows.**
When the merchant provides a full 12-digit HS code and it exists in the Saudi tariff master (HSCodeMaster), there is no ambiguity — the code maps to exactly one Arabic tariff name and duty rate. No model call is justified here. This path handles the bulk of traffic.

**3. Prefix traversal with a Ranker handles partial codes without over-engineering.**
Partial codes (4–11 digits) are common in merchant invoices. Rather than immediately escalating to a large model, the system strips digits from the right and collects all matching candidates from the master. If exactly one candidate remains, it's deterministic. If multiple candidates exist, a lightweight Ranker model picks the best match against the item description — a narrow, well-scoped task that small models handle reliably.

**4. The Reasoner is the path of last resort, not the default.**
Full GRI-based inference from a free-text description is genuinely hard — it requires understanding specificity rules (3a), essential character (3b), and subheading rules (6). This is where a strong model earns its cost. But constraining this path to only missing/unresolvable codes (~2.5% of volume) keeps inference costs proportional to actual complexity, not total volume.

**5. The Confidence Gate enforces human-in-the-loop where it matters.**
Every resolution path outputs a confidence score. Below threshold, the row routes to `review.csv` for human verification — and those verified decisions write back to the Ledger, closing the feedback loop. The system gets better with use without requiring retraining.
