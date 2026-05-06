# SPA agent directive — migrate frontend off `/classifications/*` to the new pipeline surface

**Goal:** rewrite the SPA's API client + the two affected pages so the frontend calls the new pipeline endpoints (`/declaration-runs/*`, `/pipeline/submission-description`) instead of the deleted `/classifications/*` surface.

**Why now:** the legacy `/classifications/*` HTTP routes were deleted from the backend in commit [`107b87c`](https://github.com/AsmaDaherIPL/clear_ai/commit/107b87c) (Phase 1 of pipeline rebuild). They currently 404 at the Container App. APIM still has the operations defined and forwards traffic to those 404s. The infra agent is removing the APIM operations next, so within the day the SPA's calls will start failing — preempt that with this migration.

**Backend will not be reverted** to expose the legacy URLs. The pipeline is the durable surface.

---

## API surface change

### Old (gone or about to be gone from APIM)

| Method | Path | What the SPA used it for |
|---|---|---|
| `POST` | `/classifications` | Single-shot classify a description |
| `POST` | `/classifications/expand` | Expand a 4-10 digit prefix to a 12-digit leaf |
| `GET` | `/classifications/{id}` | Trace page — show a stored classification + feedback |
| `POST` | `/classifications/{id}/submission-description` | Lazy fetch ZATCA Arabic for a stored result |
| `POST` | `/classifications/{id}/feedback` | Record human feedback on a result |

### New

The new surface is built around **declaration runs** (bulk, multi-item) — but the SPA's current UX is **single-item** (one description in, one classification out). Two ways to bridge this gap. **Use Approach 1.**

**Approach 1 — single-item dispatch (recommended).**

The pipeline's per-item entry point is `dispatch()` in [src/modules/dispatch/dispatch.use-case.ts](clearai-backend/src/modules/dispatch/dispatch.use-case.ts). Today there's no HTTP endpoint that exposes it directly. **Backend agent (me) will add `POST /pipeline/dispatch` so the SPA has a single-item path.**

Until that endpoint ships, the SPA can either:
- (a) Wrap a single item in a 1-row CSV and call `POST /declaration-runs`, then poll `/declaration-runs/:id/classifications` — heavy, ~5 sec, awkward.
- (b) Hold its rewrite until `POST /pipeline/dispatch` is live (next backend PR).

**Recommendation: hold the SPA migration on the API-client layer for ~24h until I ship `POST /pipeline/dispatch`.** Don't burn time on (a). Start now on the trace + submission-description bits that are already shipped.

**Mapping table (when single-item dispatch lands):**

| Old SPA call | New SPA call | Notes |
|---|---|---|
| `api.classify({ description })` | `POST /pipeline/dispatch` body `{ description }` | Same input. Output shape changes (PipelineResult, not DescribeResponse). |
| `api.expand({ code, description })` | `POST /pipeline/dispatch` body `{ description, merchant_code: code }` | The new pipeline auto-detects whether the merchant code is twelve_digit / short_prefix / absent. The "expand" semantics are now Track B's `llm_pick_under_prefix` resolution — same plumbing, no separate endpoint. |
| `api.trace(id)` | `GET /pipeline/trace/:id` | **NOT YET SHIPPED.** Backend agent (me) will add this in the same PR as `POST /pipeline/dispatch`. |
| `api.submissionDescription(id)` | `POST /pipeline/submission-description` body `{ description, code }` | **Already shipped** — `clearai-backend/src/modules/pipeline/submission-description/submission-description.routes.ts`. Note: takes `description` and `code` directly, not a classification id. The SPA needs to pass the cleaned description and chosen code from the dispatch result. |
| `api.feedback(id, body)` | `POST /hitl/queue/:id/resolve` body `{ chosen_code, reviewer_id, note? }` | **NOT YET SHIPPED.** Different semantic: feedback was free-form "confirm/reject/prefer-alt"; the new HITL queue is "human picks the right code." If the SPA needs a feedback path that isn't HITL resolution, we need a separate endpoint — flag if so. |
| `api.health()` | `GET /health` | Unchanged. APIM short-circuits this. |

### Response shape changes

The new `POST /pipeline/dispatch` returns `PipelineResult` (defined in [src/modules/pipeline/shared/pipeline.types.ts](clearai-backend/src/modules/pipeline/shared/pipeline.types.ts)):

```ts
interface PipelineResult {
  final_code: string | null;
  goods_description_ar: string | null;   // ZATCA Arabic, ≤300 char
  sanity_verdict: 'PASS' | 'FLAG' | 'BLOCK';
  trace: PipelineTrace;                   // full per-stage trace
}
```

Compared to today's `DescribeResponse`, the changes:

- `decision_status` (accepted/needs_clarification/degraded/best_effort) → **gone**. Replaced by `sanity_verdict`. Map `PASS` → "accepted", `FLAG` → "needs review", `BLOCK` → "rejected".
- `decision_reason` → gone. The trace's `verdict.rationale` and `sanity.rationale` now carry the human-readable reason.
- `chosen_code` → `final_code`.
- `alternatives` → moved into `trace.track_a.alternatives`.
- `confidence_band` (high/medium/low) → gone. The numeric `trace.verdict.confidence` (0-1) replaces it; map by threshold if you need a band.
- `descriptionAr` (catalog Arabic) → `goods_description_ar` (LLM-generated, ZATCA-safe).
- `model_calls` array → moved into `trace.stages` (each stage entry has its own latency/model info).

The full TypeScript shapes for everything in `trace` are in `pipeline.types.ts` and `domain.types.ts` — read those for ground truth.

### Auth

No change. APIM still validates Entra JWT, still injects `x-apim-shared-secret`. SPA's MSAL flow + BFF still work the same way. Only URLs change.

---

## What you need to do

### Phase 0 — Wait for me (~24h)

I need to ship two new endpoints before your migration can be 1:1. Don't burn cycles on workarounds:

- `POST /pipeline/dispatch` — single-item entry to the pipeline
- `GET /pipeline/trace/:id` — fetch a stored trace by id

When those are live, the OpenAPI YAML (`clearai-backend/openapi.yaml`) will be updated. The SPA's API client should also generate types from that YAML — recommend `openapi-typescript` (compiled types) or `openapi-typescript-codegen` (full client). Pick one before Phase 1.

In the meantime, you can:

- Read [src/modules/pipeline/shared/pipeline.types.ts](clearai-backend/src/modules/pipeline/shared/pipeline.types.ts) and [src/modules/pipeline/shared/domain.types.ts](clearai-backend/src/modules/pipeline/shared/domain.types.ts) so you understand the new shapes.
- Read [openapi.yaml](clearai-backend/openapi.yaml) for the endpoints already shipped.
- Plan how `DescribeResponse` → `PipelineResult` maps onto the existing `ResultSingle.tsx` UI.

### Phase 1 — Rewrite `src/lib/api.ts`

Replace the 5 method bodies with calls to the new endpoints. Keep the method names where it makes sense (`classify`, `expand`, `submissionDescription`) so the call sites in `ClassifyApp.tsx` and `TracePage.tsx` only need shape adjustments, not full rewrites.

```ts
export const api = {
  health: () => request<HealthResponse>('/health'),
  dispatch: (b: { description: string; merchant_code?: string }) =>
    request<PipelineResult>('/pipeline/dispatch', { method: 'POST', body: JSON.stringify(b) }),
  trace: (id: string) =>
    request<PipelineTraceResponse>(`/pipeline/trace/${encodeURIComponent(id)}`),
  submissionDescription: (description: string, code: string) =>
    request<SubmissionDescriptionResponse>('/pipeline/submission-description', {
      method: 'POST',
      body: JSON.stringify({ description, code }),
    }),
  // feedback() — see "open question" below
};
```

Note: there's no longer a separate `expand()`. The new dispatch detects merchant-code state internally (Track B handles short prefix + 12-digit + absent uniformly).

### Phase 2 — Update `ClassifyApp.tsx`

The page state machine doesn't need to change much. The big shift is:

- `decision_status` switch (4 branches) → `sanity_verdict` switch (3 branches: PASS / FLAG / BLOCK).
- The "expand a parent prefix" code path (lines around 110) collapses into the same dispatch call — just pass `merchant_code` alongside `description`. The `expandRes` branch goes away.
- `model_calls` consumer code → reads from `trace.stages` instead.

### Phase 3 — Update `TracePage.tsx`

This is the bigger lift. The trace shape goes from "model_calls + classification_events row" to "PipelineTrace" (track_a, track_b, verdict, sanity, stages array). The page already has a "Raw JSON" tab — that survives unchanged. The visualisation tabs need rewiring.

Suggest: build the Phase 3 work as **a fresh `TracePage` that consumes `PipelineTrace`** rather than incrementally morphing the existing one. Keep the old `TracePage.tsx` around as `TracePage.legacy.tsx` until the new one is solid.

### Phase 4 — Feedback / HITL question (open)

The old `POST /classifications/{id}/feedback` accepted three kinds: `confirm`, `reject`, `prefer_alternative`. The new HITL surface (`POST /hitl/queue/:id/resolve`) is "the reviewer picked the correct code." Different semantic.

Two possibilities:

- **(a)** Drop the SPA feedback feature entirely. The pipeline's HITL queue serves the same role.
- **(b)** Keep a "lightweight feedback" endpoint for non-HITL use. Backend would add `POST /pipeline/runs/:id/feedback` or similar.

User hasn't decided. Don't build either branch yet — flag back when you reach Phase 4.

---

## What you should NOT do

- Don't try to keep the old URL paths. The backend doesn't serve them anymore; reviving them as shims would create two parallel APIs that drift.
- Don't write your own response-shape adapter that pretends `PipelineResult` is `DescribeResponse`. The new shape is the contract; rebuild the UI against it.
- Don't update auth — MSAL/BFF flow is unchanged.
- Don't update the OpenAPI YAML — that's the backend agent's source of truth.

---

## Open questions back to me (the backend agent)

When you start Phase 1 and 2, ping me with:

- **What's missing from `PipelineResult`** that the UI needs? I built the type for the orchestrator, not for the UI; if there are fields you need (e.g. tenant slug, request id, timestamps) that aren't surfaced today, we should add them rather than have the SPA infer them.
- **Submission-description timing.** Today's UX (`SubmissionDescriptionCard.tsx`) loads it lazily after the user sees the result. The new endpoint takes (description, code) — does the SPA still want lazy load, or should I add it to `PipelineResult` so it comes back with the dispatch response in one round-trip? Lazy is cheaper at the LLM tier; eager is one fewer HTTP call.
- **Feedback semantic** — see Phase 4.

---

## Definition of done

- [ ] All `/classifications/*` URLs removed from the SPA.
- [ ] `api.ts` exports `dispatch`, `trace`, `submissionDescription`, `health` (and optionally `feedback`).
- [ ] `ClassifyApp.tsx` and `TracePage.tsx` compile cleanly against the new shapes.
- [ ] Smoke test: classify a description in the SPA against a deployed backend; result renders, trace renders, submission-description loads.
- [ ] If using OpenAPI codegen — types in `src/lib/api.types.ts` are generated from `clearai-backend/openapi.yaml` (don't hand-write).
- [ ] No `DescribeResponse`, `ExpandBoostResponse`, `TraceResponse` (old shapes) left in the codebase.

Ping me when you're ready to start, or earlier if any of the above is ambiguous.
