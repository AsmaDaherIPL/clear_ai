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

Items struck through with the shipping commit moved into Done; the rest are still open.

| Rank | ID | Item | Why it matters | Effort |
|---|---|---|---|---|
| ~~1~~ | ~~D2~~ | ~~`classification_events` write is fire-and-forget~~ — **Shipped in PR1 (`88a285b`)** | — | — |
| ~~2~~ | ~~L3~~ | ~~`classification_status` derived in 3 places~~ — **Shipped in PR5 (`0fb682a`)** | — | — |
| ~~3~~ | ~~R9~~ | ~~JSON parser uses "first `{` to last `}`"~~ — **Shipped in PR8 (balanced-brace scanner)** | — | — |
| ~~4~~ | ~~L4~~ | ~~Placeholder identify fed to merchant~~ — **Shipped in PR2 (`36886f9`)** | — | — |
| ~~5~~ | ~~L7~~ | ~~Empty identify + empty merchant → circular picker query~~ — **Shipped in PR2 (`36886f9`)** | — | — |
| ~~6~~ | ~~R5~~ | ~~Breaker double-counts attempts~~ — **Shipped in PR1 (`88a285b`)** | — | — |
| 7 | **L11(a)** | Delete `track_a` / `track_b` type exports (`pipeline.types.ts`, `batch.controller.ts:476-508`). Memory-rule violation. Multi-step migration. | M |
| ~~8~~ | ~~R13~~ | ~~LLM `usage.input_tokens` / `output_tokens` thrown away~~ — **Shipped in PR4 (`ba5ca45`)** | — | — |
| 9 | **L9** | Merchant verdict taxonomy forked (`partial_family` vs `partial`). Bug-magnet. Same item as PR6.5 in deferrals. | S |
| ~~10~~ | ~~R11~~ | ~~`retrieve.ts` bare `catch {}` swallows stage-2 failures~~ — **Shipped in PR1 (`88a285b`)** | — | — |
| ~~10b~~ | ~~PICK-EMPTY-RETRY~~ | ~~Picker exits early on Foundry "ok with empty text"~~ — **Shipped in PR1 (`88a285b`)** | — | — |
| 11 | **L12** | Per-stage `started_at` set at trace-build time, not stage-run time. Observability lie. | S |
| 12 | **L11(b)** | Split `pipeline.types.ts` into v2 / wire / archive files. Pure refactor (788 LOC monolith). | L |

**Still open in Section 1**: L11(a), L9, L12, L11(b) — three small, one large refactor.

---

## Section 2 — AI / Pipeline classification accuracy

Items struck through with the shipping commit moved into Done; the rest are still open.

| Rank | ID | Item | Why it matters | Effort |
|---|---|---|---|---|
| 1 | **Confidence-formula decision (A / B / C)** | Still parked from 2026-05-17. Today's `computeConfidence()` flat-buckets all `does_not_fit` candidates (e.g. all score 0.20) — SPA can't rank alternatives. Path A: per-candidate formula on every row. Path B: drop loser confidence entirely. Path C: keep current. **Needs product call.** | M |
| ~~2~~ | ~~L5~~ | ~~`extractGir` is regex-grep on prose~~ — **Shipped in PR2 (`36886f9`) as structured `gir_applied` field** | — | — |
| 3 | **L6 deterministic post-LLM check** | Permissive-fits rule enforced only in the prompt. The deterministic catcher for "picker said `does_not_fit` but only constrained leaf dimension is silent in input" hasn't shipped. The test version shipped 2026-05-18 (`7529363`); the production gate is still open. | M |
| ~~4~~ | ~~L1 audit flag~~ | ~~CONTRADICTION audit flag on `verdict_population.fits >= 2`~~ — **Shipped in PR2 (`36886f9`)** | — | — |
| 5 | **Sanity FLAG hardening for high-undervaluation-risk categories** | Sanity FLAG routes to HITL but the row still ships in XML. For chapter 85 (consumer electronics), price/product mismatch is the strongest single misclassification signal. Promote FLAG to `excluded_from_xml = true` for this chapter. Today's batch had two of these (Sony at 1 SAR; #9). | S code; product-shaped |
| ~~6~~ | ~~Identify-conf chaining into picker~~ | ~~Clamp `pick_conf` to `min(pick_conf, identify_conf + 0.10)`~~ — **Shipped in PR2 (`36886f9`)** | — | — |
| 7 | **Sanity FLAG description-staleness check** | Sanity sees final HS code + value but not `goods_description_ar`. They run in parallel. If sanity FLAGs, the description should regenerate against the FLAG verdict's product band — or at least flag the trace. | S |
| 8 | **Verifier rule 3 — identity_tokens absent from leaf path** | Picker can land on a leaf where identity_tokens don't appear anywhere in coverage — usually GIR-4 fallback. Currently no signal. Add deterministic UNCERTAIN trigger. | S |
| 9 | **L9 (AI-impact angle)** | Merchant verdict taxonomy unification — merchant pick emits `partial_family`/`chapter_adjacent`; v2 picker doesn't. Same as Section 1 L9 / PR6.5. | S |
| 10 | **R6** | Embedder retry budget collapse. 5× retries × 30s, no breaker, no cache (partial cache shipped in PR4 — full breaker still open). Worst-case 92s per query blocks one concurrency slot. | M |
| 11 | **Embedder swap A/B** | Xenova/multilingual-e5-small vs current Foundry embedder. ~500MB heap, 10-15s cold start. Needs eval framework that doesn't exist today. | L |
| 12 | **Reranker tuning — feature weights** | 6 hardcoded weights, no calibration against HITL reviewer overrides. ~500 labeled rows needed for logistic regression fit. Biggest accuracy lever — but blocked on labels. | L |
| 13 | **BARE-NOUN-LEAF-HARDENING** | Short generic nouns ("Trimmer", "Bracelet", "playmat") wrong leaf. The prompt-side (ambiguous noun table) shipped in `3e8fc2e`; the deterministic gate (`identity_tokens.length < 2` + `pick.fit !== fits` → require sanity PASS) is still open. | M |
| ~~14~~ | ~~IDENTIFY-FAST-MULTI-PRODUCT~~ | ~~Comma-separated multi-product detection~~ — **Shipped in PR7 (`999f448`)** | — | — |
| ~~15~~ | ~~BCLEEN-CLASS RECOVERY~~ | ~~Differentiate transient transport failures from genuine ZERO_SIGNAL~~ — **Shipped in PR1 (PICK-EMPTY-RETRY) + PR7 (AMBIGUOUS status)** | — | — |
| ~~16~~ | ~~CHAPTER-DISAGREEMENT BALANCING~~ | ~~Rerank slot guarantee + picker audit flag + confidence cap~~ — **Shipped in PR3 (`f75c462`)** | — | — |

**Still open in Section 2**: #1 (parked), #3 L6 catcher, #5 chapter-85 gate, #7 sanity↔description cross-check, #8 verifier rule 3, #9 taxonomy, #10 R6 cache, #11 embedder swap, #12 reranker tuning, #13 bare-noun gate.

---

## Recommended sequence (next session, as of PR8)

1. **Sanity chapter-85 gate (Section 2 #5)** — S, half day. Today's batch confirmed two undervaluation cases (Sony at 1 SAR; iPhone-style). Promote chapter-85 sanity FLAG to `excluded_from_xml = true`. Needs a 2-line product confirmation that auto-excluding is the right behavior.
2. **Confidence formula A/B/C decision (Section 2 #1)** — needs product call before code. The flat-bucket regression is the worst remaining accuracy issue.
3. **L6 deterministic catcher (Section 2 #3)** — M, ~1 day. Catches "picker said `does_not_fit` but only constrained dimension is silent in input" — prompt drift currently only surfaces via HITL backlog.
4. **Bare-noun gate (Section 2 #13)** — M, ~1-2 days. Deterministic gate to back up the prompt-side fix.

The five Section-1 cleanup items (L11(a), L9, L12, L11(b)) and the slow accuracy items (#10 R6 cache, #11 embedder swap, #12 reranker tuning) can slot in opportunistically.

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
| PR7 | Picker timeout 15s→30s (totalBudget 50s→90s) + AMBIGUOUS classification_status for picker_unavailable (item #8 Dresses fix) + identify_fast multi_product class-shift rule + examples | `999f448` (rev 0000161) |
| PR8 | R9 balanced-brace JSON parser (replaces silent-corruption "first {-to-last-}" logic) + sanity rationale-verdict reconciliation (fixes today's #2 + #5 internal-PASS-external-FLAG bug) + sanity prompt multi-revision rule | `9fc241f` (rev 0000162) |

## Still open — moved from PR6 deferrals

The following PR6 items were scoped out because they require deeper plumbing than a bundled-PR budget allows. Pull them into their own focused PRs when ready:

| ID | Item | Why deferred | Effort |
|---|---|---|---|
| **PR6.3** | Surface `missing_attributes` to HITL | Requires `PickAccepted.missing_attributes` field + new HITL reason routing + SPA contract change | S |
| **PR6.5 (L9)** | Merchant taxonomy unification (`partial_family`/`chapter_adjacent` → `partial`) | Touches `normalizeFit` alias used to read historical traces; SPA may have stored values | S |
| ~~PR6.6~~ | ~~Identify_fast multi_product detection~~ | **Shipped in PR7** — prompt-only update (class-shift rule + examples); parser already handled `multi_product`. | — |
| ~~PR6.7~~ | ~~Status differentiation (`AMBIGUOUS` for picker_unavailable)~~ | **Shipped in PR7** — TypeScript-only. AGREEMENT/DRIFT/ZERO_SIGNAL aren't stored in a SQL CHECK constraint (derived from JSONB trace), so no DB migration needed. | — |

Tracker convention: when picking up a task, move it from its section
above into the Done table with the commit SHA. Keep both halves of the
file synchronised so the section-1/2 table always represents only the
open work.
