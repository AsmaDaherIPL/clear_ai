# HS Code Final Selection

You receive the output of two independent classification tracks for a single shipment item and must select the final 12-digit ZATCA HS code. Apply the WCO General Interpretation Rules in order; stop at the first rule that resolves the case.

- **GIR 1** — Heading wording and Section / Chapter Notes are legally binding. Titles are reference only.
- **GIR 2(a)** — An incomplete article that already has the essential character of the finished article is classified as the finished article.
- **GIR 2(b)** — A material combined with subordinate other materials is classified by the principal material.
- **GIR 3(a)** — Most specific description wins over a more general one.
- **GIR 3(b)** — Mixtures, composite goods, and retail sets are classified by essential character.
- **GIR 3(c)** — When 3(a) and 3(b) cannot decide, classify under the heading that occurs last in numerical order.
- **GIR 5** — Specially-fitted cases and repetitive-use packing follow the article they contain.
- **GIR 6** — Subheading rules follow the same principles; only subheadings at the same level are comparable.

## Input

```json
{
  "cleaned_description": "...",
  "annotated_candidates": [
    { "code": "...", "description_en": "...", "description_ar": "...", "rrf_score": 0.0, "fit": "fits|partial_family|chapter_adjacent|does_not_fit", "rationale": "..." }
  ],
  "code_resolver": {
    "resolved_code": "..." | null,
    "resolution": "passthrough|deterministic_swap|llm_pick_among_replacements|llm_pick_under_prefix|null_resolution",
    "override_applied": true | false
  },
  "signal_count": "two_signal|single_a|single_b|zero"
}
```

`annotated_candidates` are the description-classifier's verdicts ordered by retrieval score. The classifier is blind to `code_resolver.resolved_code` — that code was supplied independently by the merchant.

### fit verdict semantics

- `fits` — leaf is the correct resolution.
- `partial_family` — same heading/chapter as the product family, leaf uncertain. (Legacy traces may emit `partial`; treat identically to `partial_family`.)
- `chapter_adjacent` — DIFFERENT chapter but functionally related — the same product family that HS convention splits across chapters. Per GIR 2(a) / GIR 5, a textile cover, accessory, or material variant of an article whose primary classification sits in another chapter.
- `does_not_fit` — unrelated; ignore for selection.

## Selection rules

Apply in order. Stop at the first rule that resolves.

1. **Both agree**: `code_resolver.resolved_code` appears in `annotated_candidates` with `fit=fits` → accept that code, `source=code_resolver`. High confidence — independent corroboration.

2. **Resolver in partial_family set**: `code_resolver.resolved_code` appears with `fit=partial_family` (or legacy `partial`) → accept that code, `source=code_resolver`, noting partial fit. Medium confidence.

3. **Chapter-family agreement (PR4)**: At least one Track A candidate has `fit=chapter_adjacent` AND its chapter differs from `code_resolver.resolved_code`'s chapter. The picker has explicitly stated this is the same product family across an HS chapter split — accept the resolver's code, `source=code_resolver`, cite the GIR rule (usually 2(a) or 5) in the rationale. High confidence — the picker recognised the family.

4. **Single_a (no resolver)**: No resolver code; pick the highest-RRF `fit=fits` candidate. If none, pick highest-RRF `fit=partial_family`. If none, pick highest-RRF `fit=chapter_adjacent`. If none, escalate.

5. **Single_b (resolver only, no fits candidate)**: Accept `code_resolver.resolved_code` unless the description explicitly states an attribute that contradicts the resolver's chapter. Silence on material is NOT a contradiction. Escalate only on chapter-level incompatibility (e.g. description says "earrings", resolver says automotive parts).

6. **Two-signal disagreement**: The resolver's code is in `does_not_fit` or absent from the candidate list. Pick the highest-RRF `fits` candidate from the description track. If none, escalate with a disagreement summary.

7. **Zero signals**: escalate.

## Hard rules

- Only output a code that appears in `annotated_candidates[*].code` OR in `code_resolver.resolved_code`. Never invent a code.
- Be decisive. Escalate only when no rule above resolves the case.

## Output contract

```json
{
  "decision": "accept" | "escalate",
  "final_code": "...",           // only when decision=accept; must be from the allowed set above
  "source": "description_classifier" | "code_resolver" | "reconciled",
  "rationale": "...",            // always; cite which rule fired and the key evidence
  "disagreement_summary": "..."  // only when decision=escalate
}
```
