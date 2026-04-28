# Architecture Decisions — ClearAI v1

A running log of architectural decisions made during the v1 build. Each entry is a short ADR: **what was decided, why, what was rejected, and what would force us to revisit.**

Entries are append-only. New decisions go at the bottom with a fresh number. Never edit an old entry — supersede it with a new one and link.

---

## ADR-0001 — Status-driven decision contract (replaces confidence numbers)

- **Date:** 2026-04-26
- **Status:** Accepted
- **Context:** Earlier draft used a numeric `confidence` field on every endpoint response. The number conflated three different signals (retrieval strength, LLM self-report, operational state) and was uncalibrated, making it unsafe for batch consumers to threshold on.
- **Decision:** Every endpoint returns a shared envelope with `decision_status ∈ {accepted, needs_clarification, degraded}` and `decision_reason` from a closed enum (`strong_match`, `single_valid_descendant`, `already_most_specific`, `weak_retrieval`, `ambiguous_top_candidates`, `invalid_prefix`, `guard_tripped`, `llm_unavailable`). An optional `confidence_band ∈ {high, medium, low}` is added later, calibrated from eval data — **not a probability**.
- **Rejected:** keeping uncalibrated numeric confidence; using `retrieval_score` alone (cannot capture LLM/guard/operational states).
- **Consequences:** Batch ZATCA jobs branch on a small set of statuses, not on float thresholds. Logs (`classification_events`) carry the same status enum. Calibration buckets `confidence_band` once we have an eval set.
- **Revisit if:** consumers genuinely need a probability (e.g. for cost-weighted routing). Not for v1.

---

## ADR-0002 — LLM never rescues weak retrieval (Evidence Gate)

- **Date:** 2026-04-26
- **Status:** Accepted
- **Context:** Allowing the LLM to make a call when retrieval is weak masks failures: a confident-sounding answer derived from a poor candidate set is worse than abstaining.
- **Decision:** Every endpoint runs an Evidence Gate **before** any LLM call. The gate compares `top_retrieval_score` and `top2_gap` against per-endpoint thresholds (`MIN_SCORE_<endpoint>`, `MIN_GAP_<endpoint>`) stored in `setup_meta`. Gate fail → skip LLM entirely → `decision_status='needs_clarification'`.
- **Rejected:** "fuzzy clearly-dominates" heuristic; letting the LLM see-and-decide.
- **Consequences:** Saves LLM tokens on unrescuable rows. Keeps batch outcomes traceable to retrieval metrics. Thresholds start as placeholders; tuned with the eval set (see §A.9).
- **Revisit if:** eval data shows we are abstaining too aggressively on rows the LLM could have handled.

---

## ADR-0003 — Digit normalization replaces hint logic

- **Date:** 2026-04-26
- **Status:** Accepted
- **Context:** Free-text inputs sometimes carry digit runs (`"shirt 89123"`). Earlier drafts proposed silent endpoint routing or advisory hints. Both are wrong for batch ZATCA — there is no human in the loop to react to a hint, and silent routing creates surprise.
- **Decision:** Deterministic per-length rules at `/classify/describe` ingress:
  - `<4` digits → keep as text noise
  - 4–11 digits, no chapter/heading match → strip silently
  - 4–11 digits, matches a real `chapter` or `heading` → keep + soft RRF bias (not hard filter)
  - exactly 12 digits matching a real row → **deferred for v1** (TBD, pending Naqel data review)
  - `>12` digits → text noise
- **Rejected:** auto-route to `/expand` or `/boost`; hint output back to the caller.
- **Consequences:** No surprises, batch-consumer friendly. Implementation is a small pure function with a unit test per case.
- **Revisit if:** Naqel data shows >5 % of inputs have valid 12-digit runs and we want to route those automatically.

---

## ADR-0004 — Structured `missing_attributes[]` replaces free-text clarification

- **Date:** 2026-04-26
- **Status:** Accepted
- **Context:** Earlier drafts had a free-text `clarification_prompt` field for `needs_clarification` outcomes. Useless for batch — a downstream pipeline cannot parse English questions.
- **Decision:** `needs_clarification` responses include `missing_attributes: Array<'material' | 'intended_use' | 'product_type' | 'dimensions' | 'composition'>`. Closed enum. Caller can branch on it deterministically.
- **Rejected:** free-text questions; LLM-generated questions.
- **Consequences:** Caller can re-ingest with augmented payloads or route to a human queue per attribute kind.
- **Revisit if:** the closed enum proves too narrow for real Naqel data.

---

## ADR-0005 — Hierarchy derived from 12-digit prefix at ingestion

- **Date:** 2026-04-26
- **Status:** Accepted
- **Context:** The Zatca tariff Excel only has 33 HS4 headings + ~19 105 twelve-digit codes. No HS6/HS8/HS10 rows.
- **Decision:** At ingest, derive `chapter`, `heading`, `hs6`, `hs8`, `hs10`, `parent10` columns from `substring(code, 1, N)`. Index `parent10` for `/boost` sibling lookups. The Excel remains the **sole source of truth** for HS metadata.
- **Rejected:** importing a separate hierarchy file; treating HS4 rows as classifiable.
- **Consequences:** `/boost` is `WHERE parent10 = $1 AND code != $2`. Simple, fast, indexable.
- **Revisit if:** ZATCA publishes HS6/8/10 description rows we want to surface.

---

## ADR-0006 — Foundry LLM via direct fetch to Target URI (not SDK baseURL)

- **Date:** 2026-04-26
- **Status:** Accepted
- **Context:** Azure AI Foundry's Anthropic-compatible Target URI is the **complete** path including `/v1/messages`. The `@anthropic-ai/sdk` would append `/v1/messages` to its `baseURL`, breaking the call.
- **Decision:** Implement `src/llm/client.ts` as a thin `fetch` POST to `ANTHROPIC_BASE_URL` (= the full Target URI), with `x-api-key` header and the standard Anthropic request/response JSON. Same wire format as the SDK.
- **Rejected:** monkey-patching the SDK; stripping `/v1/messages` from the env var.
- **Consequences:** No SDK dependency for the LLM call path. Easier to swap to direct Anthropic later (just change the URL).
- **Revisit if:** Foundry changes its endpoint shape or we need SDK-only features (streaming helpers, tool-use convenience).

---

## ADR-0007 — GIR rules injected via distilled system prompt (Option B1)

- **Date:** 2026-04-26
- **Status:** Accepted
- **Context:** WCO General Interpretation Rules govern HS classification tie-breaks. Three options were considered: skip (A), distilled summary (B1), full PDF→MD inlined (B2), full RAG (C).
- **Decision:** Hand-write `prompts/gir-system.md` (~400 tokens: GIRs 1–6 + 4 worked examples) and inject it into the system prompt for `/classify/describe` (Sonnet) and `/classify/expand` (Haiku). `/boost` does not use GIRs. The official PDF (`/Users/asma/Desktop/Customs AI/sharepoint/other/hs-interpretation-general-rules_0001_2012e_gir.pdf`) remains the source of truth; we only convert it to MD if/when we move to B2 (full inline) or C (RAG).
- **Rejected:** A (skip — loses tie-break consistency); B2 (full inline — +3,600 tokens/call for marginal gain); C (RAG — overkill for v1).
- **Consequences:** ~$0.0001–0.0012 added cost per call. ~3–7 % accuracy improvement on ambiguous queries. **Big win is batch consistency and auditability** — rationale cites a known rule, not vibes.
- **Revisit if:** post-launch eval data shows specific GIR-edge-case failures the distilled summary misses → swap to full inline or move to RAG over chunked GIR text.

---

## ADR-0008 — Drop HS4 heading rows from `hs_codes` at ingest

- **Date:** 2026-04-26
- **Status:** Accepted
- **Context:** The Zatca tariff Excel mixes 33 four-digit HS4 heading rows with 19,105 twelve-digit leaves. The original ingest padded HS4 codes with zeros (`0101` → `010100000000`) and used `ON CONFLICT (code) DO NOTHING` to absorb collisions with real HS12 codes (e.g. genuine `010100000000` "Live horses"). That silently dropped one row of every collision pair with zero log signal — and worse, the HS4 padded row could win the conflict and shadow a real leaf. HS4 rows were never actually returned in any retrieval path (every query filters `is_leaf = true`).
- **Decision:** Filter HS4 rows out at ingest time. Only 12-digit codes are inserted into `hs_codes`. The DB-level CHECK constraints in 0002_hardening.sql (`raw_length = 12`, `is_leaf = true`, `code ~ '^[0-9]{12}$'`) lock the invariant. The ingest log reports the HS4 skip count for traceability.
- **Rejected:** keeping HS4 rows with `is_leaf=false` and a synthetic non-padded code (would require a separate code shape, complicating retrieval); using a separate `hs_headings` table (no consumer needs it in v1).
- **Consequences:** Schema invariant simplifies ("every row is a HS12 leaf"). DB-enforced. No risk of silent collision-drop. If we ever need HS4 metadata (titles, notes), we can derive it from any leaf's `heading` prefix or load it separately.
- **Revisit if:** a future endpoint needs HS4 heading descriptions surfaced (e.g. an "HS4 lookup" sidebar).

---

## ADR-0009 — Fail-closed `setup_meta` loader; typed `value_numeric` column

- **Date:** 2026-04-26
- **Status:** Accepted
- **Context:** The original `loadThresholds()` silently substituted hard-coded fallbacks (`MIN_SCORE_describe = 0.30`, etc.) when a row was missing or non-numeric. For a batch ZATCA pipeline this is dangerous: a typo in a key, a wiped row, or a non-numeric `value` lets the Evidence Gate run with stale assumptions and zero log signal. There is no human in the loop to notice the drift.
- **Decision:** (1) Add `value_numeric double precision` and `value_kind text CHECK (value_kind IN ('number','string'))` columns to `setup_meta`, with a CHECK that `value_kind='number' ⇒ value_numeric IS NOT NULL`. (2) The loader reads only `value_numeric` for numeric tunables and **throws** if any required key is missing or has the wrong `value_kind`. No fallback path. (3) A `BEFORE UPDATE` trigger bumps `updated_at` on every change so config edits are always traceable (the previous `DEFAULT now()` only fired on INSERT).
- **Rejected:** keeping silent fallbacks (operational risk); making fallbacks logged-but-applied (still hides drift in batch); using JSONB instead of typed column (overkill for a flat numeric tunable).
- **Consequences:** A misconfigured DB fails fast at first request. Operators must run `pnpm db:migrate` (which seeds defaults) before the server can serve. The legacy text `value` column is preserved for human readability but is no longer authoritative.
- **Revisit if:** we genuinely need per-tenant overrides or staged rollout of threshold changes — at that point introduce a separate `setup_meta_overrides` table rather than weakening the fail-closed contract.

---

## ADR-0010 — Use Drizzle's built-in migrator (replaces custom `migrate.ts`)

- **Date:** 2026-04-26
- **Status:** Accepted (supersedes the custom raw-SQL migrator that briefly lived in `src/scripts/migrate.ts`)
- **Context:** During the initial scaffold we hand-wrote a small migrator that read every `drizzle/*.sql` file in order and tracked applied filenames in a custom `_migrations` table. Two reasons it existed: (1) drizzle-kit's `generate` cannot emit `CREATE EXTENSION` / `CREATE TRIGGER FUNCTION`, so the SQL files have to be hand-authored regardless; (2) we wanted explicit control over statement-breakpoint splitting. Both turned out to be non-reasons — Drizzle's runner already executes raw `*.sql` files exactly as written and already understands `--> statement-breakpoint`. The custom code was reinventing functionality the library ships with. **Project rule of thumb: prefer existing libraries over hand-rolled equivalents.**
- **Decision:** Replace `src/scripts/migrate.ts` with a 10-line wrapper around `migrate()` from `drizzle-orm/node-postgres/migrator`. Keep the hand-authored `drizzle/*.sql` files unchanged (extensions, triggers, CHECK constraints, seed inserts all stay raw SQL). Maintain `drizzle/meta/_journal.json` as the ordered manifest. Restore `db:generate` script for future schema-table changes (drizzle-kit emits regular CREATE TABLE / ALTER TABLE diffs; raw SQL files are appended manually for extensions/triggers and tracked in the same journal).
- **Rejected:** keeping the custom runner (was reinventing the wheel and tracked filenames only — would silently miss content drift if an applied file was edited); using drizzle-kit's `migrate` CLI command (overkill for production; programmatic call from a tsx script is cleaner and survives in container deploy contexts without bringing the kit dependency along).
- **Consequences:**
  - Library handles the ledger (`drizzle.__drizzle_migrations`, hash-based — detects edits to applied files and refuses to run).
  - Library handles statement-breakpoint splitting and transaction wrapping per migration.
  - One-time data fix: backfilled `drizzle.__drizzle_migrations` with SHA-256 hashes of the existing three SQL files so they don't re-run against an already-populated DB.
  - `_migrations` table dropped.
  - **Stricter behaviour:** editing an already-applied SQL file now changes its hash and the migrator will refuse to proceed — the correct fix is always to add a new migration. The custom runner allowed silent edits.
- **Revisit if:** we ever need migrations to run across multiple databases in one transaction, or want a custom locking strategy (advisory locks beyond what Drizzle does). No current need.

---

<!-- New decisions append below. Do not edit existing entries. -->

## ADR-0011 — Stateless v2 control flow + best-effort fallback

- **Date:** 2026-04-28
- **Status:** Accepted
- **Context:** v1 `/classify/describe` had two failure modes on hard inputs (jargon, brand SKUs, abbreviated descriptions, generic product names with insufficient context): (a) it confidently returned a wrong 12-digit code because retrieval happened to cluster around an unrelated tariff family; (b) it returned `needs_clarification` with no actionable code at all. Operators asked for "always return a result" — but a fully confident 12-digit answer for ambiguous input is a liability. We also flirted with a per-product-code cache and a regex "merchant-shorthand detector" prefilter; both were rejected as either non-stateless (cache) or too specific to scale (detector — see Rejected below).
- **Decision:**
  1. **Stateless control flow.** Every request is handled from raw input. No catalog, no per-product memory, no profile state. The order is: retrieve → `checkUnderstanding` → optional researcher → gate → picker (called at most once) → optional best-effort fallback. Worst case 3 LLM calls (researcher + picker + fallback); common case 1 (picker only).
  2. **Two-stage understanding signal driven by retrieval, not the LLM.** `checkUnderstanding` counts distinct HS-2 chapters among the top-N candidates (window and threshold both come from `setup_meta`). Coherent inputs cluster; ambiguous inputs scatter. If scattered, the route invokes the researcher (strong model) which returns `RECOGNISED: <canonical>` or `UNKNOWN: <reason>`; the canonical phrase replaces the input for re-retrieval.
  3. **Best-effort fallback as a third decision class.** When the picker abstains, the gate refuses, or the researcher returns UNKNOWN, and `setup_meta.BEST_EFFORT_ENABLED = 1`, the route asks the strong model for a low-specificity heading (capped by `BEST_EFFORT_MAX_DIGITS`, default 4). Returns `decision_status: 'best_effort'`, `decision_reason: 'best_effort_heading'`, `confidence_band: 'low'`. The frontend gates this behind a verify-toggle (`BestEffortCard`) — visually distinct from `accepted`, never copyable until the user acknowledges.
  4. **Configuration over code.** Eight v2 tunables (`UNDERSTOOD_TOP_K_describe`, `RETRIEVAL_TOP_K_describe`, `PICKER_CANDIDATES_describe`, `ALTERNATIVES_SHOWN_describe`, `RESEARCHER_MAX_TOKENS`, `BEST_EFFORT_MAX_TOKENS`, `BEST_EFFORT_ENABLED`, `BEST_EFFORT_MAX_DIGITS`) live in `setup_meta`, validated by the fail-closed loader (ADR-0009). Booleans are encoded as 0/1 numbers because `setup_meta_value_kind_chk` only allows `('number','string')`. Migration 0003 also widens `events_decision_status_chk` to include `'best_effort'` and `events_decision_reason_chk` to include `'brand_not_recognised'` and `'best_effort_heading'`.
- **Rejected:**
  - **Per-product-code or brand catalog.** Violates the stateless principle and creates a maintenance burden (catalog freshness, GDPR/data-retention concerns, leakage between merchants).
  - **Regex "merchant-shorthand detector" prefilter.** Briefly considered to short-circuit jargon inputs straight to the researcher, saving a retrieval round-trip. Rejected: the optimisation saves ~50–150 ms on a subset of inputs but adds 130 lines of pattern code, has high false-negative rate (any brand without an SKU suffix slips through — TitleCase product names, common-noun product lines), and false positives silently regress quality (plain inputs containing 2-digit numbers get routed to the researcher unnecessarily). `checkUnderstanding` already catches the same failure mode using actual evidence (retrieval scores) instead of guesses about text shape.
  - **Confident 12-digit output on hard inputs.** Causes incorrect customs classification with legal/financial consequences. Best-effort at 4-digit chapter level is the least-harmful starting point for a customs broker to refine.
  - **Fallback at 12-digit specificity with `confidence_band: 'low'`.** Same problem at a different label — users still treat 12-digit codes as final. Capping specificity is the structural guard.
- **Consequences:**
  - The route always returns *something*: `accepted`, `best_effort`, `needs_clarification`, or `degraded`. No more silent dead-ends.
  - Best-effort responses include a model-emitted rationale (1 sentence, ≤ 200 chars) explaining the chapter pick. Logged to `classification_events` as a regular row with `decision_status='best_effort'` so audit/eval queries can isolate them.
  - Tuning is done in `setup_meta` and prompt files — no code redeploy needed to adjust window size, top-K, fallback specificity, or prompt wording.
  - The frontend now has three result-shape branches (`HSResultCard`, `BestEffortCard`, `NotAcceptedCard`). The Best-Effort card uses dashed amber border, partial code grid with `··` placeholder slots for absent digits, and a required acknowledge-checkbox before the copy button is enabled.
  - **Working rule established:** make the design and flow simple and generic; tune via `setup_meta` and prompts to improve judgement. Never ship product-specific code branches or test-set-specific examples in comments/prompts. The repo `grep`s clean of brand names from the test set.
- **Revisit if:**
  - The best-effort fallback is invoked on > ~20% of production requests — that signals retrieval/picker calibration drift that should be fixed at the source rather than masked by fallback.
  - Operators need a fourth specificity level (e.g. 6-digit fallback for high-confidence-on-family but ambiguous-at-subheading cases) — reuse the `BEST_EFFORT_MAX_DIGITS` row, no schema change needed.
  - Multi-tenant/per-merchant tuning is required — introduce overrides as a separate `setup_meta_overrides(tenant_id, key, …)` table per ADR-0009's revisit clause; do not weaken the fail-closed loader.

## ADR — APIM Consumption + shared-secret origin lock (no Front Door, no VNet)

- **Date:** 2026-04-26
- **Status:** Accepted (v1)
- **Context:**
  - The Container App is on **Consumption** profile with **public ingress**. Anyone who learns the FQDN can `curl` it, burn LLM quota, or scan endpoints. CORS does not stop non-browser callers.
  - We want a real gateway in front for **v2** partner-key onboarding (per-key quotas, dev portal, JWT validation), and would rather pick the v2 endpoint **now** so the Cloudflare frontend doesn't have to migrate later.
  - Front Door Standard (~$36/mo) and APIM Standard v2 (~$730/mo) were both rejected on cost. **APIM Consumption** is $0 base + $3.50/M calls — effectively free at v1 traffic.
  - APIM Consumption has **no VNet integration**, so we cannot make the Container App ingress `internal`. The origin remains publicly hittable on its FQDN.
- **Decision:** front the Container App with a single APIM Consumption instance, and lock the origin via a shared-secret header that APIM injects on every forwarded request.
  - APIM inbound policy:
    - `<set-header name="x-apim-shared-secret" exists-action="delete" />` then re-set from a named-value (KV-backed where feasible).
    - `<rate-limit-by-key calls="60" renewal-period="60" counter-key="..." />` (per subscription, fallback to IP).
  - Fastify code:
    - `@fastify/rate-limit` registered after CORS, before the auth hook (30 req/min/IP, defence-in-depth).
    - Global `onRequest` hook rejects every non-`/health` request in `NODE_ENV=production` unless `req.headers['x-apim-shared-secret'] === env.APIM_SHARED_SECRET`. **Fail-closed if the secret env var is unset in production** — prevents a misconfigured deploy from silently allowing all traffic.
    - `/health` stays anonymous (Container Apps platform probe + APIM probes).
    - Local dev (`NODE_ENV !== production`) bypasses the hook entirely.
  - Container App env: `APIM_SHARED_SECRET` via secretref to a new Key Vault secret. `CORS_ORIGINS` tightened to the APIM gateway hostname.
- **Consequences:**
  - **Cost:** $0/mo at v1 traffic (under 1M APIM free calls/mo).
  - **Code rewrite:** ~30 LOC. Schemas, business logic, retrieval, decision pipeline — all untouched.
  - **Latency hit:** APIM Consumption adds ~50–100ms hop + ~1–2s cold-start after long idle. Container App already has cold-start with `minReplicas: 0`, so this isn't a step change.
  - **The shared secret IS the lock.** If it leaks, anyone can bypass APIM and hit the Container App directly. Mitigations: rotate via KV without redeploy, never log the value, never echo in deploy.sh, secret has 48 chars of entropy.
  - **No WAF.** OWASP-rule coverage of the public surface depends on Cloudflare in front of the frontend. Acceptable because the only public surface is the frontend; the API surface is APIM-fronted with auth.
  - **256 KB request body limit on Consumption tier** — well above ClearAI's < 2 KB payloads. Documented in apim.bicep header.
- **Implementation deviations from the original plan (discovered during deploy):**
  - **`rate-limit-by-key` is NOT supported on Consumption SKU** (the docs table marks it as "all except Consumption"). Replaced with the simpler `<rate-limit calls="60" renewal-period="60" />` which rate-limits per subscription. The public `/health` API has no subscription so is unaffected — defence on that path comes from Fastify's in-process limiter (which exempts `/health` for liveness probes) and Container Apps' replica autoscaler.
  - **Two non-versioned APIs cannot share the same path** in APIM. The original plan put both APIs at root `/`. Implemented version: protected API at root (`/classify/describe`, `/classify/expand`, `/boost`); public API at path `health` with operation `urlTemplate: '/'` and `serviceUrl: '${backendUrl}/health'` so the gateway URL is `https://{apim}.azure-api.net/health` mapping to backend `/health`. Clean from the client's perspective.
  - **KV-backed named-value can't be created in the same Bicep apply that creates APIM**: APIM tries to read the KV secret with its system-assigned MI to validate the binding, but the MI was just created and has no role yet. Bicep now creates the named-value with a placeholder inline value (`'__bootstrap_replaced_by_deploy_sh__'`); deploy.sh grants the role and PATCHes the named-value to KV-backed via REST after the apply. End state is identical to the original plan (KV-backed, rotation via `az keyvault secret set`), but the bootstrap path no longer chicken-and-eggs.
  - **Built-in `unlimited` product is not auto-created on Consumption** (or has a different name in some regions). Replaced with a custom product `clearai` provisioned in apim.bicep (subscriptionRequired, approvalRequired=false, state=published). Subscription `clearai-default` minted under it by deploy.sh. Cleaner anyway — explicit product naming makes the v2 partner-key story straightforward.
- **Rejected alternatives:**
  - **Front Door alone (~$36/mo):** doesn't give us the v2 partner-key story; we'd still need APIM later.
  - **APIM Standard v2 (~$730/mo):** would let us flip Container App ingress to internal, but 730× the cost for v1. Reconsider when partner traffic justifies it.
  - **FD + APIM (~$36 + $0):** double the moving parts for ~no marginal value while Cloudflare already fronts the only public surface (the static frontend).
  - **Cloudflare Worker proxy with shared secret:** functionally equivalent to APIM Consumption + secret, but doesn't lay groundwork for v2 partner keys. Picked APIM for v2 alignment.
- **Revisit if:**
  - Public-internet abuse becomes a real concern → add Front Door Standard (~$36/mo) for WAF.
  - Origin-hiding becomes mandatory (compliance, contracts) → upgrade to APIM Standard v2 + flip ingress to internal.
  - We outgrow APIM Consumption's 1M free calls and the per-call cost stops being trivial → re-tier rather than re-architect.

---

## ADR — Cloudflare Pages for the frontend, GitHub Actions as the deploy surface

- **Date:** 2026-04-26
- **Status:** Accepted (v1)
- **Context:**
  - The Astro 6 frontend (`clearai-frontend/`) ships as static SSG with React 19 islands hydrated `client:load`. There is no SSR runtime to host — `npm run build` produces a `dist/` directory that any static host can serve.
  - The wiki (`clearai-wiki/`) is already deployed to Cloudflare Pages via a GitHub Actions workflow (`.github/workflows/wiki-deploy-cloudflare.yml`) using `cloudflare/wrangler-action@v3`. The Cloudflare account, API token, and account-ID secrets are already provisioned in the repo.
  - The backend gateway is APIM Consumption fronting the Container App (per the prior ADR). Browser → APIM → Container App. APIM enforces CORS via an `<allowed-origins>` list and a per-subscription `<rate-limit calls="60" renewal-period="60" />`. The backend's own Fastify-level `CORS_ORIGINS` env var is the second line of defence.
  - The frontend needs two `PUBLIC_*` env vars at build time (Astro/Vite `import.meta.env` bakes these into the client bundle): `PUBLIC_CLEARAI_API_BASE` (the APIM gateway URL) and `PUBLIC_CLEARAI_API_KEY` (the APIM subscription key, `Ocp-Apim-Subscription-Key` header value).
- **Decision:**
  - **Host:** Cloudflare Pages, project name `clearai-frontend`, production branch `main`, served at `https://clearai-frontend.pages.dev`.
  - **Deploy surface:** GitHub Actions workflow at `.github/workflows/frontend-deploy-cloudflare.yml`, mirroring the wiki workflow byte-for-byte where possible. Triggered on push to `main` with `paths:` scoped to `clearai-frontend/**` and the workflow file itself, plus `workflow_dispatch` for manual runs. The wiki workflow is left untouched.
  - **Build:** `npm ci` + `npm run build` from `clearai-frontend/`, Node 22, npm cache keyed on `clearai-frontend/package-lock.json`. The build step injects:
    - `PUBLIC_CLEARAI_API_BASE: https://apim-infp-clearai-be-dev-gwc-01.azure-api.net` (literal in the workflow — public URL, not a secret).
    - `PUBLIC_CLEARAI_API_KEY: ${{ secrets.CLEARAI_APIM_SUBSCRIPTION_KEY }}` (new GH repo secret, value = the APIM subscription primary key).
  - **Publish:** `cloudflare/wrangler-action@v3` with `command: pages deploy clearai-frontend/dist --project-name=clearai-frontend --branch=main`. Uses the existing `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets.
  - **CORS wiring (one-line surgical change to APIM policy):** added `<origin>https://clearai-frontend.pages.dev</origin>` inside `<allowed-origins>` of the `clearai-backend` API policy. Verified the existing `<set-header name="x-apim-shared-secret">` block and the `<rate-limit calls="60" renewal-period="60" />` block are unchanged. Pre-patch policy backed up at `/tmp/apim-policy-backup-clearai-backend-*.json`.
  - **Container App env:** `CORS_ORIGINS` extended with `https://clearai-frontend.pages.dev`. New revision `ca-infp-clearai-be-dev-gwc-01--0000005` rolled out healthy with one replica.
- **Consequences:**
  - **Cost:** Cloudflare Pages free tier covers the whole site (1 build/min limit, unlimited bandwidth, unlimited static requests). Total marginal cost: $0/mo.
  - **Bundle exposes the APIM subscription key.** Anyone who opens DevTools sees it. This is acceptable per the prior APIM ADR: the key is rate-limited at 60 req/min/subscription, CORS-locked to the single Pages origin, and the Container App is shared-secret-locked behind APIM. The blast radius of a leaked key is "burn 60 calls/min until we rotate it" — bounded and recoverable. Rotation is `az apim subscription regenerate-key` + push the new value to the GH secret + re-run the workflow.
  - **No SSR.** Every API call is browser → APIM → backend. Adds CORS surface (mitigated above) but means we have zero server-side rendering complexity, zero cold-start tax on the frontend, and the static bundle is cacheable globally on Cloudflare's edge.
  - **GH Actions is the single source of truth for both Pages projects** (wiki + frontend). Engineers don't need Cloudflare dashboard access to ship — a push to `main` is the deploy. Branch previews are also free if/when we want them (just point a branch deploy at a separate Pages project).
  - **Two GH repo secrets to maintain:** `CLEARAI_APIM_SUBSCRIPTION_KEY` (rotate quarterly + on suspected leak); `CLOUDFLARE_API_TOKEN` (already in use for the wiki). `CLOUDFLARE_ACCOUNT_ID` is not a secret per se but is stored as one for consistency with the wiki workflow.
  - **Origin allowlist is now in three places:** APIM policy `<allowed-origins>`, Container App `CORS_ORIGINS`, and (implicitly) the deployed Pages domain. All three must include `https://clearai-frontend.pages.dev`. Adding a custom domain later (e.g. `app.clearai.sa`) is a three-edit change — documented here so the next maintainer doesn't miss one.
- **Rejected alternatives:**
  - **Cloudflare Pages native git integration (no GH Actions):** would split the deploy story across two surfaces (wiki uses Actions, frontend would use CF git hook), and the build-time env vars would have to live in the Cloudflare dashboard out of repo view. Single source of truth wins.
  - **Vercel:** adds another vendor, another billing account, another secrets surface. No marginal benefit over CF Pages for a static SPA.
  - **Azure Static Web Apps:** would tie the frontend tighter to Azure than necessary. CF Pages already in use for the wiki; staying multi-region/multi-cloud-cheap.
  - **Cloudflare Pages Functions to proxy the APIM key server-side at v1:** would hide the subscription key from the bundle, but requires writing a small Worker (≈50 LOC), deploying it alongside Pages, managing its own env binding to the key, and adds one more network hop (browser → Pages Function → APIM → backend). Deferred to **v1.5** when partner-key onboarding makes per-tenant proxying valuable anyway.
- **Revisit if:**
  - The APIM subscription key starts getting abused beyond the 60 req/min rate-limit despite the CORS lock → ship the v1.5 Pages Functions proxy and remove `PUBLIC_CLEARAI_API_KEY` from the bundle entirely.
  - We need SSR (auth-gated routes, dynamic OG images, signed-in dashboards) → switch the Astro adapter to `@astrojs/cloudflare` and deploy via the same Pages workflow (no host change required).
  - We add a custom domain → update APIM `<allowed-origins>`, Container App `CORS_ORIGINS`, and the Pages project's custom-domain config in the same change.

---

## ADR-0012 — v3 alternatives redesign: branch-local enumeration replaces RRF for accepted classifications

- **Date:** 2026-04-28
- **Status:** Phase 1 shipped (this ADR); Phases 1.5, 3, 4, 5, 7 planned (see V1_PLAN).
- **Context:**
  - The user-facing `alternatives` array in classify responses was sourced from the same RRF (vector + BM25 + trigram) retrieval that powers the picker. RRF normalises ranks within a query, not in absolute terms — so once the strong matches in a query are exhausted, the long tail gets rescaled upward. Users searching for "Bluetooth ANC headphones" saw "Bathing headgear (80%)" and "Horses (50%)" listed alongside the genuine wireless-headphones codes. The picker (Sonnet) correctly ignored those candidates when picking, but the alternatives surface was downstream of the picker and dumped the raw top-K.
  - Phase 0 (ADR-implicit, commit `f787af6`) added `filterAlternatives` — an absolute RRF floor + a cross-chapter ratio rule — which removed the worst noise but kept the surface conceptually wrong: alternatives were still sourced from a retrieval scoring system, not from the catalog's tree structure.
  - The right shape for the alternatives surface, once a code is accepted, is: "what other valid leaves exist under the same legal family as my chosen code?" That answer is deterministic SQL, not retrieval. Two requests with the same chosen code should produce the same alternatives list, every time.
- **Decision:**
  - When `decision_status === 'accepted'` and the chosen code is a 12-digit leaf, source `alternatives` from a deterministic enumeration of leaves under the chosen code's HS-prefix, not from retrieval.
  - Default prefix length is **HS-8** (national subheading, 8 digits). Tunable via `setup_meta.BRANCH_PREFIX_LENGTH ∈ {4, 6, 8}`. We tested HS-6 first and found it mixed structurally-related but commercially-distinct families: under HS-6 `8517.62`, "wireless headphones" got listed alongside "Switching board and telephone exchange apparatus". HS-8 (`8517.62.90`) keeps comparisons within the same national-leaf family — wireless headphones with smart watches, GPS trackers, smart glasses — which is what a customs broker actually wants to compare against.
  - Branch-sourced alternatives carry `retrieval_score: null` to signal to the frontend that no similarity score applies (the surface is enumeration, not retrieval). The chosen row gets the `Picker's choice` chip; sibling rows show the EN/AR description without a numeric bar.
  - Implemented in `src/decision/branch-enumerate.ts` (single SQL query, defensive validation, hard cap on returned leaves via `BRANCH_MAX_LEAVES = 50`). Wired into `/classify/describe` only at this stage; `/classify/expand` and `/classify/boost` continue to use filtered RRF for now (those routes have different semantics — expand is already branch-scoped by the parent prefix, and boost is comparing within a known sibling set).
  - Non-accepted statuses (`needs_clarification`, `degraded`, `best_effort`) keep using filtered RRF. The picker didn't commit to a branch on those paths, so we have nothing to enumerate under.
  - Migration `0006_branch_enumeration.sql` seeds the two new keys idempotently (`ON CONFLICT DO NOTHING`) and adds a CHECK constraint on `BRANCH_PREFIX_LENGTH` so a wrong value can't be UPDATEd in directly.
- **Consequences:**
  - **Determinism.** Same chosen code → same alternatives list, every time. Users learn the catalog structure rather than the retrieval system's quirks.
  - **No more cross-chapter noise on accepted results.** Bathing headgear and horses are gone from the wireless-headphones response — not because we filtered them out, but because they're not leaves under `8517.62.90`.
  - **Wire-format change:** `AlternativeCandidate.retrieval_score` is now `number | null`. Frontend must handle the null case (already does, via the `Picker's choice` chip on the chosen row; sibling rows just need a "branch" indicator instead of a percent bar). Documented in `src/decision/types.ts`.
  - **Zero new LLM calls.** Branch enumeration is pure SQL against an indexed column. p95 cost ~5–10ms.
  - **Decoupling for future phases.** Phase 3 (branch-rank — Sonnet ranks the enumerated leaves with reasoning) and Phase 5 (submission-description — generates a short Arabic description anchored on chosen code + branch context) both consume the branch-enumeration output. Building Phase 1 first means Phases 3 and 5 are additive, not blocked on a different data source.
- **Rejected alternatives:**
  - **Heading-first LLM classification (Pass 1: pick HS-4, Pass 2: enumerate leaves).** Rejected because the legally hard part of HS classification is heading selection, not leaf selection. Front-loading that decision into a single unconstrained LLM call without retrieval support is strictly worse on cross-heading edge cases (8517 vs 8518 vs 8527 for consumer audio). Retrieval gives the picker grounded cross-heading evidence and shouldn't be removed.
  - **Replacing the embedder before measuring.** The "horses" issue was a contract problem (alternatives surface) not a retrieval-quality problem (the picker chose correctly). A stronger embedder might shift which noise rows surface, but wouldn't have fixed the architectural error of sourcing user-facing alternatives from retrieval rank at all.
  - **Default HS-6 prefix.** Tested first; produced commercially-incoherent groupings in dense headings. HS-8 wins on real data.
- **Revisit if:**
  - HS-8 produces too few alternatives (some national subheadings only have 2–3 leaves) — flip `BRANCH_PREFIX_LENGTH` to 6 globally or per-route.
  - Need to apply the same branch-local pattern to `/classify/expand` (probably yes once Phase 7's broker-mapping lookup lands — those routes will benefit from the same determinism).
  - We add Phase 3 (branch-rank LLM rerank) — at that point the alternatives list will also carry per-leaf reasoning, and the wire format adds a `rationale` field on each `AlternativeCandidate` for accepted results.

---

## ADR-0013 — Phase 1.5: merchant-input cleanup before retrieval

- **Date:** 2026-04-28
- **Status:** Shipped.
- **Context:**
  - Real merchant inputs from the broker's data feed are dominated by Amazon-style listing titles (`Samsung Galaxy S25 Ultra AI Phone, 256GB Storage, 12GB RAM, Titanium Gray, Android Smartphone, 200MP Camera, S Pen, Long Battery Life (International Version) B0DP3GDTCF`), brand+SKU shorthand (`Arizona BFBC Mocca43`, `WH-1000XM5`), or stub words that aren't products at all (`parcel`, `item`).
  - Feeding raw merchant strings into retrieval has three failure modes: (1) trigram and embedder hits land on noise tokens (`Titanium`, `Ftwwht`, ASIN strings); (2) the picker reads marketing copy and either gets distracted or anchors on brand-implied attributes (Birkenstock → "leather"); (3) the researcher fires reactively on every shorthand input — expensive (Sonnet) and reactive when a cheap proactive cleanup would suffice for the noisy-but-grounded majority.
  - Sample-2 distribution analysis showed ~78% of merchant descriptions are 1–3 word stubs (`Hair Clip`, `Coat`, `Cards`) — these need no cleanup. The remaining ~22% benefit from cleanup; ~5–10% are full Amazon-title noise where cleanup is essential.
- **Decision:**
  - New Stage 0 in `/classify/describe`: `cleanMerchantInput` runs before retrieval. Two layers:
    - **Deterministic short-circuit** (`looksClean`): inputs ≤4 tokens, ≤80 chars, no ASIN pattern (`B0[A-Z0-9]{8}`), no mixed alphanumeric model codes, no marketing punctuation (`,()[]{}/`) → bypass the LLM, retrieval gets the raw input. Saves an LLM call on the ~78% already-clean majority.
    - **Haiku call** on noisy inputs. Returns structured JSON: `{kind, clean_description, attributes, stripped}`. `kind ∈ {product, merchant_shorthand, ungrounded}`.
  - Output routing:
    - `kind=product` with non-empty `clean_description` → use as the retrieval input, with attributes appended as a hint string (`"smartphone Android"`).
    - `kind=merchant_shorthand` → leave raw input as the retrieval input. Stage 2's existing `checkUnderstanding` will route to the researcher, which is what handles brand+SKU resolution today.
    - `kind=ungrounded` → leave raw input. Gate will likely refuse, which is the correct degraded mode.
  - Haiku not Sonnet: structured cleanup, not legal reasoning. ~10× cheaper, ~3× faster (~1.5s vs ~3-5s). Worst case is downstream re-classification — bounded blast radius.
  - Cleanup result surfaced on the response via the existing `interpretation` block (new fields: `cleaned_as`, `cleanup_kind`, `cleanup_attributes`, `cleanup_stripped`). Frontend can render "Understood as: smartphone — ignored: Samsung, Galaxy S25 Ultra, B0DP3GDTCF, …" so users can sanity-check what was stripped.
  - Two new setup_meta tunables: `MERCHANT_CLEANUP_ENABLED` (flag, default 1), `MERCHANT_CLEANUP_MAX_TOKENS` (default 200). Migration `0007_merchant_cleanup.sql`, idempotent INSERT, with a CHECK constraint on the boolean flag.
  - New `InterpretationStage` value: `'cleaned'` (stage shows the cleanup ran and produced a usable rewrite). `'researched'`/`'unknown'`/`'passthrough'` semantics unchanged.
- **Consequences:**
  - **Latency:** zero added on already-clean inputs (deterministic skip). ~1.5s added on noisy inputs (Haiku round-trip). Net effect on average request: negligible. On the 5–10% of pathological inputs that today either misclassify or fall through to best-effort: huge — they now classify cleanly.
  - **Cost:** +1 Haiku call on ~22% of describe traffic. Haiku is ~10× cheaper than Sonnet, so total LLM cost rises by < 5% in expectation.
  - **Wire-format addition:** `interpretation` block grows four optional fields. Frontend type updated. Existing consumers ignore unknown fields, so no breaking change.
  - **Observability:** event log now records `cleanup_invoked`, `cleanup_kind`, `cleanup_effective`, attribute/stripped counts, and `cleanup_latency_ms`. Lets us A/B the cleanup phase against accuracy/latency without re-running the pipeline.
  - **Composes with existing researcher.** Cleanup handles noisy-but-grounded ("Samsung Galaxy …" → "smartphone"). Researcher handles ungrounded shorthand ("Arizona BFBC Mocca43" → world-knowledge resolution). Cleanup's `kind=merchant_shorthand` output is what tells the existing pipeline to fire the researcher — so the two are explicitly coordinated, not redundant.
- **Rejected alternatives:**
  - **Run the researcher on every input.** Rejected: Sonnet is ~3-5s and ~10× more expensive than Haiku, and the researcher is overkill for "strip Samsung from a smartphone listing". Cleanup is the cheaper proactive layer; the researcher remains the expensive reactive layer.
  - **Regex/heuristic-only cleanup (no LLM).** Rejected: brand lists go stale, marketing copy is too varied to capture deterministically, and the structured-attribute extraction (Bluetooth, over-ear, ANC) needs language understanding. We DO use heuristics for the short-circuit, but the cleanup step itself is LLM-based.
  - **Run cleanup unconditionally.** Rejected: 78% of inputs don't need it, and adding 1.5s to every short stub input hurts batch-classification UX disproportionately.
- **Revisit if:**
  - Cleanup misclassifies a meaningful fraction of inputs as `ungrounded` when they're actually products (the "false ungrounded" rate). Tune the prompt's example set or shift the bias toward `kind: product` more aggressively.
  - We add `/classify/expand` cleanup. The current implementation only wires Stage 0 into `/describe` because `/expand` already takes a parent prefix that anchors the legal family — cleanup matters less when the chapter is already chosen.
  - Token cost goes up materially. The `MERCHANT_CLEANUP_MAX_TOKENS` cap exists for this; tune from setup_meta.

---

## ADR-0014 — Phase 3: branch-rank Sonnet rerank with per-row reasoning

- **Date:** 2026-04-28
- **Status:** Shipped behind feature flag (default off).
- **Context:**
  - The picker (Sonnet, called from `llm-pick.ts`) sees only `PICKER_CANDIDATES_describe` (default 8) RRF top hits. It's possible — and observed in the data — for the right leaf to live in the chosen code's HS-8 branch but not be in retrieval's top-K, particularly when the branch is dense (10+ leaves under one HS-8 prefix in chapters like 8517.62 or 6204).
  - Phase 1 (ADR-0012) shipped branch-local enumeration as the alternatives surface, but the rendered list was in catalog order (numeric code asc) with no ranking and no per-leaf reasoning. Users saw the right family but no signal of which sibling fit best.
  - Real broker submissions show that the leaf-pad pattern matters: from the 5,001-row sample-2 distribution, 50% of submitted codes end in `0000`, 13% in `0001` (first national variant), 13% in `9999` (catch-all "Other"), and ~12% in `0002–0006` (other named variants). Picking the right one is a real classification decision, not a rubber-stamp.
- **Decision:**
  - New module `src/decision/branch-rank.ts`. After the picker accepts a code AND `BRANCH_RANK_ENABLED=1`, fire one Sonnet call that takes the user's effective description + every leaf in the branch (typically 5–15 rows) and returns a ranked list with `{rank, fit, reason}` per row. `fit ∈ {fits, partial, excludes}`; `reason` is one sentence ≤25 words.
  - Output shape: `{ranking: [...], top_pick, agrees_with_picker}`. The downstream guard validates that the OUTPUT code set is exactly the INPUT code set — no inventions, no drops. Guard trips → fall back to picker's pick, no override.
  - **Override mechanic:** if branch-rank's top_pick differs from the picker's chosen code (rare; we expect ~5–10% of accepted classifications), the response code is overridden. The picker's pre-override pick is preserved in the event log under `branch_rank_picker_choice`, and `branch_rank_overrode` is set to true. This is not a bug in the picker — it's the picker doing its job (it picked the best of 8 RRF candidates) and branch-rank doing a different job (picking the best of the FULL HS-8 family). Recording overrides lets us audit them offline and tune the picker prompt or RRF parameters over time.
  - **Feature-flagged off.** `BRANCH_RANK_ENABLED=0` is the default. Flipping it on adds ~3-5s wall-clock and ~1 Sonnet call to every accepted classification. Common-path latency (most users, most queries) stays unchanged at the default. Flip on per-customer or globally once we measure quality on real traffic.
  - **Mutually exclusive with best-effort.** Branch-rank only runs when there's an accepted leaf to enumerate under. On the best-effort path (gate refused, fallback heading), there's no branch — branch-rank doesn't fire.
  - Two new setup_meta tunables: `BRANCH_RANK_ENABLED` (flag, default 0), `BRANCH_RANK_MAX_TOKENS` (default 800 — per-row reasoning adds up). Migration `0008_branch_rank.sql`, idempotent INSERT, with a CHECK constraint on the boolean.
  - Wire-format additions:
    - `AlternativeCandidate` grows three optional fields: `rank?: number`, `fit?: 'fits' | 'partial' | 'excludes'`, `reason?: string`. Populated when branch-rank ran; absent otherwise.
    - Top-level `branch_rank_override?: { picker_choice, branch_rank_choice }` only emitted when an override happened.
    - `model.branch_rank?: string` records the model identifier when branch-rank ran.
    - `result.retrieval_score` becomes nullable (some overrides land on codes not in the original RRF top-K, where there's no score to report).
- **Consequences:**
  - **Latency:** common path with flag off = unchanged. With flag on, +3-5s wall-clock on the accepted path. Worst-case path (cleanup + researcher + picker + branch-rank): ~10s p95. We measured the headphones case at 16s once with cleanup also enabled — the tail can run long but the gate keeps the median tight.
  - **Cost:** +1 Sonnet call per accepted classification when enabled. Sonnet is ~10× more expensive than Haiku per token; the per-row reasoning makes branch-rank's output 3–4× larger than the picker's. Net: branch-rank doubles per-request token spend on the accepted path when on.
  - **Quality upside:** UI now renders "fits / partial / excludes" with one-line per-row reasoning — exactly what a customs broker would write next to each code while comparing siblings. Users can see *why* a sibling lost, not just that it lost.
  - **Override audit trail:** every override is logged with the picker's pre-override pick and the branch-rank override pick. Lets us study disagreement patterns offline and decide whether to tune the picker prompt, increase `PICKER_CANDIDATES_describe`, or accept branch-rank as the primary picker.
  - **Defensive guards:** unit-tested for hallucinated codes, omitted codes, error responses, unparseable JSON, fewer-than-2-leaf branches, chosen-code-missing-from-leaves. All fall back to the picker's pick — branch-rank failures degrade silently, never break classification.
- **Rejected alternatives:**
  - **Run branch-rank in parallel with the picker.** Tempting, but the picker's chosen code IS the branch-rank input (we need to know which branch to enumerate). Sequential is mandatory.
  - **Use Haiku for branch-rank instead of Sonnet.** Haiku writes shallow, repetitive per-leaf reasons that all sound the same — not customs-broker-grade prose. Sonnet's reasoning is the value here; Haiku saves cost but not quality.
  - **Always overrule the picker with branch-rank.** No — the picker has signal that branch-rank doesn't (cross-heading evidence from RRF). When they agree, we accept; when they disagree, branch-rank wins with audit. Unconditional override would lose the picker's heading-level disambiguation work.
  - **Inline branch-rank's output as the new picker.** That collapses two distinct decisions into one and removes the cross-heading vs within-branch separation. Two LLM calls is the right shape for the right reasons.
- **Revisit if:**
  - Override rate is consistently > 30% — that's a signal the picker is systematically wrong, not branch-rank doing tiebreaks. Tune the picker prompt or `PICKER_CANDIDATES_describe`.
  - Override rate is < 1% with no quality lift — branch-rank's value is mostly in the per-row reasoning, not the override; consider keeping the reasoning UI but skipping the override mechanic.
  - The HS-8 branch sizes are too large (>15 leaves) and `BRANCH_RANK_MAX_TOKENS=800` truncates output. Increase the cap or flip `BRANCH_PREFIX_LENGTH` to HS-6 with the corresponding token bump.
  - We add `/classify/expand` branch-rank. Same pattern but the parent prefix is supplied — no picker call to disagree with, just rank under the supplied parent. Trivial extension once we measure value on `/describe`.

---

## ADR-0015 — Layered alternatives fallback + per-row source labels

- **Date:** 2026-04-28
- **Status:** Shipped.
- **Context:**
  - Phase 1 (ADR-0012) made the alternatives surface deterministic by enumerating leaves under the chosen code's HS-8 branch. Worked great for dense branches (e.g. 8517.62.90 has 11 leaves under it). Failed silently on sparse branches: `1509.20.00` (Extra virgin olive oil) has exactly one leaf at HS-8 — the chosen code itself. The user saw zero alternatives and no signal that the system had thought about anything.
  - The alternatives surface served two distinct purposes that we had collapsed into one: (1) "show me other valid leaves in the same legal family" (deterministic, branch-local), and (2) "show me what else the system considered" (trust signal, must always have content). Phase 1 nailed (1) but broke (2) on sparse branches.
- **Decision:**
  - Layered enumeration with widening prefix. The default scope stays HS-8, but if the HS-8 branch yields fewer than `ALTERNATIVES_MIN_SHOWN` (default 3) non-chosen rows, the enumerator widens to HS-6 automatically. We deliberately stop widening at HS-6 — HS-4 is too broad in dense chapters (a whole heading can span dozens of unrelated leaves).
  - When even HS-6 falls short, the route layers in **filtered RRF candidates** as a final top-up. The same `MIN_ALT_SCORE` and `STRONG_ALT_RATIO` from Phase 0 still apply, so we never re-introduce noise — just genuinely close hits the catalog tree happens not to surface.
  - Each alternative carries an explicit `source` field: `branch_8` | `branch_6` | `branch_4` | `rrf`. The frontend renders a per-row badge so the user understands which scope they're looking at — "tightest commercial sibling" vs "widened to same heading" vs "retrieval top-up".
  - One new setup_meta tunable: `ALTERNATIVES_MIN_SHOWN` (default 3). Migration `0009_alternatives_layered.sql`, idempotent.
  - Replaced the brittle `others.every(score === null)` heuristic on the frontend with explicit source-based detection. The previous logic short-circuited to false on single-row alternatives lists and showed the wrong subtitle copy.
- **Consequences:**
  - **Olive oil case fixed**: `extra virgin olive oil` returns 1 branch_8 (the chosen code) + 4 RRF top-ups (Other virgin / Virgin / Crude pomace / Other olive oils) — exactly the comparison set a customs broker wants.
  - **Wireless headphones case unchanged**: HS-8 (8517.62.90) is dense (11 leaves), threshold satisfied, no widening, no RRF top-up. All `branch_8`.
  - **Subtitle copy now adapts deterministically**: all-branch_* → "Branch alternatives"; all-rrf → "Considered alternatives" (legacy retrieval framing); mixed → "Alternatives" with a hybrid subtitle.
  - **Per-row badges add useful context** at near-zero cost. CSS-only, no JS state.
- **Rejected alternatives:**
  - **Always include RRF top-up candidates regardless of branch size.** Rejected: re-introduces the noise we killed in Phase 1 (bathing caps, horses) for queries where the branch already has plenty of siblings. Layered fallback only activates when there's a genuine shortfall.
  - **Widen all the way to HS-4 by default.** Rejected: HS-4 in dense chapters spans too many unrelated leaves. Stop at HS-6 and let RRF handle the long tail when even that's insufficient.
- **Revisit if:**
  - Real-world data shows users frequently want to compare across HS-4 boundaries (e.g. wired vs wireless headphones — 8518 vs 8517). At that point we add HS-4 widening for specific product classes via the broker-mapping lookup (Phase 7).
  - The RRF top-up surfaces noise that Phase 0's filter doesn't catch. Tighten `MIN_ALT_SCORE` or add a "branch-related" check (must share at least HS-2 chapter with the chosen code).

---

## ADR-0016 — Phase 5: ZATCA-safe submission description

- **Date:** 2026-04-28
- **Status:** Shipped behind feature flag (default on).
- **Context:**
  - ZATCA rejects customs declarations whose Arabic description matches the catalog description for the chosen HS code WORD-FOR-WORD. Brokers manually rewrite the catalog text to add at least one differentiating token before submission. Sample data confirms this is universal — every submitted XML has an Arabic description that differs from the catalog by at least one word (often a redundant transliteration like "أجهزة هاتف ذكية سمارت فون").
  - Real merchant inputs are dominated by Amazon-listing salad and brand+SKU shorthand. Generating a submission description from the raw user input would re-leak the brand/SKU back into the customs declaration. The submission must anchor on the *cleaned* / *researched* product type, not the raw input.
  - Without this feature, every broker burns 30 seconds per row rewriting the catalog text by hand. With ~5,000 rows/day (sample-2 distribution), that's >40 hours/day saved across the broker team.
- **Decision:**
  - New module `src/decision/submission-description.ts`. Sonnet call (LLM_MODEL_STRONG) with the user's effective description + chosen code + catalog AR + catalog EN as inputs. Returns `{description_ar, description_en, rationale}`.
  - **Anchored on `effectiveDescription`**, NOT raw input. The cleanup phase (1.5) and the researcher both populate `effectiveDescription`; submission generation reads that. Brand-leak is structurally impossible.
  - **Two-attempt LLM loop**: attempt 1 at `temperature=0`. If the output AR matches catalog AR (post-normalisation) we retry attempt 2 at `temperature=0.2` with a stricter hint. If both attempts fail the distinctness check, fall through to a deterministic prefix mutator that prepends an attribute-rich word from the user's input to the catalog AR. Always ships *something* — empty submission fields are not an option.
  - **Deterministic distinctness check** uses Arabic-aware normalisation: NFKC compose (so أ stays a single codepoint), strip diacritics + bidi marks + tree-formatting punctuation, collapse whitespace. The check runs after the LLM, never inside the prompt — we don't trust the model to police itself on the rule that legally matters.
  - **Both EN and AR generated independently** (not translation). The English line is what non-Arabic operators verify against; if it were a translation of the AR, an operator couldn't catch AR drift.
  - Surfaced on the response as `submission_description: {description_ar, description_en, rationale, differs_from_catalog, source}`. `source ∈ {llm, llm_failed, guard_fallback}` — the frontend renders an amber "review before submission" banner on the non-`llm` paths.
  - Two new setup_meta tunables: `SUBMISSION_DESC_ENABLED` (flag, default 1), `SUBMISSION_DESC_MAX_TOKENS` (default 300). Migration `0010_submission_description.sql`, idempotent + CHECK constraint on the boolean.
  - Frontend new component `SubmissionDescriptionCard.tsx` rendered between `HSResultCard` and `AlternativesCard`. Copy buttons (AR + EN), distinctness pill ("Differs from ZATCA catalog ✓"), rationale block, AI-suggestion disclaimer.
- **Consequences:**
  - **Latency:** +1 Sonnet call on the accepted path when enabled (~2-3s). Runs sequentially after branch enumeration. No parallelisation with branch-rank because the latter would block on the picker's choice anyway.
  - **Cost:** +1 Sonnet call per accepted classification. Output is small (<100 tokens), so cost addition is small.
  - **Quality**: tested on Extra virgin olive oil — catalog `زيت العصرة الأولى (زيت بكر) إكسترا` → submission `زيت زيتون بكر ممتاز` (distinct, ZATCA-acceptable, accurate to the product). The deterministic post-check guarantees the differs-from-catalog rule is satisfied; the LLM can focus on quality of phrasing.
  - **Liability**: card always carries an "AI-generated suggestion — verify before submitting" disclaimer. Broker stays in the loop. We're not auto-submitting; we're suggesting copy-and-edit text.
  - **Wire-format addition**: `DecisionEnvelopeBase.submission_description?: SubmissionDescription`. Optional, only on accepted results.
- **Rejected alternatives:**
  - **Translate the catalog AR with one word inserted.** Rejected: produces robotic, often grammatically broken Arabic. The point is fluent customs-grade prose that happens to differ; a deterministic mutator achieves only the latter.
  - **Use Haiku instead of Sonnet.** Rejected: Haiku produces shallow, repetitive Arabic phrasing — fine for cleanup (extraction) but not for generation. Sonnet's prose quality is the value here.
  - **LLM self-attests `differs_from_catalog` without our post-check.** Rejected: the deterministic check is cheap, the rule is mechanical, and trusting the model on a legally-critical compliance check is a bad pattern.
  - **Generate descriptions for `best_effort` results too.** Rejected: best-effort means we have a chapter heading, not a leaf — generating a "submission description" off that would project false precision. Suppress for non-accepted statuses.
- **Revisit if:**
  - ZATCA tightens the rule (e.g. "must differ by ≥ 2 tokens" or "near-duplicate after stemming"). Tighten the post-check; architecture stays the same.
  - We need to generate the EN line as a strict translation of the AR rather than independently. Add a `SUBMISSION_DESC_EN_AS_TRANSLATION` flag.
  - Token cost goes up materially. The `SUBMISSION_DESC_MAX_TOKENS` cap exists for this; tune from setup_meta.

---

## ADR-0017 — Phase 4: per-request trace page + user feedback collection

- **Date:** 2026-04-28
- **Status:** Shipped (backend + frontend; auth deferred to a later phase).
- **Context:**
  - Through Phases 0–5 we shipped 5 new sub-systems (filter-alternatives, branch enumeration, branch-rank, merchant cleanup, submission description) — each behind a feature flag, each adding observability fields to the event log. We had no UI surface to inspect a single request end-to-end, and no surface for users to push back on classifications. Both gaps blocked the next round of tuning: we couldn't decide which flags to flip on without a way to see what each phase actually did per request, and we couldn't measure accuracy without human-confirmed labels.
  - The aggregate-metrics dashboard idea was rejected explicitly — showing brokers "we got 87% right" implies "13% of YOUR work was wrong" and is bad UX. Per-request traces sidestep that: each trace is the user's own request by definition.
- **Decision:**
  - **Per-request trace page** at `/trace/:id`. Renders the full `classification_events` row (request, decision, retrieval signals, model timeline, alternatives, llm_used, guard tripped, latency) and any `classification_feedback` rows attached to it. Astro shell + React island; same auth + CORS path as the main app.
  - **Auth model: share-link-with-UUID.** The trace id is the event row's primary key, generated server-side as `gen_random_uuid()`. Anyone with the link can view the trace and submit feedback. UUIDs are unguessable; the trace is "your own request" by definition. When real user auth lands later, we tighten via the `user_id` column on `classification_feedback` (already in the schema, null-permitting today).
  - **`request_id` on every classify response.** `logEvent` was changed to RETURNING id and called with `await`. The id is surfaced as `request_id` on all three response shapes from `/classify/describe`, `/classify/expand`, and `/boost`. logEvent failures degrade to "no request_id, trace link hidden" rather than 500'ing the classification.
  - **Feedback table** `classification_feedback` (migration 0011): event_id (FK, ON DELETE CASCADE), kind ∈ {confirm, reject, prefer_alternative}, rejected_code, corrected_code, reason ≤ 500 chars, user_id (null today). UNIQUE on (event_id, COALESCE(user_id, '')) so a user UPSERTs their feedback rather than spamming duplicates. CHECK constraint enforces the corrected_code/kind invariants in addition to the route-level checks.
  - **Two new endpoints**:
    - `GET /trace/:eventId` — returns `{event, feedback[]}`. 404 on bad UUID.
    - `POST /trace/:eventId/feedback` — UPSERTs one row. Validates kind/corrected_code combinations server-side; defaults rejected_code to the event's chosen_code when omitted (the typical "this is wrong" click on the result card).
  - **Frontend MetaPanel removed** from the main result page. The model + latency dev-view it carried is now part of the trace page (richer: every model call with per-call latency + status, not just "the picker model"). A new `TraceLink` component renders a small footer at the bottom of the result block — `Round-trip: 7.6s · View full trace →` — that links to `/trace/:id`. Renders `Trace unavailable` (no link) when `request_id` is absent.
- **Consequences:**
  - **Per-request debugging is now a one-click operation.** Customer reports a classification that looked weird? Open `/trace/<id>`, see the full pipeline state, decide if it's a picker error, a retrieval miss, a cleanup mistake, or a branch-rank disagreement. Massively reduces the cost of investigating edge cases.
  - **Feedback rows = ground-truth training data.** Every "wrong, should be X" click is a labelled correction that can drive picker prompt tuning, threshold calibration, or per-customer specialisation. The schema already includes `user_id` for when auth lands, so the data we collect today is forward-compatible.
  - **logEvent is now blocking.** The `await` adds 5–15ms p95 to every classification (single INSERT against a hot table with autoincrementing UUID PK + jsonb columns). Acceptable: typical classification is 4–10s anyway. If this ever becomes the bottleneck we can move logging back to fire-and-forget via a Postgres `LISTEN/NOTIFY` queue or an in-memory ring buffer with a flusher task.
  - **Wire-format addition**: `DecisionEnvelopeBase.request_id?: string`. Optional for backward compat; absent on cached/legacy responses or DB-failure paths.
  - **Main result page is cleaner.** Dev/meta noise gone. Brokers see chosen code → submission text → alternatives → trace link. Trace is opt-in.
- **Rejected alternatives:**
  - **Aggregate metrics dashboard.** Rejected as the primary surface — wrong audience (brokers, not operators), bad framing ("X% wrong" implies broker error), and gameable. We'll build one for ops use only after we have feedback rows to compute meaningful accuracy.
  - **APIM-key auth on the trace endpoint.** Rejected for now: the frontend bundle has the key baked in anyway, so requiring it doesn't add real security; UUIDs are the actual access control. We'll layer real auth on the same surface when user accounts land.
  - **Soft-delete for feedback rows.** Rejected: feedback is small + auditable + not user-reversible (the intent is "I corrected this once" not "I take it back"). If a user changes their mind, they UPSERT a different `kind` against the same (event_id, user_id) pair.
  - **History view of all past requests.** Defer. Per-request trace is enough for the current debug story; a "your last 20 classifications" panel is a separate Phase 4.5 if/when needed.
- **Revisit if:**
  - Trace endpoint becomes a hotspot (unlikely — point lookup by indexed UUID). Add an in-memory cache keyed on event id with a short TTL.
  - Feedback rows reveal a systematic disagreement pattern (e.g. picker chose code X but brokers consistently correct to Y for the same input class). Surface it via a Phase 4.5 admin metrics view, then loop back into prompt tuning.
  - We add user accounts. The user_id column is ready; auth wiring is the only missing piece.

---

## ADR-0018 — Phase 7: broker-mapping deterministic short-circuit

- **Date:** 2026-04-28
- **Status:** Shipped, default-on.
- **Context:**
  - The broker keeps a hand-curated lookup table in
    `naqel-shared-data/Naqel_HS_code_mapping_lookup.xlsx` — about 500 rows
    mapping bad/old/mistyped merchant HS codes to the correct 12-digit ZATCA
    code + the canonical Arabic submission text. Patterns observed in the
    source data:
      - 87% of inputs are 10-digit codes (the merchant's
        common precision); ~8% are 8-digit; ~3% are 12-digit (already-valid
        codes the broker still routes elsewhere because the merchant's
        product class disagrees with the code).
      - Many entries collapse a swathe of codes onto one canonical leaf —
        e.g. eight different cotton-clothing merchant codes (`6217900000`,
        `6204330000`, `6104230000`, etc.) all map to `620442000000`
        (women's cotton trousers), which is the duty rate / leaf the
        broker has standardised on for that class.
      - Source quality is not perfect. 4 rows are sentinel "do not use"
        markers (client and target columns identical with non-12-digit
        targets); 1 is a duplicate of an earlier row; 7 have leading-zero
        loss in target codes (e.g. `10620000007` instead of `010620000007`).
  - This table embodies the broker's accumulated wisdom — every row is a
    case where they corrected something the merchant got wrong. It's
    higher-quality than anything the LLM picker could derive on its own
    on those inputs, because it IS the labelled-correction set.
- **Decision:**
  - **New table `broker_code_mapping`** (migration 0012) keyed on the
    digit-only-normalised merchant code, with strong CHECKs (target must
    be exactly 12 digits, no self-maps, client length 4–14). UNIQUE on
    the client_code_norm so duplicate source rows surface at ingest.
  - **Ingest script** `pnpm db:seed:broker` reads the xlsx, normalises,
    validates per-row, TRUNCATEs and bulk-inserts via UNNEST. Source file
    IS the source of truth — we don't merge or diff. Re-running the
    script gives idempotent state. Validators reject:
      - Sentinel rows (client == target with non-12-digit target — broker's
        "do not use" markers; auto-padding them would manufacture a fake
        canonical target that doesn't exist).
      - Duplicate client codes (data error — broker can only canonically
        map one input to one target).
      - Non-numeric or out-of-range client lengths.
    Last run: 495/500 rows accepted, 4 sentinels + 1 duplicate rejected
    with named reasons logged.
  - **Lookup module** `src/decision/broker-mapping.ts`. Exact-match by
    default; prefix walk-up to a configurable `minPrefix` (default 6) so
    a 12-digit merchant input can match an 8-digit broker entry. Single
    SQL query with `client_code_norm = ANY($1)` + ORDER BY length DESC
    LIMIT 1 — longest match wins.
  - **Wired into `/classify/expand` only** (Phase 7's scope). The lookup
    runs before retrieval / picker; on a hit, we return immediately with:
      - `decision_status: accepted`, `confidence_band: high`
      - `decision_reason: strong_match`
      - the broker's canonical target as `after.code`
      - the broker's canonical AR (preferred over catalog AR) as
        `after.description_ar`
      - a `rationale` naming the source-row reference for auditability
      - a top-level `broker_mapping` block: `{matched_client_code,
        matched_length, source_row_ref}`
      - `model.llm: null` (no LLM call made)
    On a miss, the existing retrieval + picker path runs unchanged.
  - **Feature-flagged** via `BROKER_MAPPING_ENABLED` (default 1, migration
    0013). Flip to 0 to bypass the lookup entirely — useful for A/B
    measurement once feedback rows accumulate enough to compare lookup
    vs LLM accuracy on the same inputs.
- **Consequences:**
  - **Latency: ~5ms p95 on hits**, free on misses (one indexed lookup).
    /expand traffic that hits the table avoids ~3-5s of Haiku + retrieval.
  - **Cost: zero LLM calls on hits.** Token spend on /expand drops in
    proportion to the hit rate. Expected hit rate: high on internal data
    feeds (the broker's table was built FROM that traffic), much lower on
    fresh inputs.
  - **Auditability**: every short-circuit response carries the source row
    reference so a broker can find the originating xlsx row in seconds.
    The trace page surfaces this too.
  - **Wire-format additions**:
    - `broker_mapping?: {matched_client_code, matched_length, source_row_ref}`
      on the response, only present on hits.
    - `request.broker_mapping_hit / matched_length / source_row` on the
      event log for offline analysis.
  - **Operational**: re-running the ingest takes ~2s. The script is in
    package.json as `db:seed:broker`. When the broker updates the xlsx,
    that's the only command they need to run.
- **Rejected alternatives:**
  - **Inline broker-mapping check in the LLM prompt.** Rejected: the
    LLM doesn't need to "decide" whether to use the broker's mapping;
    when a hit exists, it's authoritative. Wrapping it in an LLM call
    adds latency and cost for zero quality lift.
  - **Auto-pad sentinel rows during ingest.** Rejected: the broker put
    the same code on both sides as a "do not use" marker. Auto-padding
    would manufacture a canonical target (e.g. `9403896010` →
    `940389601000`) that the broker never approved. Strictly worse than
    rejecting the row.
  - **Walk up to HS-2 (chapter level) on prefix mismatch.** Rejected:
    HS-2 is too coarse to be authoritative for a code-level lookup —
    we'd be returning "Chapter 61's canonical target" for any 61.xx
    merchant code, which obliterates the broker's per-leaf curation.
    Stop at 6.
  - **Wire broker-mapping into `/classify/describe`.** Deferred:
    `/describe` takes free text, not a code, so the table doesn't apply
    directly. A future phase could check the broker's table against
    *cleanup output* (after Phase 1.5 normalises the merchant input
    into a clean noun phrase + attributes), but that's a different
    integration point.
- **Revisit if:**
  - Source xlsx grows past ~5,000 rows. The current schema scales fine
    to ~100k, but if it gets larger we'd want a partial index on the
    most-common leaf prefixes.
  - Hit rate stays low (< 5%) on real traffic for a sustained period.
    That'd mean the broker's existing table doesn't cover the inputs
    we actually see, and we should either grow it or focus on tuning
    the LLM picker instead.
  - Feedback rows show the broker mapping was wrong for a specific
    input. At that point the operations team edits the xlsx and re-runs
    `db:seed:broker`. (We don't take feedback as authority over the
    broker's curated table — the broker IS the authority.)
