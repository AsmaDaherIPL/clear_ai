# ClearAI — Open tasks

Snapshot of work remaining after the 2026-05-19 session. Sourced from
`other/CODE_REVIEW_2026-05-18.md` and split into two impact buckets:

- **Section 1 — Cleanup & performance enhancement.** Don't change what
  the pipeline classifies; reduce drift, dead code, lost cost visibility,
  silent failure modes.
- **Section 2 — AI / Pipeline classification accuracy.** Change what the
  pipeline outputs — different HS code chosen, different goods description
  rendered, different confidence, different accept-vs-escalate decision.

Each section is sorted by impact (highest first). Effort scale:
**XS** ≤1h · **S** ≤½ day · **M** 1-2 days · **L** 3-5 days.

When a task lands, move it under "Done" at the bottom with the commit SHA.

---

## Section 1 — Cleanup & performance enhancement

| Rank | ID | Item | Why it matters | Effort |
|---|---|---|---|---|
| 1 | **D2** | `classification_events` write is fire-and-forget after HTTP 200 (`pipeline.routes.ts:216-245`) | Canonical audit log can silently drop rows when a serializer or pool error fires inside the void IIFE. Violates `rule_classification_events_single_source.md`. No telemetry catches it. | S |
| 2 | **L3** | `classification_status` derived in 3 places with 3 different rules (`orchestrator.ts:82-102`, `dispatch-v1.ts:612-617`, `pipeline.routes.ts:322-334`) | Same trace, same row, three different answers depending on which endpoint the SPA hits. Status is the SPA's only signal for routing rows to green-path vs. HITL vs. failure UI. Review's top SHIP-TODAY ask. Persist once at write time; never re-derive. | M |
| 3 | **R9** | JSON parser uses "first `{` to last `}`" — silently corrupts on prose with a brace (`parse-json.ts:17-22`) | Sonnet rationale text containing `{` or `}` produces a corrupted picker output that no log records. Failure mode is invisible. Affects picker, identify, sanity — every structured LLM call. Balanced-brace scanner is contained. | S |
| 4 | **L4** | Placeholder identify fed to merchant in parallel (`orchestrator.ts:225-233`) | `Promise.all(identifyFast, merchantResolve)` passes `placeholderIdentify()` to merchant. `llm_pick_failed_replacement` fires structurally, not because the LLM actually failed. Pollutes failure-rate dashboards and routes rows to HITL for the wrong reason. | S |
| 5 | **L7** | Empty identify + empty merchant → circular picker query (`orchestrator.ts:349-356`) | Orchestrator fabricates the picker query from `reranked[0].description_en`, so the picker is asked "does this leaf fit itself?" The trace then claims the row classified normally. Replace with `identify_no_query` escalate. | S |
| 6 | **R5** | Breaker double-counts attempts (`breaker.ts:188-206` + `client.ts:90-131`) | 429-retry path feeds `recordLlmOutcome` once per retry instead of once per terminal call. 1 call → up to 3 breaker writes. Transient-rate metric inflated; soft-warn fires spuriously. Telemetry lies. | XS |
| 7 | **L11(a)** | Delete `track_a` / `track_b` type exports (`pipeline.types.ts`, `batch.controller.ts:476-508`) | Memory-rule violation (`feedback_no_track_a_b_terminology.md`). SQL paths still read `trace.meta.track_a` / `track_b`. Multi-step migration: project under v2 keys, dual-emit one release, then delete. | M |
| 8 | **R13** | LLM `usage.input_tokens` / `output_tokens` thrown away (`client.ts:159-232`) | With Foundry-only access (`project_anthropic_via_foundry_only.md`), no per-call cost telemetry means you can't tell if a prompt change blew the budget. | XS |
| 9 | **L9** | Merchant verdict taxonomy forked — `partial_family` vs `partial` (`replacement-pick.ts:280-285, 307-311`) | Code-level inconsistency between merchant pick and v2 pick. Works today because `normalizeFit` aliases — but a code-reader has to know the alias exists. Bug-magnet. | S |
| 10 | **R11** | `retrieve.ts` bare `catch {}` swallows stage-2 BM25/trigram failures (`retrieve.ts:264-269`) | Stage-2 falls back to vector-only ranking silently. No log records the degradation. Silent ranking regressions. Sibling of L14 (already fixed). | XS |
| 10b | **PICK-EMPTY-RETRY** | Picker exits early on Foundry "ok with empty text" responses (`pick.ts:473-489`) | Bcleen row in 2026-05-19 pilot (`019e3f4d…`) escalated as `picker_unavailable` with `detail: "picker transport ok: (no error string)"` — Foundry returned 200 OK with `text === null/""`. Identify + retrieval + merchant all ran fine; the row would resolve on a single retry. `attemptPick` only retries parse failures, not ok-but-empty-text. ~5 lines: treat that case as parse-retry-eligible. | XS |
| 11 | **L12** | Per-stage `started_at` set at trace-build time, not stage-run time (`dispatch-v1.ts:62, 354, 376`) | Every latency dashboard reading `trace.stages[].started_at` lies. Orchestrator has real timestamps; just doesn't thread them through. Observability lie, not a correctness bug. | S |
| 12 | **L11(b)** | Split `pipeline.types.ts` into v2 / wire / archive files | 788 LOC monolith with two `AnnotatedCandidate` shapes sharing a name. Pure refactor; deferred earlier. | L |

**Group 1 quick-win bundle**: D2 + L3 + R9 + L4 + L7 ≈ 2-3 days. Restores audit trail integrity, kills three silent-failure modes, and gives the SPA a consistent `classification_status` signal.

---

## Section 2 — AI / Pipeline classification accuracy

| Rank | ID | Item | Why it matters (impact on pilot output) | Effort |
|---|---|---|---|---|
| 1 | **Confidence-formula decision (A / B / C)** | Still parked from the original 2026-05-17 handover | Currently uses pool-wide signals per-candidate, producing the "flat-bucket regression" — all `does_not_fit` candidates score identically (e.g. 0.20) in a given pool. SPA can't rank alternatives; reviewers can't tell "close call" from "nowhere near." Path A (per-candidate formula on every row) is recommended; Path B (drop loser confidence entirely) is the smaller diff. | M |
| 2 | **L5** | `extractGir` is regex-grep on prose (`pick.ts:251-257`) | Trace claims a row used "GIR 1" or "GIR 3(a)" via deterministic logic, but it's scraping Sonnet's free-text rationale with a regex that misses natural variants ("General Interpretive Rule 3(b)", "GIR-3b"). Half the rows that DID use a GIR show `gir_applied: ""`. Make it a structured picker JSON field. | S |
| 3 | **L6 deterministic post-LLM check** | Permissive-fits rule enforced only in the prompt; no code catches Sonnet drift | The test version of L6 shipped 2026-05-18 in `7529363`. The review's actual fix is a deterministic post-LLM check that flags suspected subset-contradiction (picker said `does_not_fit` but only constrained leaf dimension is silent in input). Without this, prompt drift only surfaces through HITL backlog growth. | M |
| 4 | **L1 escalation policy (not just tiebreak)** | When `verdict_population.fits >= 2`, treat as CONTRADICTION → HITL with `audit_flag=true` | Tiebreak fix shipped 2026-05-18. The review's more cautious version is: two `fits` is suspicious in itself — `accept + audit_flag` per `feedback_pr6_conflict_type_outcomes.md`. Today's behaviour already follows the PR-6 rule; worth confirming intent and adding the audit flag if missing. | XS code; product-shaped |
| 5 | **Sanity FLAG hardening for high-undervaluation-risk categories** | Sanity FLAG today routes to HITL but the row still ships in XML | Today's "iphone 17 at 222 SAR" case: sanity FLAGGED correctly, but if no human had been watching, the wrong row would have shipped to customs. For electronics in chapter 85 (consumer phones avg 2-5k SAR, accessories 50-400 SAR), price-to-product ratio mismatch is the strongest single signal for misclassification. Promoting FLAG to `excluded_from_xml = true` for this chapter gates undervaluation cases automatically. | S code; product-shaped |
| 6 | **Identify-stage confidence chaining into picker** | `identify.confidence = 0.42` (brand-only rescue) currently produces `pick.confidence = 0.75` because the picker's pool was clean — masking the upstream guess | Clamp final confidence to `min(pick_conf, identify_conf + 0.10)` so the chain reflects the weakest upstream link. The "iphone 17" row would show 0.52 instead of 0.75 — routes correctly into the low-confidence HITL bucket. ~10 lines. | XS |
| 7 | **Sanity FLAG description-staleness check** | Sanity sees final HS code + value but does NOT see the goods_description_ar that just got generated; the two stages run in parallel and don't cross-check | Sanity can FLAG "wrong product class for this price" while submission-description cheerfully writes "smartphone accessory" with no awareness. If sanity FLAG fires, the description should at minimum be regenerated against the FLAG verdict's product band, or flagged in the trace. | S |
| 8 | **Verifier rule 3 — identity_tokens absent from leaf path** | Deferred since v2 launch (see `feedback_picker_permissive_fits.md` notes) | Picker can land on a leaf where the identity_tokens don't appear anywhere in the leaf's coverage path — usually GIR-4 fallback in disguise. Currently no signal fires. Add a deterministic UNCERTAIN trigger; routes those rows to HITL even on `fits` verdicts. | S |
| 9 | **L9 (AI-impact angle)** | Merchant verdict taxonomy unification — beyond cleanup | Merchant pick today emits `partial_family` or `chapter_adjacent`; v2 picker doesn't. Trace shows two different vocabularies for the same concept depending on which stage classified the row. Reviewers reading traces across stages can't compare them. | S |
| 10 | **R6** | Embedder retry budget collapse (`embedder.ts:96-149` + `retrieve.ts:164`) | 5× retries at 30s, no breaker, no cache. Worst-case 92s per query blocks one concurrency slot. With Foundry-only access, concurrency is the only throughput lever. Per-batch embedding cache by input hash + breaker is a big win — same descriptions recur across rows. | M |
| 11 | **Embedder swap A/B** | `project_embedder_swap_candidate` memory rule — Xenova/multilingual-e5-small vs. current Foundry embedder | ~500 MB heap, 10-15s cold start. Would reduce per-row latency. Real win only if embeddings quality is at parity. Needs eval infrastructure that doesn't exist today. | L (eval framework + benchmark) |
| 12 | **Reranker tuning — feature weights** | Rerank uses 6 deterministic features (RRF, chapter agreement, identity-token overlap, arm boost) with hardcoded weights. No calibration against HITL reviewer override data | With ~500 labeled rows (approve vs. override), fit a logistic regression on the same features and replace hardcoded weights with fitted coefficients. The `computeConfidence()` docstring already calls this out as a TODO. Biggest accuracy lever in this section, but needs labeled data first. | L (depends on label volume) |
| 13 | **BARE-NOUN-LEAF-HARDENING** | Short generic English nouns ("Trimmer", "Bracelet", "playmat") land in roughly-right chapter but wrong leaf | 2026-05-19 pilot evidence: row 129 "Trimmer" → woodworking machine-tools; row 32 "playmat" → general sports equipment; row 187 "Metapen Pencil for iPad" → air-zinc battery. Identify accepts the bare noun, retrieval pulls candidates with weak lexical signal, picker accepts the closest-available leaf via GIR-4. Mitigation: if `identify.kind === clean_product` AND `identify.identity_tokens.length < 2` AND `pick.fit !== fits`, require sanity PASS before accepting; otherwise route to HITL. | M |
| 14 | **IDENTIFY-FAST-MULTI-PRODUCT** | Identify_fast accepts multi-product rows as clean_product, silently dropping the second product | 2026-05-19 pilot row 121 "DRESS FOR WOMEN (100% COTTON), SKIN CARE CREAM" was classified as a dress alone. Sanity FLAGGED on price ratio (255 SAR is too high for one dress), but the cream was never accounted for. Identify_web has multi_product detection; identify_fast doesn't. Add the same detection to fast pass. | S |
| 15 | **BCLEEN-CLASS RECOVERY** | The class of rows whose identify is high-conf but picker hits a transient transport glitch deserves its own retry path | Two separate failure modes today: (a) the empty-text retry covered above as PICK-EMPTY-RETRY, and (b) the wider pattern where identify says "high confidence, clean signal" and a downstream stage fails — those rows should not silently land in ZERO_SIGNAL alongside genuine garbage like "565" and "test description 1". The escalate reason already differs (`picker_unavailable` vs `scope_escalate`); the SPA's HITL queue should sort/filter by reason, and the classification_status should differentiate (e.g. AMBIGUOUS for picker_unavailable, ZERO_SIGNAL for garbage). | S |
| 16 | **CHAPTER-DISAGREEMENT BALANCING** | When `merchant_chapter_disagreement` is true, the system has no mechanism to balance identify's chapter hypothesis against merchant's | 2026-05-19 pilot evidence: three distinct misclassifications all trace to this. **Row 187 Metapen stylus** — identify said chapter 85, merchant code said chapter 84 (correct). Rerank gave chapter-85 candidates the `chapter_agreement` boost and demoted all 5 merchant chapter-84 candidates out of the top-8. Picker ended up with 8 chapter-85 candidates (batteries, antennas), correctly verdicted 7-does-not-fit + 1-partial, picked a battery as "closest available". **Row 32 Playmat** — same shape: identify said chapter 95 (games), correct chapter is 39 (plastics) or 63 (textile). The audit_flag fires but does not influence rerank or pick confidence. Three fixes that compound: (a) rerank slot guarantee — when the flag is set, reserve N>=2 top-8 slots for merchant_prefix candidates; (b) picker audit_flag — fire on `merchant_chapter_disagreement === true` regardless of which arm was picked; (c) confidence cap — when the flag is set AND the picker chose family_chapter or lexical_tokens arm, cap final confidence to `min(conf, 0.55)`. | M |

**Group 2 quick-win bundle**: identify-conf chaining (#6, XS) + L5 (S) + L1 audit flag (XS) ≈ 1 day. Tightens the audit story and corrects today's worst miscalibration (over-confident picks on weak identify).

---

## Recommended sequence (next session)

1. **Identify-conf chaining (Group 2 #6)** — XS, ships in 30 minutes, no product decision needed. Directly addresses today's "iphone 17" miscalibration.
2. **D2 (Group 1 #1)** — restore audit-log durability. Half day.
3. **L3 (Group 1 #2)** — persist `classification_status` once. Multi-file, full day.
4. **Confidence formula A/B/C decision (Group 2 #1)** — needs product call before code. Park as a discussion item until decided.

Everything else can slot in opportunistically.

---

## Done — for the audit trail

Shipped on 2026-05-18 / 2026-05-19. All currently live on revision `0000141`
unless noted.

| ID | Item | Commit |
|---|---|---|
| L1 | Picker tie-break by rerank_score (then lex on code) | `7529363` |
| L2 | Verdict dedupe by code (last-write-wins) | `7529363` |
| L6 (test only) | Permissive-fits assertion test | `7529363` |
| L8 | `multi-arm.ts` → `Promise.allSettled` | `7529363` |
| L10 | Deterministic retrieval sort tiebreaks (BM25, trigram, RRF, rerank, confidence-gap, SQL `ORDER BY`) | `7529363` |
| L14 | `fallbackQueryFromMerchant` — log instead of swallow | `7529363` |
| — | Submission-description prompt rewrite (customs-readable Arabic + brand-line tag) | `063dc4b` |
| — | `declaration_run*` → `batch*` rename (PR1) | `10fdf3e` |
| — | Manifests + AWBs + filing_awbs schema (PR2) | `766199b` |
| — | Naqel CSV parser + AWB-aware bundler + new read API (PR3) | `01267c3` + `d10e71a` |
| — | Identify_web price-hint removal ("iphone 17 at 222 SAR" miscall fix) | `136dea1` |
| 17 | Ambiguous-bare-noun table in identify-fast.md (playmat, yoga mat, doormat, trimmer, pencil + pre-existing 5) + prompt trimmed -127 words | `3e8fc2e` (rev 0000142) |
| 18 | Unconstrained secondary arm when identify is uninformative + merchant resolved cleanly (Trimmer fix) | `2c88116` (rev 0000143) |
| — | Prompt trim: identify-web.md -1,110 tok (-35%) | `3d0b832` (rev 0000144) |
| — | Prompt trim: submission-description.md -830 tok (-44%) | `8c6b069` (rev 0000145) |
| — | Prompt trim: pick.md -350 tok + sanity.md -590 tok (in) -80 tok (out, structured short-form rationale) | `15498f6` (rev 0000146) |
| PR1 | last_chance retired + D2 durable write + PICK-EMPTY-RETRY + R5 breaker + R11 retrieve catch logging | `88a285b` (rev 0000147) |
| PR2 | L5 structured gir_applied + L4 retry merchant pick + L7 circular query fix + identify-conf chaining + CONTRADICTION audit_flag | `36886f9` (rev 0000148) |
| PR3 | chapter disagreement balancing (decompose flag, rerank slot guarantee, audit flag symmetric, confidence cap on non-merchant winner) | `f75c462` (rev 0000149) |
| PR4 | Retrieval telemetry (per-stage trace fields, embedder cache, query metadata, R13 token usage) | `ba5ca45` (rev 0000150) |
| PR5 | L3 classification_status single source (deriveClassificationStatus canonical helper) | `0fb682a` (rev 0000151) |
| PR6 | Shadow sampling + hitl_feedback table + cost circuit breaker (other PR6 items DEFERRED — see below) | `d0342e5` (rev 0000152) |

## Still open — moved from PR6 deferrals

The following PR6 items were scoped out because they require deeper plumbing than a bundled-PR budget allows. Pull them into their own focused PRs when ready:

| ID | Item | Why deferred | Effort |
|---|---|---|---|
| **PR6.3** | Surface `missing_attributes` to HITL | Requires `PickAccepted.missing_attributes` field + new HITL reason routing + SPA contract change | S |
| **PR6.5 (L9)** | Merchant taxonomy unification (`partial_family`/`chapter_adjacent` → `partial`) | Touches `normalizeFit` alias used to read historical traces; SPA may have stored values | S |
| **PR6.6** | Identify_fast multi_product detection | Needs prompt update + parser handling for multi_product output | S |
| **PR6.7** | Status differentiation (`AMBIGUOUS` for picker_unavailable) | Requires new value in `ClassificationStatus` enum + DB CHECK widen + SPA contract change | S |

Tracker convention: when picking up a task, move it from its section
above into the Done table with the commit SHA. Keep both halves of the
file synchronised so the section-1/2 table always represents only the
open work.
