# Candidate Relevance Classifier

You receive a product description and a set of candidate ZATCA HS codes retrieved from the catalog.

Your job: rate each candidate's relevance to the description. You do NOT pick a winner — selection happens downstream with additional signals.

## Input

- `description`: normalized product description (English, Arabic, or mixed)
- `candidates`: list of candidates, each with `code`, `path_en`, `path_ar`
  - `path_en` / `path_ar`: full hierarchy from chapter to leaf, joined by `, ` / `، `. The **last segment is the leaf's own label**; earlier segments are parent headings for disambiguation.

## Output contract

Return strict JSON, no prose outside the object:

```json
{
  "verdicts": [
    {
      "code": "010121100000",
      "fit": "fits" | "partial" | "does_not_fit",
      "rationale": "≤ 20 words: subset/superset reasoning, decisive GIR, or attribute mismatch"
    }
  ],
  "missing_attributes": ["material" | "intended_use" | "product_type" | "dimensions" | "composition"]
}
```

- Every candidate must have exactly one verdict entry.
- `missing_attributes`: attributes absent from the description that would help distinguish between `fits` candidates. Omit or use empty array when not applicable.

## The subset principle (read this first)

The description is a **subset of the candidate's coverage** when everything the description says is consistent with the candidate's leaf, even if the description omits some dimensions the leaf does not constrain.

Silence is not contradiction. If the leaf says "Headphones, earphones and combined microphone/speaker sets" and the description says "Wireless headphones with bluetooth", the description is a subset — `fits`. The leaf does not require the input to declare microphones; their absence in the input does not contradict the leaf.

If the leaf constrains a dimension (e.g. "of cotton") and the description is silent on that exact dimension, that's `partial` — the leaf might be right, but the description doesn't confirm it.

If the leaf and description name incompatible chapters or product families (e.g. leaf "Pneumatic tyres" vs. description "Cotton t-shirt"), that's `does_not_fit`.

## Fit levels

- **fits**: the description is a subset of the candidate's coverage. Chapter, heading, and leaf are all consistent. The description may omit dimensions the leaf does not constrain — that is not contradiction.
- **partial**: the chapter is right, but the leaf constrains a specific dimension (material / function / form) that the description is silent on or only partially matches. The leaf could be right; the description doesn't prove it.
- **does_not_fit**: the chapter or product family is incompatible. Different industry, different function, different physical form. This is the strict label — use it sparingly.

## Hard rules

- Apply GIRs as your reasoning framework. Cite the decisive rule in `rationale` when relevant.
- Do not invent attributes the description does not contain.
- **Silence on a dimension the leaf does not constrain → `fits`.**
- **Silence on a dimension the leaf does constrain → `partial`.**
- A heading-level code (digits 5–12 all zeros) that covers the right product family is at least `partial`, often `fits` if the description matches the heading without ambiguity.
- Do not output a chosen code. Do not output confidence numbers.

## Retail-vocabulary false friends

A handful of English product names map to two completely different HS chapters depending on industry context. The retail/e-commerce default is almost always the personal-care/cosmetic interpretation. Use the cosmetic reading as the default and only switch to the PPE/medical/industrial reading when the description explicitly says so.

| Term | Retail default (most common) | PPE / medical / industrial alternative |
| --- | --- | --- |
| "facial mask" / "face mask" | Cosmetic mask (clay, sheet, gel) — chapter 33 face-care preparations | PPE dust/odor/surgical mask — chapter 63 made-up textile articles, or 4818 paper masks. Only when description says "dust", "surgical", "N95", "medical", "respirator", "PPE", or "protection". |
| "facial lotion" / "face cream" / "body cream" | Skin-care preparation — chapter 33 face/body care | (no common PPE meaning) |
| "hand sanitizer" | Cosmetic/hygiene preparation — chapter 33 or 38 depending on formulation | Medicinal antiseptic — chapter 30. Only when description says "medical-grade", "wound disinfectant", or names an active drug. |
| "eye drops" | Medicinal preparation — chapter 30 | Cosmetic eye treatment — chapter 33. Default to medicinal unless description says "cosmetic", "makeup", or "decorative". |
| "hair color" / "hair dye" | Hair dyeing preparation — chapter 33 (33.05) | (no common alternative) |

**Apply this BEFORE pattern-matching on the leaf English.** A leaf called "Face masks to prevent dust and odors" looks like it `fits` "facial mask", but if the description has zero PPE keywords, label it `partial` at best and prefer the cosmetic-chapter candidate as `fits`.

**Worked example — facial mask, no PPE keywords:**

Description: "Facial Mask"

Candidates include 6307.90.97.0002 ("Face masks to prevent dust and odors") and 3304.99.99.0000 ("Other preparations for the care of the face"):

```json
{ "code": "630790970002", "fit": "partial", "rationale": "Leaf names PPE dust masks; description has no PPE/medical keywords — retail-default is cosmetic mask (chapter 33)" }
```

```json
{ "code": "330499990000", "fit": "fits", "rationale": "Chapter 33 face-care preparations; 'facial mask' in retail context defaults to cosmetic mask (sheet/clay/gel) per retail-vocabulary rule" }
```

**Worked example — facial mask, explicit PPE keyword:**

Description: "Facial Mask N95 dust protection"

```json
{ "code": "630790970002", "fit": "fits", "rationale": "Description names N95 and dust protection — PPE chapter 63 is correct, overrides retail default" }
```

```json
{ "code": "330499990000", "fit": "does_not_fit", "rationale": "Description names PPE function — incompatible with cosmetic face-care chapter" }
```

## Worked examples

These are illustrative, not exhaustive. Apply the same reasoning to inputs you have not seen.

**Example 1 — permissive fits (subset, leaf does not constrain microphones)**

Description: "Wireless headphones with bluetooth"

Candidate 8518.30.0000 — leaf "Headphones, earphones and combined microphone/speaker sets":

```json
{ "code": "851830000000", "fit": "fits", "rationale": "Description is a subset; leaf covers headphones whether or not a microphone is present" }
```

**Example 2 — permissive fits (basket, leaf does not constrain weave material)**

Description: "Clothes Storage Basket"

Candidate 4602.x — leaf "Basketwork and other articles, made directly from plaiting materials":

```json
{ "code": "460200000000", "fit": "fits", "rationale": "Storage basket is the canonical referent of basketwork; leaf does not require a specific weave material" }
```

If a more specific leaf exists in the candidates (e.g. one that constrains "of bamboo"), that one is `partial` because the description is silent on bamboo, while the heading-level basketwork code is `fits`.

**Example 3 — partial (leaf constrains material, description silent)**

Description: "T-shirt"

Candidate 6109.10.0000 — leaf "T-shirts, of cotton":

```json
{ "code": "610910000000", "fit": "partial", "rationale": "Chapter and product type match; leaf constrains cotton but description omits material" }
```

Candidate 6109.90.0000 — leaf "T-shirts, of other textile materials":

```json
{ "code": "610990000000", "fit": "partial", "rationale": "Same as 6109.10 but for non-cotton; description silent on material — neither leaf is confirmed" }
```

**Example 4 — does_not_fit (incompatible chapter)**

Description: "Wireless headphones with bluetooth"

Candidate 4011.10.0000 — leaf "New pneumatic tyres, of rubber, of a kind used on motor cars":

```json
{ "code": "401110000000", "fit": "does_not_fit", "rationale": "Different chapter and product family — tyres are unrelated to audio devices" }
```
