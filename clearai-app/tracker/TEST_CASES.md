# ClearAI — Manual Test Cases

Hand-curated test cases used to exercise the Rock 2 resolver end-to-end
(Path 3 · Reasoner). Each case is written in the same fixed format so results
are comparable over time and regression-testable when the Reasoner prompt or
the master data changes.

---

## Input format

Every test case MUST supply exactly these inputs:

```
Description:   <short free-text, as a merchant would write on an invoice>
HS code:       <declared HS code, or "(none)" when the merchant sent nothing>
Value:         <amount + ISO currency>
Origin:        <ISO-2 country shipped from>
Destination:   <ISO-2 country, always "SA" for Saudi pipeline>
```

If any of these is missing, the test case is invalid — the resolver's behaviour
depends on all five inputs (Path selection depends on HS code presence/length;
currency + origin drive lookup engine side-effects; destination gates the whole
pipeline).

---

## Output format (required — do not deviate)

Every test case output MUST contain all four of these sections, in this order,
with these exact headings. Justification section is verbatim — including the
trailing blank line after each sub-heading — because downstream review tooling
keys on the heading strings.

````
### 1. 12-digit HS code

**`<12-digit-code>`**

### 2. Customs description

*<verbatim description_en from hs_code_master for that code>*

### 3. Our Arabic description

*<verbatim arabic_name from hs_code_master, or translation via TRANSLATION_MODEL>*

### 4. Justification

---

**Classification Justification: <Product name>**

**Understanding the Product**

<1–3 sentences describing the product as shipped and the commercial context.>

**Relevant Tariff Headings**

<Bulleted list of 2–5 candidate HS chapters / headings / subheadings considered, each with a one-sentence description of scope.>

**Exclusions of Other Subheadings**

<Bulleted list of headings considered and rejected, each with a one-sentence reason.>

**WCO/HS Explanatory Notes**

<Paragraph citing the Explanatory Notes that disambiguate the chosen heading from its nearest competitors.>

**Correct Classification**

<Paragraph applying GRI 1 through 6 explicitly by number, ending at the national 12-digit line.>

**Conclusion**

<1–2 sentences restating the final code + duty rate + Arabic description, followed by the evidence trail (which FAISS/prefix candidates supported it, at what scores).>

---
````

---

## Test cases

### Case 001 — Comic book (US → SA, 200 USD, no HS code)

**Inputs**
```
Description:   comic book
HS code:       (none)
Value:         200 USD
Origin:        US
Destination:   SA
```

**Resolution path:** Path 3 · Reasoner (no declared code → FAISS + REASONER_MODEL).

**Expected outputs**

### 1. 12-digit HS code

**`490300900005`**

### 2. Customs description

*Illustrative books for children such as Captain Majid and Superman*

### 3. Our Arabic description

*كتب مصورة للأطفال مثل (كابتن ماجد وسوبرمان)*

### 4. Justification

---

**Classification Justification: Comic Books**

**Understanding the Product**

A comic book is a bound printed publication telling a story primarily through sequential illustrations, with supporting text in speech balloons and captions. The merchant description is simply "comic book," shipped from US to Saudi Arabia at 200 USD. No material, binding, or audience specialization is given, but the term "comic book" in ordinary trade use refers to the illustrated narrative format marketed principally to children and young readers (e.g. Marvel, DC, manga translations, Superman, Spider-Man, Captain Majid).

**Relevant Tariff Headings**

- **Chapter 49** — *Printed books, newspapers, pictures and other products of the printing industry; manuscripts, typescripts and plans.* Chapter 49 is the correct chapter for any printed matter where the essential character is the printed content itself, not the paper substrate.
- **Heading 49.03** — *Children's picture, drawing or colouring books.* This heading covers printed books for children in which the pictures form the principal interest.
- **Heading 49.01** — *Printed books, brochures, leaflets and similar printed matter.* This is the general "books" heading. Subheading 4901.99 covers "other" books where illustrations are not the main feature.
- **Subheading 4903.00.900005** (Saudi 12-digit) — *Illustrative books for children such as Captain Majid and Superman.* This is the ZATCA national line specifically naming comic-style children's illustrated books, including Superman as a named example.

**Exclusions of Other Subheadings**

- **4820.20** (*school art / exercise books*) — excluded. These are blank or ruled books for writing and drawing, not printed narrative content.
- **4901.99** (*other printed books, pictures not the main feature*) — excluded. Comic books are defined by pictures being the principal feature, which is the exact discriminator HS uses between 49.01 and 49.03.
- **4902** (*newspapers and periodicals*) — excluded at the entry level. Although monthly comic issues could arguably be periodical, heading 49.03 is lex specialis for children's picture books and takes precedence under GRI 3(a).
- **8543.70** (*electronic books*) — excluded. Comic books as shipped are physical printed matter, not electronic devices.

**WCO/HS Explanatory Notes**

The HS Explanatory Notes to heading 49.03 state that this heading covers books for children "in which the essential interest lies in the pictures." Comic books fall squarely in this definition: the sequential illustrations carry the narrative, and the text exists in service of the pictures rather than the other way around. The ENs explicitly contrast 49.03 with 49.01 by this pictures-vs-text test. Saudi Arabia's national line 490300900005 codifies this by naming Captain Majid and Superman — unambiguous real-world comic-book references.

**Correct Classification**

Applying **GRI 1** (classification determined by heading terms + section/chapter notes), heading 49.03 directly names "children's picture … books," which is the defining form of a comic book. Applying **GRI 6** at the subheading level, national line **490300900005** — "Illustrative books for children such as Captain Majid and Superman" — is the most specific line and explicitly enumerates comic-book exemplars.

**Conclusion**

HS code **490300900005**. Duty rate 0% (exempt). Arabic description *كتب مصورة للأطفال مثل (كابتن ماجد وسوبرمان)*. Classification is supported by (a) the literal ZATCA line naming Superman, (b) FAISS semantic retrieval placing this line at rank 2 with score 0.449, and (c) HS Explanatory Notes distinguishing 49.03 from 49.01 on the pictures-vs-text criterion.

---

**Evidence trail (FAISS top-10, deterministic, live DB 2026-04-19):**

| Rank | Score | HS code        | EN                                                                   | AR                                            |
|------|-------|----------------|----------------------------------------------------------------------|-----------------------------------------------|
| 1    | 0.464 | 482020000007   | School Books Of Art                                                  | دفاتر مدرسية للرسم                            |
| 2    | 0.449 | **490300900005** | **Illustrative books for children such as Captain Majid and Superman** | **كتب مصورة للأطفال مثل (كابتن ماجد وسوبرمان)** |
| 3    | 0.444 | 490199500000   | - - - illustrated books for children in which pictures are not the main | - - - كتب مصورة للأطفال التي لا تشكل الص    |
| 4    | 0.434 | 280429900002   | krypton                                                              | كربيتون                                       |
| 5    | 0.433 | 490191000004   | Literary Encyclopedias                                               | الموسوعات الأدبية                             |
| 6    | 0.416 | 482010000004   | Order Books                                                          | دفاتر الطلبات                                 |
| 7    | 0.411 | 681389000006   | Episodes                                                             | حلقات                                         |
| 8    | 0.410 | 490290200003   | Global magazines                                                     | مجلات عالمية                                  |
| 9    | 0.410 | 490210200003   | Global magazines                                                     | مجلات عالمية                                  |
| 10   | 0.408 | 854370900012   | electronic books                                                     | كتب الكترونيه                                 |

**Live Opus call:** pending — requires `ANTHROPIC_API_KEY`. The expected code
above is derived deterministically from (a) ZATCA master data + (b) GRI
reasoning. When the key is supplied, rerun with:

```bash
ANTHROPIC_API_KEY=sk-ant-... .venv/bin/python3 -m tests.run_case 001
```

and compare the Reasoner's `hs_code + confidence + rationale` against this
expected block. Any divergence is either a better classification (note it and
update the expected block) or a real bug (trace through the Reasoner prompt).

---

## Adding new test cases

1. Assign the next 3-digit case number. Sequential, no gaps.
2. Write the **Inputs** block exactly as shown above — 5 lines, no extras.
3. Determine the **Resolution path** by inspection:
   - 12-digit declared, master-present → Path 1 (direct)
   - 4–11 digit declared, master-present → Path 2 (prefix or ranked)
   - any remaining case → Path 3 (Reasoner)
4. Fill the four output sections in the exact format above.
5. Capture the **Evidence trail** (FAISS top-10 for Path 3; prefix candidates + winner for Path 2; direct row for Path 1).
6. Mark live-call status ("live Opus call: pending" until verified against the real API).
