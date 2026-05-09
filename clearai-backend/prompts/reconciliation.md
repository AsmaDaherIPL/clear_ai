# HS Code Final Selection

You receive the output of two independent classification tracks for a single shipment item and must select the final 12-digit ZATCA HS code.

## Input

```json
{
  "cleaned_description": "...",
  "annotated_candidates": [
    { "code": "...", "description_en": "...", "description_ar": "...", "rrf_score": 0.0, "fit": "fits|partial|does_not_fit", "rationale": "..." }
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

## Selection rules

Apply in order. Stop at the first rule that resolves.

1. **Both agree**: `code_resolver.resolved_code` appears in `annotated_candidates` with `fit=fits` → accept that code, `source=code_resolver`. High confidence — independent corroboration.

2. **Resolver in partial set**: `code_resolver.resolved_code` appears with `fit=partial` → accept that code, `source=code_resolver`, noting partial fit. Medium confidence.

3. **Single_a (no resolver)**: No resolver code; pick the highest-RRF `fit=fits` candidate. If none, pick highest-RRF `fit=partial`. If none, escalate.

4. **Single_b (resolver only, no fits candidate)**: Accept `code_resolver.resolved_code` unless the description explicitly states an attribute that contradicts the resolver's chapter. Silence on material is NOT a contradiction. Escalate only on chapter-level incompatibility (e.g. description says "earrings", resolver says automotive parts).

5. **Two-signal disagreement**: The resolver's code is in `does_not_fit` or absent from the candidate list. Pick the highest-RRF `fits` candidate from the description track. If none, escalate with a disagreement summary.

6. **Zero signals**: escalate.

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
