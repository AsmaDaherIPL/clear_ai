# ADR 0001 — Anchored Pipeline Architecture

Status: Accepted
Date: 2026-05-14
Supersedes: the parallel-tracks design described in `clearai-design-rationale.md`

## Context

The classification pipeline has accreted complexity since the original design.
The current implementation runs description analysis and merchant-code
resolution as two independent tracks in parallel, then merges their outcomes
in an 11-rule reconciliation classifier with three cross-cutting guards. A
single classification can produce 4 to 9 LLM calls depending on which rules
fire, and the trace shape varies materially between rows.

Five accreted patterns proved problematic in production:

1. `looksClean` short-circuit in cleanup waved through inputs like `"maxhub"`
   because the heuristic recognised a single ≤80-char token as already-clean.
   The LLM cleanup never ran, the researcher never fired, the row escalated
   to ZERO_SIGNAL with no useful trace.

2. The two-tier researcher (cheap Haiku → web on fail) confidently
   misidentified niche brands (TORY 45 → petroleum oil; Maxhub →
   "computer hub") because the cheap LLM hallucinated from training memory
   on inputs it should have escalated.

3. The 11-rule conflict_type classifier developed precedence bugs as new
   rules landed. Row 17 (Noctua CPU Cooler) crashed in handleAgreement
   because PR4's `chapter_adjacent` verdict satisfied a "has signal" check
   but no downstream handler knew how to use it. Row 8 (GPU graphics card)
   was demoted to AMBIGUOUS LOW because PR1's confidence gate fired
   before PR4's chapter-family AGREEMENT rule.

4. Hand-curated semantic tables (PR5 brand→chapter map, looksClean's
   stopword and ambiguous-head-noun sets) drifted from the original
   rationale's explicit prohibition: "keyword tables are frozen low-quality
   judgments that fail on synonyms and language variation."

5. The trace was not uniform — a row that took the cleanup-clear path
   carried different fields than one that took the needs-research path,
   making cross-row analysis a custom query per row class.

## Decision

Replace the parallel-tracks design with a three-stage **anchored pipeline**:

```
parse (deterministic, unchanged)
  -> identify (one LLM call with web tool, blinded to merchant code)
  -> resolveMerchantCode (deterministic, runs in parallel with identify)
  -> constrain (deterministic scope selector)
  -> retrieve + pick (one LLM call over a pre-narrowed candidate set)
  -> submission description (unchanged)
  -> sanity (unchanged)
```

Key architectural commitments:

- **Identify is web-first.** The cheap-LLM tier is eliminated. The identify
  step produces a typed `IdentifyResult` (clean_product | multi_product |
  uninformative) with optional `family_chapter` and `identity_tokens`.
  Blinded to the merchant code per the rationale's anchoring-avoidance
  principle.

- **Constrain is deterministic, no LLM.** It composes identify's output
  with `resolveMerchantCode` (which handles every codebook state including
  deprecated_single, deprecated_multi+override, deprecated_multi+llm_pick,
  partial_prefix, unknown, malformed). The output is a typed
  `RetrievalScope` — a merchant prefix, a family chapter, unconstrained,
  or escalate. The 11-rule conflict classifier disappears.

- **Pick operates on a pre-narrowed candidate set.** Retrieval runs
  with `scope.prefix` as a prefix filter; the picker prompt simplifies
  to a 3-value fit verdict (fits | partial | does_not_fit). The
  `chapter_adjacent` and `partial_family` verdicts disappear because
  constrain has already anchored the chapter neighborhood. The picker
  can see the merchant code as confirming evidence without risking
  anchoring bias, because the candidate set is already constrained.

- **Per-row trace is uniform.** Every row carries the same stage
  outputs in the same shape, regardless of which case fired. The
  `pipeline_architecture` field on `PipelineTrace` (added in PR-A-1)
  records which implementation produced each row so shadow-mode
  validation and post-cutover SQL queries can filter cleanly.

The architecture is named **anchored** because the defining commitment is:
retrieval is *anchored* to a chapter or prefix decided upstream by
identify + merchant-code resolution, rather than running unconstrained
and reconciling outcomes afterward.

## Consequences

### Removed

- `looksClean` predicate (forbidden by the rationale's "no judgments
  dressed up as rules")
- Two-tier researcher (`cheap_llm` → `web_search` escalation)
- `clarity_verdict` enum (informativeness fuses into identify's output)
- `tariff_expansion_en` field (identify produces tariff-English canonical
  directly)
- PR5 brand-to-chapter lookup table (subsumed into identify's family
  hint, which is web-grounded rather than curated)
- PR4 `chapter_adjacent` and `partial_family` fit verdicts (not needed
  when retrieval is scope-anchored)
- 11-rule conflict-type classifier + 3 cross-cutting guards
- PR1 picker_confidence as a routing rule (preserved as a quality flag)
- PR 5 subtree consistency check LLM call (redundant — retrieval is
  scope-anchored)

### Preserved

- All 65 cases from the case-coverage master table — every behavior the
  legacy pipeline gained over the PR1-PR6 history maps to a stage in the
  anchored design.
- Operator config tables (operator_field_mappings, operator_constants,
  operator_lookups, operator_code_overrides).
- HNSW + BM25 + trigram retrieval with RRF fusion.
- ZATCA XML renderer and Tabadul submitter identity.
- Submission description with PR6 identity_tokens plumbing.
- Sanity gate (Stage 3).
- HITL escalation paths and audit_flag semantics.
- `classification_events` as the single source of truth (rule preserved).
- `Azure-only identity` (Entra) for AuthN.
- `No per-operator credentials in env` (operators row carries them).
- `No merchant code padding` (parser unchanged).
- `Anthropic via Foundry only` (identify uses Foundry Sonnet with web tool).

### Trade-offs

**Lost: parallel-evidence safety net.** Today's design lets Track A and
Track B independently arrive at codes; reconciliation can catch one
track's mistake when the other is right. In the anchored design, if
identify misidentifies, the row dies on that misidentification. The
mitigations are:

1. Identify is web-grounded, so the failure mode "LLM hallucinated from
   training memory" is reduced relative to the cheap-LLM tier it
   replaces.
2. The picker's "no candidate fits" return signals escalation — same
   outcome as today's ZERO_SIGNAL, reached via a cleaner path.
3. Identify confidence carries forward to constrain, which falls back
   to merchant-code-only scope when identify is low-confidence.

**Lost: per-stage LLM auditability is replaced by per-stage typed
outputs.** Today's audit trail says "cleanup classified as `clear`,
researcher RECOGNISED, picker picked X." The anchored audit trail says
"identify produced {canonical, family_chapter, confidence}, constrain
chose scope=Y, picker picked X." Different shape, same information
density; the typed outputs are easier to grep.

### Performance

- LLM calls per row: 4 (identify, pick, submission, sanity), down from
  the legacy range of 4-9 depending on conflict_type. Predictable
  latency.
- Identify uses web search on inputs that the LLM doesn't recognise
  from training. Foundry web tool latency: 1-2s. Affects only the
  rows that would have hit needs_research today; identical or better
  latency on clean-noun rows where identify produces the canonical
  from training memory alone without firing the web tool.

## Migration plan

Documented as the 8-PR plan in this conversation. Summary:

- **PR-A-1** Pipeline architecture flag + orchestrator scaffold (this PR).
  Default `PIPELINE_ARCHITECTURE='legacy'`; production behavior unchanged.
- **PR-A-2** Identify stage implementation.
- **PR-A-3** Constrain stage + resolveMerchantCode.
- **PR-A-4** Pick stage (retrieve + simplified picker).
- **PR-A-5** Anchored orchestrator wiring + uniform trace shape.
- **PR-A-6** Shadow mode + architecture-diff tooling.
- **PR-A-7** Cutover: flip default to `anchored`. 2-week observation.
- **PR-A-8** Cleanup: delete legacy pipeline + the `PIPELINE_ARCHITECTURE`
  flag. Net code reduction: 2000-3000 LOC.

## Rollback

Three independent rollback paths:

1. **Env flag flip** (during PR-A-1..A-7): `az containerapp update ...
   --set-env-vars PIPELINE_ARCHITECTURE=legacy`. Instant, no redeploy.
2. **Image revert** (during/after PR-A-7, before PR-A-8):
   `az containerapp update ... --image ghcr.io/asmadaheripl/clearai-backend:sha-e734ac4`.
   sha-e734ac4 is the production-running image at the start of the
   migration, pinned in GHCR.
3. **Branch restoration** (worst case): `archive/pre-anchored` branch and
   `v-pre-anchored` tag preserve the exact pre-migration source tree.
   Both are GitHub-protected from force-push and deletion.

After PR-A-8 deletes the legacy code path, only options (2) and (3)
remain.

## Cutover gate (PR-A-6 → PR-A-7)

The flag default cannot flip until all of:

1. Shadow-mode agreement rate ≥ 90% on a 500-row held-out test batch.
2. Of disagreements: manual review confirms anchored is correct or
   equally defensible in ≥ 95%.
3. Four diagnosed production failures pass on anchored:
   - "maxhub" (no merchant) → Ch 8528 or family, not ZERO_SIGNAL
   - GPU graphics card + merchant 8471804000 → Ch 8473 family, AGREEMENT
   - TORY 45 + merchant 640420 → Ch 64 footwear, not petroleum
   - Joolz baby cot + merchant 87150010 → Ch 8715 carriage, not Ch 63
4. Full test suite passes.

## References

- `/Users/asma/Downloads/clearai-design-rationale.md` — the original
  rationale this ADR supersedes. The anchored design is a cleaner
  implementation of the same principles; it does not deviate from
  rationale-level claims, only from the legacy implementation's
  drift from those claims.
- Conversation log of 2026-05-14 covering the failure analysis,
  architecture options, and migration plan.
- `v-pre-anchored` git tag — pre-migration HEAD.
- GHCR image `sha-e734ac4` — pre-migration production image.
