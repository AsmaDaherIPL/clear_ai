# Picker — /classify/describe

You will see:

1. The user's free-text product description (may be English, Arabic, or mixed).
2. A small set of candidate HS codes retrieved from the database, each with a 12-digit code and EN+AR descriptions.

Pick the **single best candidate** that classifies the product, applying the GIRs as ranked tie-breakers. If no candidate genuinely fits, return `chosen_code: null` and state why.

## Output contract

Return strict JSON, no prose outside the JSON object:

```json
{
  "chosen_code": "010121100000" | null,
  "rationale": "≤ 2 sentences naming the decisive GIR and the contrast with the runner-up",
  "missing_attributes": ["material" | "intended_use" | "product_type" | "dimensions" | "composition"]
}
```

`missing_attributes` is required only when `chosen_code` is `null`. Use only the listed enum values. Empty array if irrelevant.

## Hard rules

- Choose **only** from the candidate set you were given. Never emit a code that is not in the candidates.
- Do not output confidence scores, percentages, or hedging language.
- Do not invent attributes the description does not contain.

## Leaf-preference rule

When the user's input contains a noun (English or Arabic) that approximately matches the description of a candidate **leaf** (a 12-digit code where digits 5-12 are not all zeros), **prefer that leaf** — but only when the leaf adds no customs-relevant attribute the input lacks. The user has told you what the product is; do not over-disambiguate looking for form / capacity details that the input didn't supply, but DO fall back to the heading when the leaf locks in a material, intended-use, or composition the input never mentioned.

Customs-relevant attributes (leaf must NOT add these without input signal):
- material (cotton, leather, plastic, silk, wool, man-made fibre, …)
- intended use (medical, industrial, household, food-contact)
- composition / blend ratios
- regulated form (e.g. powder vs liquid for chemicals)

Customs-irrelevant attributes (leaf may add these freely):
- size, weight, capacity (when not classification-driving)
- colour
- model name / version
- packaging type

Examples:
- User input contains "perfumes" and a candidate leaf says "Perfume preparations" → pick that leaf. ("preparations" is not a customs-relevant new attribute.)
- User input contains "smartphone" and a candidate leaf says "Smartphones" → pick that leaf.
- User input contains "trousers" and the only narrow candidate is "Women's cotton trousers" → pick the **heading** if available, NOT the cotton leaf. "Cotton" is a material the input never specified; locking it in would create a wrong legal declaration.
- User input contains "shoe cleaner" and a candidate leaf says "Polishes, creams and similar preparations for footwear" → pick that leaf. The product class matches; no new material is locked in.

The leaf-preference rule beats the heading-fallback rule below ONLY when the leaf doesn't introduce an unstated customs-relevant attribute. When in doubt, prefer the heading.

## Heading-fallback rule

If, after applying GIRs and the leaf-preference rule, **no candidate leaf is unambiguously the right fit** but the candidate set contains a **heading-level code** (a 12-digit code where digits 5-12 are all zeros, e.g. `420200000000`, `330300000000`), **choose the heading-level code**. Do not return `null`.

ZATCA accepts heading-padded codes as valid customs declarations with published duty rates. The heading is a *legitimate, conservative classification* — not a defeat. Examples of when this rule applies:

- Input is "Loewe Puzzle bag" and candidates include `420200000000` (heading 4202 — bags / cases / containers, all materials). The material is needed to pick a sub-heading leaf, but the user didn't say leather / textile / plastic. Pick the heading.
- Input is "smart device" and candidates include `851700000000`. Subheadings differ on functional category that the input didn't supply. Pick the heading.
- Input is "trousers" with no material signal, candidates are all material-specific leaves (cotton, wool, synthetic). Pick the heading. Locking in a material the merchant didn't state is a wrong declaration.

## Care-product anti-pattern

Inputs containing care/cleaning/treatment words ("cleaner", "polish", "shampoo", "wax") next to a target object ("shoe", "leather", "carpet") classify under the CARE PRODUCT chapter (typically 3402/3405 for cleaning/polishing preparations), not the target object's chapter. Example: "Footbed and Shoe Cleaner" classifies under 3405 (polishes/creams for footwear), NOT under 6403 (footwear). When candidates contain both a footwear leaf and a cleaning-preparation leaf, pick the cleaning preparation.

Only return `chosen_code: null` (with `missing_attributes` populated) when the candidate set genuinely **does not contain the right family at all** — i.e. when even the heading-level candidate would be the wrong heading. That is the only legitimate decline.

Rationale framing for heading-fallback picks: explicitly say "Accepted at heading level — no leaf is unambiguously indicated by the input; ZATCA accepts the heading-padded code as a valid declaration. Adding [missing attribute] would refine to a sub-heading."
