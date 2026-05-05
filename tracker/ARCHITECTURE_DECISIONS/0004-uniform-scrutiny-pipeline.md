# ADR-0004 — Every classification path goes through the same scrutiny pipeline

Status: accepted, 2026-05-05
Scope: backend dispatch + hs-classification + batches modules
Owner: dispatch-flow agent (with batches consumer)

## Context

ClearAI's batch ingest accepts shipment lines in four very different
states of "already classified":

1. **Verify** — line arrives with a 12-digit HS code AND a description.
   Plausible-looking, but unverified. The historical Naqel pattern:
   broker types or copy-pastes a code that may or may not match the
   description.
2. **Expand** — line arrives with a short HS code (6-, 8-, or 10-digit)
   plus a description. Needs a leaf descent to the 12-digit child that
   actually fits.
3. **Classify** — line arrives with description only, no code at all.
4. **Researcher** — line arrives with shorthand or an under-described
   string ("Apple x10", "spare parts box"). Needs context-gathering
   before classification can run.

A plausible reading of the world says: trust the verify path. If the
broker provided a 12-digit code and a matching description, accept it
and skip the LLM. That reading has been considered and rejected.

Two recurring failure modes drove the rejection:

- **Carry-over codes.** Broker copies a code from a previous shipment
  with a vaguely similar description; the codes diverge at the 8th or
  10th digit and the duty rate is wrong. Pattern is invisible to a
  syntactic check.
- **Adversarial mis-coding.** Importer asks the broker for a
  lower-duty sibling code. A description-only check ("does this code
  *plausibly* fit this description?") passes, even though the code is
  technically wrong.

Both failures are silent under syntactic-only validation, and both are
exactly what ClearAI is meant to catch.

## Decision

Every classification path — verify, expand, classify, researcher —
ends at the same final scrutiny gate before a code is accepted.

Concretely: regardless of the entry path, every item that exits Phase 1
of the batch pipeline carries a `DispatchResult` with three fields:

```ts
// clearai-backend/src/modules/batches/classification/batch-classification.types.ts
export interface DispatchResult {
  finalCode: string;
  sanityVerdict: 'PASS' | 'FLAG' | 'BLOCK';
  trace: ItemTrace;
}
```

The `sanityVerdict` comes from a single sanity-check stage that runs at
the tail of dispatch, after path-specific work (verify reconciliation,
expand descent, classify, researcher) has produced a candidate code.
The sanity check is the same code, the same prompt, the same model,
regardless of which path produced the candidate.

`PASS` → item status `succeeded`. `FLAG` → status `flagged`
(human-reviewable, still eligible for Phase 2). `BLOCK` → status
`blocked` (excluded from Phase 2). Mapping is in
[batch-classification.service.ts:36](clearai-backend/src/modules/batches/classification/batch-classification.service.ts:36).

Phase 2 (declaration) only consumes items in `succeeded` or `flagged`
status — never `blocked` or `failed`. See ADR-0003.

## What "uniform" means precisely

| Path | Path-specific work | Then |
|---|---|---|
| Verify | reconciliation against provided code | sanity check |
| Expand | tenant code-override → leaf descent | sanity check |
| Classify | retrieval + picker | sanity check |
| Researcher | context-gathering → classify | sanity check |

The path-specific work is real and necessary. The sanity check at the
end is what makes the four paths interchangeable from the consumer's
point of view: a Phase 2 declaration builder, a frontend trace viewer,
and an eval harness all see the same `DispatchResult` shape and don't
need to know which path produced it.

The trace IS allowed to record path-specific stages (`trace.pathTaken`
+ `trace.stages` in the same types file). The verdict is not.

## Consequences

**Locks in:**
- Verify cannot be a fast-path that skips the LLM. Even when the
  broker-provided code is correct, we pay one Haiku-tier sanity call
  per item. Throughput modelling has to assume one LLM call per item
  minimum, on top of any retrieval/picker calls the path itself makes.
- The sanity prompt is a single point of risk. A regression in that
  prompt regresses every path simultaneously. The eval suite at commit
  `8b0660b` is the safety net; expand it before any sanity-prompt change.
- The sanity check has to handle every path's output shape. It can't
  assume "the candidate came from the picker" or "the candidate came
  from a broker". Test fixtures must cover all four entry paths.

**Frees up:**
- One serialisation contract (`DispatchResult`) for everything
  downstream. Phase 2, the trace viewer, and any future bulk consumer
  read the same fields.
- The four entry paths can evolve independently as long as they
  produce a candidate code and structured trace. Today's researcher
  path can be replaced wholesale tomorrow without touching Phase 2.
- A single place to attach future cross-cutting checks (duty-rate
  sanity, country-of-origin compatibility, dual-use export flags). New
  checks compose into the sanity stage, not into each path.

## What this rules out

- A "trust verify" config flag that skips the sanity check when the
  broker-provided code matches the description by retrieval similarity.
  The carry-over and adversarial-miscoding failure modes both pass
  retrieval similarity.
- Path-specific verdict types. The sanity verdict is one of three
  values, total. If we need richer detail, it goes in `trace`, not in
  the verdict.
- Bypassing the sanity check via tenant config. A tenant cannot opt
  out of scrutiny. They can opt out of *Phase 2* (`mode=classify_only`),
  but not out of the gate.

## What this trades away

- Latency floor per item is one sanity-check LLM call. For a
  300-item batch with verify-mostly traffic, that's 300 Haiku calls
  we could in principle have skipped. The trade is acceptable because
  the failure modes the gate catches are exactly the ones a pure
  retrieval-similarity check misses.
- The dispatch implementation becomes the sole owner of "what is the
  current candidate code" until the sanity stage. That's a real
  coupling — the four entry paths can't return early with their own
  verdict.

## Revisit triggers

- A measured carry-over / adversarial-miscoding rate near zero on
  real Naqel traffic over a sustained window (months, not weeks).
  At that point the cost-of-skipping-sanity argument becomes weaker
  and a verify fast-path can be reconsidered.
- An eval harness gains coverage strong enough to catch sanity
  regressions on its own (currently the prompt is the gate; without it
  the eval is the only line of defence).
- Foundry quota becomes the binding constraint and one sanity call
  per item is genuinely the bottleneck (memory
  `project_anthropic_via_foundry_only` — concurrency is the lever).

## Memory pointer

(none — the decision IS the memory)
