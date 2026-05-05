# ADR-0001 — Anthropic API access is via Azure AI Foundry only

Status: accepted, 2026-05-04
Scope: backend LLM calls
Owner: backend platform

## Context

ClearAI's classification pipeline depends on Anthropic models (Sonnet for the picker,
Haiku for cheap helper calls and the sanity check). Two access paths exist:

1. **Direct** — `api.anthropic.com` with an Anthropic-issued API key.
2. **Foundry** — Azure AI Foundry deployments (`aif-infp-dev-swc-01`) that re-expose
   Anthropic models through the Azure control plane.

The infrastructure team provisioned us a Foundry deployment and explicitly did not
provision direct Anthropic access. Reasons given: enterprise procurement runs through
Azure, the Saudi data-residency story is cleaner with a Saudi-region Foundry
deployment, and billing consolidates against the Azure subscription that already
holds Container Apps + Postgres.

The downside is real: Foundry exposes only the standard Messages endpoint. Direct
Anthropic exposes the **Message Batches API** (50% discount, 24-hour async) and a
handful of beta features (computer use, certain prompt-caching variants).

## Decision

All Anthropic calls in ClearAI go through the Azure AI Foundry deployment. The
client at `clearai-backend/src/inference/llm/client.ts` reads the Foundry
endpoint + key from env (`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`) and never
talks to `api.anthropic.com`.

We will **not** propose Batch API as an optimisation lever. The only throughput
lever for bulk processing is concurrency — in-process `p-limit` for v0
(`src/common/concurrency/semaphore.ts`), Service Bus + Container Apps Job for v2.

## Consequences

**Locks in:**
- Cost optimisation has to come from prompt-token reduction, model choice
  (Haiku where Sonnet isn't needed), and concurrency tuning — not from Batch API.
- Latency is bounded by Foundry RPM/TPM quotas on the deployments
  (`claude-haiku-4-5-clearai-dev`, `claude-sonnet-4-6-clearai-dev`). Quota
  upgrades happen in the Azure portal, not via Anthropic billing.
- Any Anthropic feature only exposed at `api.anthropic.com` is unavailable to us
  until verified in Foundry.

**Frees up:**
- Single billing surface (Azure).
- Saudi data-residency story is straightforward.
- No second secret store / rotation policy for Anthropic keys.

## What this rules out

- Asynchronous bulk classification via Batch API.
- Computer-use beta and any other Anthropic-direct-only feature without a
  Foundry verification step first.
- A "fall back to direct Anthropic if Foundry is down" failover path. If we
  ever need that, it's a new ADR with infra sign-off.

## Revisit triggers

- Foundry quota becomes the binding constraint on a real customer batch and
  the Azure portal will not approve further upgrades.
- Anthropic ships a feature critical to ClearAI that doesn't appear in Foundry
  within 6 months of GA.
- Saudi data-residency requirements relax (unlikely).

## Memory pointer

`memory/project_anthropic_via_foundry_only.md`
