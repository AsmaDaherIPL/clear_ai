# ADR-0006 — Two-track classification with reconciliation

Status: accepted, 2026-05-05
Scope: backend pipeline/ — Stage 1 through Stage 3
Owner: backend platform

## Context

Before this ADR the classification flow was single-path: a description entered
a cleanup stage, went through retrieval + picker, and exited with one candidate
code. When a merchant also supplied an HS code (the "verify" path) the code was
compared against the picker's output in an ad-hoc way with no structural
separation between the two opinions.

Two failure modes made the single-path approach inadequate:

1. **Anchoring.** Showing the merchant's code to the LLM picker causes it to
   be biased toward that code even when the description does not support it.
   This is the adversarial-miscoding pattern from ADR-0004.

2. **Wasted signal.** When the merchant does supply a 12-digit code that is
   genuine, discarding it entirely means one retrieval + picker call per item
   with no benefit from the broker's domain knowledge.

The solution is to run two independent opinions concurrently and compare them
at a dedicated reconciliation stage, rather than allowing either opinion to
influence the other during classification.

## Decision

Classification runs two tracks in parallel:

```
Track A (description classifier)
  Input: cleaned_description only — merchant code is NEVER visible here
  Substages: Researcher (conditional) → Hybrid retrieval → Threshold check → Picker
  Output: { chosen_code, confidence, rationale, alternatives, no_fit? }

Track B (code resolver)
  Input: merchant_code only — description is used only as a tiebreaker, never as
         the primary signal
  Branches: operator override → codebook lookup → passthrough |
            deterministic swap | lightweight LLM pick among replacements |
            expand prefix + lightweight LLM pick | null
  Output: { resolved_code, resolution, raw_merchant_code, codebook_state, llm_context? }
```

The tracks run concurrently. Neither track sees the other's output until
Stage 2 (Verdict/Reconciliation).

### Stage 0a — Parse (deterministic)

Extracts: raw_merchant_code (digits-only strip), description presence flag,
identifiers (ASIN/EAN/GTIN), line metadata.

Hard rejects (returns status=`rejected` immediately, never enters pipeline):
- No description present. A code alone is insufficient for sanity or declaration.

No LLM. No length thresholds. No keyword tables.

### Stage 0b — Cleanup (lightweight LLM, when description present)

Reads: raw description + extracted identifiers as context.

Emits:
```
cleaned_description   string         normalised customs noun + attributes
language              string         detected language code
tokens                string[]       significant noun tokens
clarity_verdict       clear | needs_research | unusable
```

`clarity_verdict` is the only routing signal used downstream:
- `clear` → Track A proceeds directly to hybrid retrieval.
- `needs_research` → Track A runs Researcher first.
- `unusable` (keyboard mash, single-char, etc.) → item rejected before tracks.

One LLM read. Lightweight model (Haiku-tier). Never throws; degrades to raw
input on failure.

### Track A substages

| # | Name | Engine | Gate | Returns |
|---|---|---|---|---|
| 1 | Researcher | Standard LLM + web | Only when `clarity_verdict=needs_research` | enriched_description, attributes, web findings |
| 2 | Hybrid retrieval | Embedder + lexical (no LLM) | Always | ~12 ranked candidates with RRF scores |
| 3 | Threshold check | Deterministic score math | Always | pass\|fail; fail → `no_fit`, skips Picker |
| 4 | Picker | Standard LLM | Only when threshold passed | chosen 12-digit code, confidence, rationale, alternatives OR `no_fit` |

Track A is blind to the merchant code throughout all four substages.

### Track B branches

The branch taken is deterministic once the merchant code's state is known:

| Merchant code state | Branch | LLM? |
|---|---|---|
| Operator override match | Return override code | No |
| 12-digit, active in codebook | Passthrough | No |
| 12-digit, deprecated (replacement exists) | Deterministic swap to replacement | No |
| 12-digit, deprecated (N replacements) | Lightweight LLM picks among N | Lightweight |
| 6/8/10-digit prefix, children exist | Expand prefix + lightweight LLM picks leaf | Lightweight |
| No code / null / malformed | Null resolution (Track B contributes no signal) | No |

When resolution is `llm_pick_among_replacements` or `llm_pick_under_prefix`,
Track B output carries:
```ts
llm_context: {
  chosen: { code: string; rationale: string };
  runners_up: Array<{ code: string; rationale: string }>;
}
```

Track B never emits a correctness judgment. That is Stage 2's job.

### Stage 2 — Verdict (Reconciliation, Standard LLM)

Runs always, after both tracks complete.

Signal count determines the reconciliation case:

| Case | Condition | Reconciliation engine |
|---|---|---|
| Two-signal agree | A.chosen_code prefix-matches B.resolved_code | Accept, no LLM call needed |
| Two-signal disagree | Both tracks have a code, codes diverge | Standard LLM reconciles |
| Single-A | Track A has code, Track B resolved null | Accept Track A |
| Single-B | Track A no_fit, Track B has code | Standard LLM light-verify then accept |
| Zero | Both no signal | Escalate to HITL |

Standard LLM reconciliation inputs: Track A outcome, Track B outcome,
cleaned_description, agreement level, codebook state.

Reconciliation output:
```ts
{
  final_code:     string;
  decision:       'accept' | 'escalate';
  confidence:     number;  // 0-1
  rationale:      string;
  source:         'track_a' | 'track_b' | 'reconciled';
}
// OR on escalate:
{
  decision:            'escalate';
  disagreement_summary: string;
}
```

`FLAG` verdict (from Stage 3 sanity) → HITL queue for v0, same exit as
escalation. Both opinions plus the disagreement_summary are enqueued.

### Stage 3 — Sanity (Standard LLM, always)

Runs on every item that exits Stage 2 with `decision=accept`.

Inputs: final_code + cleaned_description.

Checks: does the chosen 12-digit code plausibly classify this description?
Optionally: is the declared value/currency plausible for this goods category?

Emits:
```
sanity_verdict:   PASS | FLAG | BLOCK
rationale:        string
```

`PASS` → item proceeds to Stage 4 (Declaration).
`FLAG` → HITL queue (v0 policy: all flags are human-reviewed).
`BLOCK` → item excluded from Stage 4, error recorded.

Sanity uses the standard model (not lightweight). World-knowledge and
currency-range reasoning require the stronger model's capabilities.

## Why not merge Stage 2 and Stage 3

They answer different questions:
- Stage 2: "Which of these two opinions is right?"
- Stage 3: "Is the chosen code plausible for this goods description?"

Merging them collapses two independent checks into one prompt, which
reduces catch rate on adversarial inputs: a code that wins reconciliation
can still fail the plausibility check.

## LLM prompt inventory

| Prompt file | Stage | Model tier | Purpose |
|---|---|---|---|
| `description-cleanup.md` | Stage 0b | Lightweight | Extract customs noun, clarity verdict |
| `research-input.md` | Track A / Researcher | Standard | Resolve jargon to canonical description |
| `picker-describe.md` | Track A / Picker | Standard | Pick best 12-digit from retrieval candidates |
| `track-b-pick-replacements.md` | Track B | Lightweight | Pick among deprecated replacement codes |
| `track-b-pick-leaf.md` | Track B | Lightweight | Pick leaf under an expanded prefix |
| `reconciliation.md` | Stage 2 | Standard | Reconcile two-signal disagreements |
| `sanity.md` | Stage 3 | Standard | Plausibility check on final code |

Seven prompts total. Typical per-item LLM call count: 4-5 (cleanup + 1-2 Track A
+ 0-1 Track B + reconciliation if needed + sanity).

## Consequences

**Locks in:**
- Track A is always blind to the merchant code. No configuration flag or operator
  override can expose the merchant code to the description classifier.
- The reconciliation stage owns the "which code wins" decision. Downstream
  consumers (declaration builder, HITL queue, audit trail) read only `final_code`
  from Stage 2 output.
- `FLAG` means HITL for v0. A "emit with flag" path may be opened in v1 once
  ops policy is established.
- Standard LLM for sanity is mandatory. A lightweight model cannot be
  substituted without a new ADR.

**Frees up:**
- Track A and Track B can evolve independently. A better retrieval model,
  a smarter picker, or a richer codebook lookup are each one-module changes.
- Reconciliation is a single pluggable stage. A rule-based fast-path for the
  two-signal-agree case avoids the LLM call in the common case.
- HITL queue is structurally separate. v1 can add ML-triage without touching
  the classification pipeline.

**Trades away:**
- Concurrency overhead: both tracks run per item regardless of confidence.
  Worst-case is 2x the LLM calls of the old single-path flow. Throughput
  model must account for this (see `project_anthropic_via_foundry_only` memory).
- Cold-start alignment: two async branches require both to complete before Stage 2
  can run. Slow Track B (e.g. expand + LLM pick) blocks Stage 2 for the item.

## What this rules out

- A "fast-path" that skips Track A when the merchant supplies a 12-digit code.
  Track A's independence is the point: it catches the adversarial-miscoding
  pattern (ADR-0004) because it cannot be anchored to the merchant's code.
- Feeding Track A's candidates list to Track B. Track B resolves the merchant's
  code against the codebook only. Retrieval results are Track A's internal state.
- A per-operator trust score that weights one track over the other before
  reconciliation. Trust is not Track B's output; correctness is Stage 3's job.

## Revisit triggers

- Measured carry-over / adversarial-miscoding rate drops near zero on real
  Naqel traffic over a sustained window (months). At that point a verify
  fast-path (ADR-0004 revisit trigger) becomes worth reconsidering.
- Reconciliation LLM calls become the binding Foundry quota constraint.
  At that point expand the deterministic agree-shortcut to cover more cases.
- A third track (e.g. image-based classification) lands. At that point this
  ADR is superseded and a new N-track reconciliation design is needed.

## Memory pointer

(none — the decision IS the memory)
