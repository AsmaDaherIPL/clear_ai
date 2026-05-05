# ADR-0005 — The embedder is a swappable component, not a baked-in dependency

Status: accepted, 2026-05-05
Scope: backend `inference/embeddings/` and `inference/retrieval/`
Owner: backend platform

## Context

Retrieval depends on dense embeddings. Today's implementation is
`Xenova/multilingual-e5-small` running in-process via
`@xenova/transformers`, an ONNX runtime loaded into the API container.
See [embedder.ts](clearai-backend/src/inference/embeddings/embedder.ts).

Two costs of in-process embedding are real and observed:

1. **Memory ceiling.** The ONNX pipeline pins ~500 MB of heap once
   loaded. The dev Container App is provisioned at 1 GiB per replica;
   resting working-set sits near 50% of that. There is no headroom for
   Node baseline + request handling + a parallel batch run.
2. **Cold start.** First-request latency includes 10–15 seconds of
   model load. Mitigated by `warmEmbedder()` at boot, but every cold
   replica pays it.

E5-small is a reasonable default for a Saudi customs corpus mostly in
English with some Arabic, but it is not the best multilingual embedder
available, nor is it tuned for HS-code descriptions. Two upgrade paths
have been raised:

- A Foundry-hosted embedding deployment (Anthropic-issued or otherwise),
  same access pattern as the chat models.
- A self-hosted embedder running as a sidecar / separate Container App,
  callable over HTTP — moving the 500 MB out of the API container and
  freeing the memory ceiling.

The point of this ADR is to make sure the choice between those (and
future) alternatives is a config change plus a small adapter, not a
codebase rewrite.

## Decision

Retrieval depends on a small, stable embedder interface, not on
`@xenova/transformers` directly:

```ts
// clearai-backend/src/inference/embeddings/embedder.ts
export async function embedQuery(text: string): Promise<number[]>;
export async function embedPassageBatch(texts: string[]): Promise<number[][]>;
export const EMBEDDER_VERSION: () => string;
export async function warmEmbedder(): Promise<void>;
```

The current implementation in that file uses `@xenova/transformers`.
Any future implementation — Foundry-hosted, sidecar HTTP, a different
in-process model — must satisfy the same four-symbol interface.

`EMBEDDER_VERSION()` is a string identifier, today `env().EMBEDDER_MODEL`,
that uniquely names the embedder used to produce a given vector. It is
recorded alongside any cached embedding so a model swap invalidates the
cache cleanly (no stale-vector retrieval).

Call sites import only from the embedder module:

```bash
$ grep -rn "embedQuery\|embedPassageBatch" clearai-backend/src --include="*.ts"
clearai-backend/src/inference/retrieval/retrieve.ts:44
clearai-backend/src/inference/retrieval/retrieve.ts:138
```

No call site imports `@xenova/transformers` directly. That dependency
edge lives only in [embedder.ts](clearai-backend/src/inference/embeddings/embedder.ts).

## What "swappable" means precisely

| Variant | What changes | What does not |
|---|---|---|
| Different in-process model | `EMBEDDER_MODEL` env var | code |
| Foundry-hosted embedder | `embedder.ts` body (HTTP client) + `EMBEDDER_VERSION` string | call sites, retrieval logic |
| Sidecar / separate Container App | `embedder.ts` body (HTTP client) + memory shape of API container | call sites, retrieval logic |
| Hybrid (in-process + remote fallback) | `embedder.ts` body | call sites |

A swap is, at most, a rewrite of one file and a deployment-config change.

## Why not abstract harder

We deliberately did NOT introduce:

- An `EmbedderClient` interface + DI registry. Two implementations is
  not three; YAGNI.
- A `embeddings/` subfolder split into provider-specific modules
  (`embeddings/xenova.ts`, `embeddings/foundry.ts`). Today there's
  only one provider; adding the structure now is anticipatory
  abstraction.
- A version field threaded through the retrieval pipeline. The
  retrieval layer treats vectors as opaque; only persisted/cached
  vectors need the version tag, and that's a single-call-site concern.

If a third implementation lands, we revisit. Two implementations is
the threshold for an interface; one is just a function.

## Consequences

**Locks in:**
- The four-symbol embedder API. Renaming or removing any of
  `embedQuery`, `embedPassageBatch`, `EMBEDDER_VERSION`,
  `warmEmbedder` is a breaking change requiring a coordinated
  retrieval-side update.
- The "vectors are L2-normalised" assumption. Retrieval uses cosine
  similarity over normalised vectors; any new embedder must produce
  normalised output (or `embedder.ts` must normalise at the boundary,
  as the current implementation does — see `l2()` and the
  `normalize: true` pipeline option).
- Any provider chosen must offer both query and passage modes, or the
  adapter must synthesise the difference at the boundary. E5's
  `query: ` / `passage: ` prefixing convention is leaky; an adapter for
  a non-E5 model has to drop or remap those prefixes.

**Frees up:**
- A Foundry embedder swap is a one-file change, deployable behind a
  feature env var.
- A memory-pressure escape hatch: moving embedding to a sidecar
  reclaims ~500 MB on the API container without touching retrieval.
- An A/B harness can call two embedders behind the same interface and
  diff retrieval recall on the eval set.

## What this trades away

- A second embedder implementation will, briefly, duplicate
  `embedder.ts` knowledge in two places (the interface and the
  swap). That's the cost of not abstracting prematurely.
- `EMBEDDER_VERSION` as a single string is brittle when two
  implementations want to coexist (e.g. cache hit logic that
  understands "this vector is e5-small, that one is foundry-X").
  When that day comes, `EMBEDDER_VERSION` becomes a structured object;
  not now.

## Revisit triggers

- Memory pressure on the dev or prod API container forces an
  embedder move out-of-process (the binding constraint discussed in
  the throughput open item — see [HANDOVER.md](HANDOVER.md) §7).
- A Foundry embedding deployment becomes available and benchmarks
  better than e5-small on the HS-code retrieval eval.
- Retrieval recall drops below acceptable on the 500-row eval suite,
  surfacing the embedder as the bottleneck.

## Memory pointer

`memory/project_embedder_swap_candidate.md`
