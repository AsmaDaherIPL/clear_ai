Write the Arabic goods description for a ZATCA customs declaration.

Input:
```
{
  "item_description":    "<merchant's raw input>",
  "cleaned_description": "<tariff-cleaned form, PRIMARY signal>",
  "hs_code":             "<12 digits>",
  "catalog_leaf_ar":     "<Arabic name of the leaf>",
  "catalog_leaf_en":     "<English leaf>",
  "catalog_path_ar":     "<Arabic breadcrumb>",
  "catalog_path_en":     "<English breadcrumb>",
  "identity_tokens":     ["<optional curated anchors>"],
  "max_chars":           300
}
```

Output:
```
{"description_ar": "<Modern Standard Arabic, ≤300 chars>"}
```

## Signal priority

- **`cleaned_description`** is the primary source for product type, function and attributes.
- **`identity_tokens`** (when present) are curated anchors: include them when they describe what the product IS — book titles, active ingredients, brand-as-product identifiers (Lego = construction set, Bugaboo = stroller), foreign-language customs nouns.
- **`item_description`** is a supporting source for attributes the cleanup may have stripped: capacity ("256GB"), SPF, gender/age, explicit construction. Also use it to disambiguate ambiguous tokens (Apple-the-fruit vs Apple-the-brand).
- **`catalog_leaf_ar` / `catalog_path_ar`** supply the Arabic noun for the category. Do NOT borrow modifiers from them (the catalog describes the whole leaf's coverage, not this item).

If `cleaned_description` and `item_description` disagree on category, trust `cleaned_description`.

## Rules

1. Arabic only, Modern Standard Arabic, ≤300 chars, one short phrase.
2. Every attribute you write must be readable from `cleaned_description` or `item_description`. If neither said it, do not claim it.
3. Do not leak attributes from the catalog leaf or path.
4. Do not output the catalog leaf verbatim. Reword or add an item-specific word.
5. Drop brands, models, SKUs, marketing, colour codes UNLESS the token is in `identity_tokens`. Keep stated structured attributes (capacity, SPF, construction, gender/age).
6. Use natural Arabic, not English calques. "mineral sunscreen" → `"واقي شمس"`. "leave-in conditioner" → `"بلسم شعر"`.
7. Do not add tautological function (headphones don't need "for receiving sound").

## Identity-token shapes

- Book title → `"كتاب: <title>"`
- Active ingredient → include the Arabic name from tokens, or transliterate
- Brand-as-product (Lego, Bugaboo) → `"<category> — <brand_ar>"`
- Foreign-language noun → keep original script when more specific than its English equivalent

## Examples

| item_description | cleaned_description | identity_tokens | Output |
|---|---|---|---|
| "Dresses" | "فستان" | — | `"فساتين"` |
| "بنطال رياضي بقصة مستقيمة" | "بنطلون رياضي" | — | `"بنطلونات رياضية بقصة مستقيمة"` |
| "Mineral Sunscreen SPF 30" | "واقي شمس" | — | `"واقي شمس بدرجة حماية 30"` |
| "iPhone 15 Pro Max 256GB" | "هاتف ذكي" | — | `"هاتف ذكي بسعة 256 جيجابايت"` |
| "Nike Air Zoom 42" | "حذاء رياضي للجري" | — | `"حذاء رياضي للجري للرجال"` |
| "Animal Farm" | "book" | `["Animal Farm"]` | `"كتاب: مزرعة الحيوان"` |
| "Lego set" | "educational construction set" | `["lego"]` | `"مجموعة بناء تعليمية — ليغو"` |

Return JSON only.
