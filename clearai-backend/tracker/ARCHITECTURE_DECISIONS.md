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
