# Test Cases — ClearAI v1

Living catalogue of test inputs and expected outcomes. Drives unit tests, integration tests, and the eval set used to calibrate Evidence Gate thresholds and `confidence_band` buckets.

Group each case by the path it exercises. Mark **status** as one of:

- `expected` — designed test, not yet implemented
- `automated` — covered by a passing test in the repo
- `eval` — used in the calibration eval set, not in CI
- `flagged` — known failure / open bug

---

## 1. `/classify/describe` — accepted (strong match, no GIR tie-break)

| # | Input (description) | Lang | Expected `decision_status` | Expected `decision_reason` | Expected code shape | Notes | Status |
|---|---|---|---|---|---|---|---|
| 1.1 | "cotton t-shirt for men" | en | accepted | strong_match | begins with `6109` | classic textbook case, top1 should dominate top2 | expected |
| 1.2 | "قميص قطن للرجال" | ar | accepted | strong_match | begins with `6109` | Arabic equivalent of 1.1, same code expected | expected |
| 1.3 | "live horses, pure-bred breeding" | en | accepted | strong_match | begins with `0101 21` | row exists verbatim in Excel | expected |
| 1.4 | "stainless steel kitchen sink" | en | accepted | strong_match | begins with `7324` | unambiguous metal article | expected |

## 2. `/classify/describe` — needs_clarification (weak retrieval / ambiguous)

| # | Input | Expected `decision_reason` | Expected `missing_attributes` | Notes | Status |
|---|---|---|---|---|---|
| 2.1 | "stuff" | weak_retrieval | `['product_type','material','intended_use']` | nothing classifiable | expected |
| 2.2 | "blue thing 200g" | weak_retrieval | `['product_type','material']` | colour + weight insufficient | expected |
| 2.3 | "set of 4 parts" | ambiguous_top_candidates | `['product_type','material']` | top1 and top2 within `MIN_GAP` | expected |

## 3. `/classify/describe` — GIR tie-break cases (composite, set, specific-vs-general)

| # | Input | Rule applied | Expected outcome | Notes | Status |
|---|---|---|---|---|---|
| 3.1 | "leather wallet with steel chain" | GIR 3(b) — essential character | code under wallets, not leather articles + chain | composite goods | expected (eval) |
| 3.2 | "chess set: wooden board with plastic pieces in retail box" | GIR 3(b) — set put up for retail | toys/games chapter, not wood | retail set | expected (eval) |
| 3.3 | "electric shaver for men" | GIR 3(a) — most specific | 8510 (shavers), not 8509 (electric appliances) | specific-vs-general | expected (eval) |
| 3.4 | "unpainted car body panel" | GIR 2(a) — unfinished as finished | motor vehicle parts, not raw metal | unfinished article | expected (eval) |

## 4. `/classify/describe` — digit normalization (ADR-0003)

| # | Input | Expected handling | Notes | Status |
|---|---|---|---|---|
| 4.1 | "shirt 89" | `<4` digits → keep as text noise | "89" treated as text | expected |
| 4.2 | "cotton tshirt 89123" | 5 digits, no chapter/heading match → strip silently | digits removed before retrieval | expected |
| 4.3 | "cotton tshirt 6109" | 4 digits matching heading → keep + soft RRF bias | bias toward 6109 candidates | expected |
| 4.4 | "shirt 010121100000" | 12 digits matching real row → **TBD/deferred for v1** | currently treated as text noise per ADR-0003 | expected |
| 4.5 | "code 1234567890123" | `>12` digits → text noise | no special handling | expected |

## 5. `/classify/expand` — descend within a declared parent

| # | Input (parent code, description) | Expected `decision_status` | Expected `decision_reason` | Notes | Status |
|---|---|---|---|---|---|
| 5.1 | parent=`6109`, desc="cotton t-shirt for men" | accepted | strong_match | descends to a 12-digit leaf under 6109 | expected |
| 5.2 | parent=`6109`, desc="stuff" | needs_clarification | weak_retrieval | gate fails inside the branch | expected |
| 5.3 | parent=`010121`, desc="pure-bred Arab breed horse" | accepted | single_valid_descendant | only one leaf survives | expected |

## 6. `/boost` — sibling search under parent10

| # | Input (declared 12-digit code) | Expected `decision_status` | Expected `decision_reason` | Notes | Status |
|---|---|---|---|---|---|
| 6.1 | declared=`010121100000` (Arab-breed horse) | accepted | already_most_specific | no sibling beats current by `BOOST_MARGIN` | expected |
| 6.2 | declared=`<row with siblings, weak description>` | accepted | strong_match | a sibling clearly dominates | expected |
| 6.3 | declared=`999999999999` (fake) | needs_clarification | invalid_prefix | parent10 has no rows | expected |

## 7. Hallucination guard

| # | Scenario | Expected outcome | Notes | Status |
|---|---|---|---|---|
| 7.1 | LLM returns a code not in the candidate set | `decision_status='needs_clarification'`, `decision_reason='guard_tripped'` | guard never silently substitutes | expected |
| 7.2 | LLM returns malformed JSON | `decision_status='needs_clarification'`, `decision_reason='guard_tripped'` | parse failure → guard trip | expected |

## 8. Operational degradation

| # | Scenario | Expected outcome | Notes | Status |
|---|---|---|---|---|
| 8.1 | Foundry returns 503 after retries (gate had passed) | `decision_status='degraded'`, `decision_reason='llm_unavailable'`, `result` = top retrieval candidate | graceful degrade | expected |
| 8.2 | Foundry returns 503 BEFORE gate is evaluated | gate evaluated first; if gate fails → `needs_clarification` (weak_retrieval); otherwise `degraded` | gate trumps fallback | expected |
| 8.3 | Postgres unavailable | 503 response, no retrieval performed | dependency failure | expected |

## 9. Bilingual coverage

| # | Input | Expected | Status |
|---|---|---|---|
| 9.1 | Arabic-only description for an English-only row | retrieval still surfaces correct row via shared 384-dim e5 space | expected |
| 9.2 | Mixed EN+AR description | both tokens contribute to retrieval | expected |

---

<!-- Add new groups for Section/Chapter Notes ingestion, calibration eval set, and per-deployment soak tests as v1 progresses. -->
