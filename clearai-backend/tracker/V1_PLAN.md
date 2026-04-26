# ClearAI v1 — Build Plan

*Fresh-start TypeScript rebuild. Single environment: dev. No production.*
*Old Python backend preserved at `clearai-backend-python/` (not modified).*
*Primary consumer: batch ZATCA XML generation (no human in the loop). Design optimizes for: high precision on accepted decisions, explicit abstention on uncertain ones, structured machine-readable refusal signals.*

---

# Part A — Tech

## A.1  Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Language | TypeScript (Node 20) | Strict mode on |
| Web framework | Fastify v5 | Schema-first; auto-OpenAPI via `@fastify/swagger` |
| Validation | Zod | Single source of truth for request/response shapes |
| ORM / migrations | Drizzle ORM + drizzle-kit | SQL-first; TS types from schema |
| Database | PostgreSQL 16 | Single DB, all data |
| Vector search | pgvector extension | HNSW index, cosine similarity |
| Keyword search | tsvector + ts_rank | Built-in Postgres full-text |
| Fuzzy match | pg_trgm extension | Typo tolerance, partial match |
| Arabic normalization | unaccent + custom `normalize_ar()` | Folds alef variants, strips tatweel |
| UUID generation | pgcrypto extension (`gen_random_uuid`) | All primary keys are GUIDs |
| Embeddings (in-process) | `@xenova/transformers` | Model: `Xenova/multilingual-e5-small` (384-dim, EN+AR) |
| LLM client | `@anthropic-ai/sdk` → Foundry baseURL | Sonnet + Haiku already deployed in Foundry |
| Logging | pino (JSON to stdout) | Container Apps captures it |
| Container | Multi-stage Dockerfile, distroless runtime | Small, secure |
| Package manager | pnpm workspace | Apps + packages in one repo |
| Tests | vitest | Fast, native TS, ESM-friendly |
| Lint / format | eslint + prettier | Standard config |
| Frontend | Existing UI kept, simplified forms | Points at new API |
| IaC | Bicep | Per-resource modules under `infra/bicep/` |
| CI/CD | GitHub Actions + OIDC | No client secrets in pipeline |
| Image registry | GitHub Container Registry (GHCR) | |
| Secrets | Azure Key Vault (Container App reads via system-assigned MI) | |
| Source control | GitHub repo with two branches: `dev`, `main` | PRs flow `dev` → `main`; `main` is deployable |

## A.2  Azure resources for v1

Naming: `<resource-type>-<org>-<project>-<env>-<region>-<seq>`
*Tokens: `org=infp` · `project=clearai` · `env=dev` · `region=gwc` · `seq=01`*

### Already exists (do not create)

| Resource | Name | Purpose |
|---|---|---|
| Subscription | `sub-infp-clearai-nonprod-gwc` | Subscription holding all dev resources for ClearAI. |
| Resource group (common) | `rg-infp-clearai-common-dev-gwc-01` | Holds all v1 resources below. |
| AI Foundry project | `aif-infp-clearai-dev-gwc-01` | Hosts `claude-sonnet` and `claude-haiku` model deployments. |

### To be provisioned (cheapest tier — dev only)

| Resource | Name | Purpose | Tier / sizing |
|---|---|---|---|
| PostgreSQL Flexible Server | `psql-infp-clearai-dev-gwc-01` | All ClearAI data: `hs_codes` (with pgvector + tsvector + pg_trgm), `naqel_hs_decision_ledger`, `classification_events`, `setup_meta`. SSL enforced. | Burstable B1ms (1 vCPU, 2 GB RAM)<br>32 GB Premium SSD storage<br>Single zone, no HA<br>7-day backup retention<br>~$13–15/mo |
| Postgres logical database | `clearai` | The database created inside the server. | n/a (logical only) |
| Container Apps Environment | `cae-infp-clearai-dev-gwc-01` | Required parent for any Container App. Provides shared network + ingress + log sink. | Consumption-only workload profile<br>No Dedicated plan<br>$0 (environment itself is free) |
| Container App | `ca-infp-clearai-be-dev-gwc-01` | Fastify API runtime. HTTPS-only ingress, system-assigned Managed Identity, pulls image from GHCR. | Consumption plan<br>1.0 vCPU / 2 GiB memory<br>`minReplicas: 0` (scale to zero)<br>`maxReplicas: 1`<br>~$5–8/mo |
| Key Vault | `kv-infp-clearai-dev-gwc` | Stores Postgres connection string + Foundry API key. Container App reads via its system-assigned Managed Identity. | Standard SKU (not Premium/HSM)<br>Soft-delete enabled<br>~$0/mo at dev volumes |

*Estimated total dev cost: ~$20–25 / month (Postgres B1ms dominates).*
*Foundry / LLM costs are separate and usage-based.*

**Sizing rationale**

Container App is sized at 1 vCPU / 2 GiB (not 0.5 / 1) because the API loads an in-process ONNX embedder (~120 MB model + ~200 MB runtime + Node/Fastify ~150 MB ≈ 500 MB resident before serving any request). 1 GiB would be the floor with no headroom; 2 GiB gives breathing room for connection pools and request bursts.

**Two operational rules for this sizing — both must hold or first-boot behavior gets flaky:**

- **Cold start budget** — with `minReplicas=0`, the first request after idle pays ~3–5 s to spin up the container, load the ONNX runtime, and warm the embedder. Acceptable for dev. Surface it in the API's response time SLO ("p95 ≤ 2.5 s warm; first request after idle may take up to 5 s"). If it becomes painful in real use, set `minReplicas=1` (~$25/mo) which eliminates cold starts entirely.
- **Embedder model must be pre-bundled, not downloaded at first request** — bake the multilingual-e5-small ONNX weights into the Docker image at build time (download in the Dockerfile builder stage, copy into the runtime stage). Do NOT rely on `@xenova/transformers`' default "fetch from HF on first call" behavior in production paths: that adds ~2–8 s of unpredictable network IO to the first request and fails entirely if the container has restricted egress. Set `TRANSFORMERS_CACHE` to a baked-in path so the loader hits local disk only.

## A.3  Foundry LLM models

| Model | Used in | Why this model |
|---|---|---|
| Claude Sonnet (latest deployed) | `POST /classify/describe` — picking step (after evidence gate passes) | Strongest reasoning across diverse 12-digit candidates from many chapters. |
| Claude Haiku (latest deployed) | `POST /classify/expand` and `POST /boost` — picking step (after evidence gate passes) | Narrow reasoning task: pick best leaf from a small candidate set inside one branch. ~10× cheaper than Sonnet, sub-second latency. |

*Architectural rule: **the LLM never rescues weak retrieval.** If the Evidence Gate (B.3) fails, we abstain and return `needs_clarification` — we do not call the LLM at all. This both protects answer quality and saves tokens on the rows that would have been refused anyway.*

### A.3.1  GIR rules in the LLM system prompt

Every LLM picking call (Sonnet on `/classify/describe`, Haiku on `/classify/expand`) is fed a distilled summary of the **WCO General Interpretation Rules (GIRs 1–6)** as part of the system prompt. `/boost` is mechanical sibling-search and does **not** need GIRs.

**Source material:** `hs-interpretation-general-rules_0001_2012e_gir.pdf` (WCO official GIR document, kept in sharepoint) is the reference. A hand-distilled `prompts/gir-system.md` (~400 tokens: the 6 rules in plain language + 4 worked examples) is the artefact injected at request time. The full PDF is **not** converted to MD or loaded at runtime — we only do that if we move to B2 (full inline) or C (RAG over chunks).

**Why feed GIRs to the LLM.** Without them the LLM picks among retrieval candidates by raw semantic similarity — stable per query, but unstable across similar queries (small wording changes flip the answer). With GIRs in the system prompt the model has explicit, ranked tie-breakers it applies the same way every time:

1. GIR 1 — heading text + Section/Chapter notes are legally controlling
2. GIR 2(a) — incomplete/unfinished articles classified as the finished article when essential character is present (e.g. unpainted car body panel → motor vehicle parts, not raw metal)
3. GIR 2(b) / 3(a) — most specific description prevails over more general (e.g. "electric shaver" → 8510 shavers, not 8509 electric appliances)
4. GIR 3(b) — for mixtures, composites, and retail sets, classify by **essential character** (e.g. "leather wallet with steel chain" → wallet, not leather articles + chain)
5. GIR 3(c) — last in numerical order when (a) and (b) cannot decide
6. GIR 4 — most akin to a known good when nothing else fits
7. GIR 5 — packing/cases (when classified with the article vs separately)
8. GIR 6 — same rules apply at the subheading level

**Concrete failure modes GIRs fix.** Mixed/composite goods, retail sets, specific-vs-general ties, incomplete/unfinished articles. Estimated impact: ~3–7 % accuracy improvement on ambiguous queries; ~0 % on the easy 80 %. The bigger benefit is **batch consistency and auditability** — when a row is queried, the model's rationale traces a recognised rule, not vibes. That matters for ZATCA-bound output.

**What GIRs do NOT do.** They do not fix weak retrieval (LLM still cannot pick a candidate it never saw). They do not replace Section/Chapter Notes themselves (referenced by GIR 1 but not contained in the GIR doc — separate post-v1 ingestion target).

**Cost.** ~400 input tokens × every `/describe` and `/expand` call. At Sonnet pricing ~$0.0012 / call extra; at Haiku pricing ~$0.0001 / call extra. Negligible vs. the audit-trail benefit.

## A.4  Source control + CI/CD

### Workflow lanes — Local → dev → main

| Lane | Purpose | What happens | Deployment |
|---|---|---|---|
| Local (your machine) | Day-to-day coding | `docker-compose up -d` (Postgres + extensions) → `pnpm dev` (Fastify with tsx watch) → LLM calls hit Foundry directly. Nothing deployed. | No deploy. No CI run. Code lives only on your machine. |
| `dev` branch (GitHub) | Integration of in-progress work | Push or PR triggers `ci.yml`: typecheck + lint + vitest + build Docker image (no push). Container App is NOT updated. | CI only. No deploy. Image built and discarded — proves it builds. |
| `main` branch (GitHub) | Deployable code | Push triggers `ci.yml` first; on success, `deploy.yml` builds + pushes image to GHCR and updates the Container App revision. | Container App is linked **only** to `main`. Every merge to `main` becomes a new live revision. |

### Branch flow

- Feature work → push to `dev` branch (or feature branch → PR into `dev`)
- When `dev` is stable → PR from `dev` into `main`
- Merge to `main` → automatic deploy via `deploy.yml`

### GitHub Actions workflows

| Workflow | Trigger | Purpose |
|---|---|---|
| `ci.yml` | Push or PR to `dev` or `main` | Validates code: typecheck, lint, tests, image build. No deploy. |
| `deploy.yml` | Push to `main` only (after `ci.yml` passes) | Builds + pushes image to GHCR; updates Container App revision; smoke tests; promotes traffic. |

## A.5  APIs

### Shared decision contract (all three endpoints)

*Every endpoint returns the same envelope. The batch caller branches on `decision_status`; `decision_reason` explains why; the result/before/after payload is null when we abstain.*

**`decision_status` (terminal state):**

- `'accepted'` — committed to a code. Caller may use it.
- `'needs_clarification'` — refused. We did not commit. Caller should queue the row for review or enrich and retry.
- `'degraded'` — committed to a code, but a dependency was unavailable (typically LLM). Caller should treat with lower trust.

**`decision_reason` (one of):**

| `decision_reason` | `decision_status` | When this is returned |
|---|---|---|
| `strong_match` | accepted | Retrieval evidence passed thresholds; LLM picked from candidates. |
| `single_valid_descendant` | accepted | Branch walk surfaced exactly one 12-digit leaf; no LLM call needed. |
| `already_most_specific` | accepted | `/boost` only. Current code has no siblings, OR no sibling beats it by the required margin. |
| `weak_retrieval` | needs_clarification | `top_retrieval_score < MIN_SCORE(endpoint)`, or no candidates. |
| `ambiguous_top_candidates` | needs_clarification | `top2_gap < MIN_GAP(endpoint)` — top picks are too close to commit. |
| `invalid_prefix` | needs_clarification | `/expand` only. Prefix matches no rows in `hs_codes`. |
| `guard_tripped` | needs_clarification | LLM returned a code outside the candidate set we sent. We do NOT silently substitute. |
| `llm_unavailable` | degraded | LLM down after retries. Returned top retrieval candidate, flagged degraded. |

**`confidence_band` (optional):**

Three buckets — `'high'` \| `'medium'` \| `'low'`. **NOT a probability.** Calibrated from eval data (§A.9), not from LLM self-report. Surfaced when `decision_status='accepted'` and the business consumer wants a coarse signal. Does **NOT** drive backend decisions — only `decision_status` does.

**What is NOT in the response:**

- No raw confidence float. We do not surface uncalibrated numbers as if they were probabilities.
- No LLM self-reported confidence. It is uncalibrated and unstable across requests.
- No `retrieval_score` on the top-level result. `retrieval_score` is per-alternative only, useful for batch diagnostics, not as a decision primitive on the consumer side.

### POST /classify/describe

Description → 12-digit ZATCA code. Language auto-detected. This is the hardest path because there is no code anchor — strictest evidence thresholds apply.

**Request:**
```ts
{
  description: string;   // min 3 chars, validation rules in A.5b
}
```

**Response:**
```ts
{
  decision_status: 'accepted' | 'needs_clarification' | 'degraded';
  decision_reason: 'strong_match' | 'weak_retrieval' | 'ambiguous_top_candidates'
                 | 'guard_tripped' | 'llm_unavailable';
  confidence_band?: 'high' | 'medium' | 'low';   // present only when accepted

  result?: {
    code: string;             // 12 digits
    description_en: string;
    description_ar: string;
    rationale: string;        // LLM's explanation of the pick
    alternatives: Array<{ code, description_en, retrieval_score }>;
  };

  // Present when needs_clarification — structured, machine-actionable for batch:
  missing_attributes?: Array<
    'material' | 'intended_use' | 'product_type' | 'dimensions' | 'composition'
  >;
  rationale?: string;         // Human-readable; for logs/audit, not for batch routing.

  model: { embedder, llm };
}
```

### POST /classify/expand

Partial code (4–11 digits) → 12-digit ZATCA code under that prefix. Description optional. The prefix constrains the search, so thresholds can be looser than `/describe`.

**Request:**
```ts
{
  code: string;          // 4..11 digits
  description?: string;
}
```

**Response:**
```ts
{
  decision_status: 'accepted' | 'needs_clarification' | 'degraded';
  decision_reason: 'strong_match' | 'single_valid_descendant'
                 | 'weak_retrieval' | 'ambiguous_top_candidates'
                 | 'invalid_prefix' | 'guard_tripped' | 'llm_unavailable';
  confidence_band?: 'high' | 'medium' | 'low';

  before: { code: string; description_en: string | null };
  after?: { code: string; description_en: string; description_ar: string };
  evidence?: string;

  alternatives?: Array<{ code, description_en, retrieval_score }>;
  missing_attributes?: Array<...>;
  rationale?: string;

  model: { embedder, llm };
}
```

### POST /boost

Generic 12-digit ZATCA code → more specific 12-digit code at the same level. Conceptually: **"search the immediate descendants of the declared code's parent level."** In v1 the ZATCA hierarchy is consistently 10-digit parent → 12-digit leaf, so this implements as "rows with the same first 10 digits, different last-2 statistical suffix." If future data introduces other split points, the rule stays "immediate parent prefix" — the prefix length is a config (`parentPrefixLength`), not a hard-coded 10. **`/boost` is controlled refinement, NOT reclassification:** we only refine within the local family if evidence is strong.

**Request:**
```ts
{
  code: string;          // exactly 12 digits, must exist in hs_codes
  description?: string;
}
```

**Response:**
```ts
{
  decision_status: 'accepted' | 'needs_clarification' | 'degraded';
  decision_reason: 'strong_match' | 'already_most_specific'
                 | 'weak_retrieval' | 'ambiguous_top_candidates'
                 | 'guard_tripped' | 'llm_unavailable';
  confidence_band?: 'high' | 'medium' | 'low';

  before: { code: string; description_en: string; description_ar: string };
  after:  { code: string; description_en: string; description_ar: string };
  // after may equal before when decision_reason='already_most_specific'
  evidence?: string;

  alternatives?: Array<{ code, description_en, retrieval_score }>;
  missing_attributes?: Array<...>;
  rationale?: string;

  model: { embedder, llm };
}
```

## A.5b  Validation rules — v1 spec

*Every endpoint validates with Zod at the API layer before any DB or LLM call. 400 responses use the shape: `{ error: 'validation_error', field?: string, message: string }`.*

### POST /classify/describe — validation rules

| Input | Action | Message |
|---|---|---|
| `description` missing or empty | Reject 400 | `'description is required'` |
| `description.trim().length < 3` | Reject 400 | `'too short — please describe the product'` |
| `description.length > 500` | Reject 400 | `'too long — keep it under 500 characters'` |
| No Unicode letter anywhere (`\p{L}`) | Reject 400 | `'description must contain at least one letter'` |
| Only digits (after stripping spaces) | Reject 400 | `'looks like a code, not a description — use /classify/expand or /boost'` |
| Contains digit-runs alongside text (e.g. `'shirt 89123'`) | Accept + run digit normalization (below) | Normal flow |
| Otherwise | Accept | Normal flow |

**Zod schema:**
```ts
const DescribeRequest = z.object({
  description: z.string()
    .trim()
    .min(3,   'too short — please describe the product')
    .max(500, 'too long — keep it under 500 characters')
    .refine(s => /\p{L}/u.test(s),
      'description must contain at least one letter')
    .refine(s => !/^\d+$/.test(s.replace(/\s/g, '')),
      'looks like a code, not a description — use /classify/expand or /boost')
});
```

**Digit normalization (replaces v0.x "hint" logic — batch consumers do not use hints)**

When the description contains digit-runs alongside text, we apply a deterministic normalization step before retrieval. **No silent endpoint routing, no advisory messages.**

| Detected pattern | Action | Why |
|---|---|---|
| Digit run < 4 digits (e.g. `'2024'`, `'123'`, `'12'`) | Keep as part of description text. Treat as quantity / year / model noise — embedder handles it. | Too short to be an HS prefix. |
| Digit run 4–11 digits AND does NOT match any chapter (first 2) or heading (first 4) in `hs_codes` | Strip silently before embedding. | If `'89123'` doesn't even start with a real chapter, it's noise (SKU, model number). Treating it as a prefix would poison retrieval. |
| Digit run 4–11 digits AND matches a real chapter or heading prefix | Keep digits in the embedded text (so the model sees them) AND apply a **soft retrieval bias**: candidates whose code starts with those digits get a `+ε` boost in RRF merge. **Not a hard filter.** | Cheap insurance: if merchant pre-classified correctly, we get the right branch faster. If they pre-classified wrong, the LLM still sees the rest of the tree. |
| Digit run is exactly 12 digits AND matches a real `hs_codes` row | **TBD — deferred for v1.** Currently treated as 12+ digit run (see below). Do NOT auto-route to `/boost` in v1; decide later based on Naqel data. | Auto-routing risks getting wrong-tree results when the digits are coincidentally a SKU. Deferred to a later version. |
| Digit run > 12 digits | Keep as text noise. | Almost certainly not an HS code. |

*Implementation: digit normalization runs as one regex pass + one cheap SQL existence check (`SELECT 1 FROM hs_codes WHERE code LIKE prefix || '%' LIMIT 1`) before retrieval. Total added cost: ~5 ms.*

### POST /classify/expand — validation rules

| Input | Action | Message |
|---|---|---|
| `code` missing or empty | Reject 400 | `'code is required'` |
| `code` contains non-digits | Reject 400 | `'code must be digits only'` |
| `code` length < 4 | Reject 400 | `'code must be at least 4 digits'` |
| `code` length > 11 | Reject 400 | `'code is 12 digits — use POST /boost instead'` |
| `description` provided but length < 3 | Reject 400 | `'description too short'` |
| `description` provided but contains no letter | Reject 400 | `'description must contain a letter'` |
| `description.length > 500` | Reject 400 | `'description too long'` |
| Otherwise | Accept (DB validation continues in flow) | |

*Note: 'prefix matches no rows' is **NOT** a 400 — it returns 200 with `decision_status='needs_clarification'` and `decision_reason='invalid_prefix'`. This is consistent with the rest of the contract: only malformed inputs are 400; semantic refusals are 200 with explicit `decision_reason`.*

**Zod schema:**
```ts
const ExpandRequest = z.object({
  code: z.string()
    .trim()
    .regex(/^\d+$/, 'code must be digits only')
    .refine(s => s.length >= 4 && s.length <= 11,
      'code must be 4–11 digits (use /boost for 12-digit codes)'),
  description: z.string().trim().min(3).max(500).optional()
    .refine(s => !s || /\p{L}/u.test(s),
      'description must contain a letter'),
});
```

### POST /boost — validation rules

| Input | Action | Message |
|---|---|---|
| `code` missing or empty | Reject 400 | `'code is required'` |
| `code` contains non-digits | Reject 400 | `'code must be digits only'` |
| `code` length ≠ 12 | Reject 400 | `'code must be exactly 12 digits — use POST /classify/expand for partial codes'` |
| `code` does not exist in `hs_codes` table | Reject 400 | `'unknown HS code <code>'` |
| `description` provided but length < 3 | Reject 400 | `'description too short'` |
| `description` provided but contains no letter | Reject 400 | `'description must contain a letter'` |
| `description.length > 500` | Reject 400 | `'description too long'` |
| Otherwise | Accept (sibling logic continues in flow) | |

*Note: the v0.x short-circuits ("only sibling exists", "no description provided") are no longer 400-level rules — they are `decision_reason` values returned with 200 (`'already_most_specific'` or `'needs_clarification'`). The endpoint always either commits or abstains explicitly.*

**Zod schema:**
```ts
const BoostRequest = z.object({
  code: z.string()
    .trim()
    .regex(/^\d{12}$/, 'code must be exactly 12 digits'),
  description: z.string().trim().min(3).max(500).optional()
    .refine(s => !s || /\p{L}/u.test(s),
      'description must contain a letter'),
});
```

### Cross-cutting validation behavior

- All Zod-level rejections run before any DB query or LLM call — zero cost for malformed input.
- DB-level rejections (e.g. `'unknown HS code'`) run as a single existence query and add ~5 ms.
- Error response shape (400 only) is consistent: `{ error: 'validation_error', field, message }`.
- **Semantic refusals never use 4xx** — they use 200 + `decision_status='needs_clarification'` + `decision_reason`.
- All raw input (sanitized of control characters) is logged into `classification_events.request` as jsonb for audit.

## A.6  Data model

Database: `psql-infp-clearai-dev-gwc-01`, logical DB `clearai`.
*Extensions: pgvector, pg_trgm, unaccent, pgcrypto. All PKs are uuid (`gen_random_uuid`).*

### Table 1 — hs_codes

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK default `gen_random_uuid()` | GUID primary key |
| `code` | `varchar(12)` unique not null | Zero-padded ZATCA code |
| `description_en` | `text` | English description |
| `description_ar` | `text` | Arabic description |
| `description_ar_norm` | `text` generated | `normalize_ar(description_ar)` |
| `duty_rate_text` | `text` | Raw, e.g. `'5%'`, `'معفاة'` |
| `duty_rate_pct` | `numeric` | Parsed numeric, nullable |
| `procedures` | `text` | Notes from ZATCA |
| `effective_date` | `date` | Validity start |
| `embedding` | `vector(384)` | Single multilingual embedding: `e5-small('passage: ' + description_en + ' ' + description_ar)`. |
| `tsv_en` | `tsvector` generated | `to_tsvector('english', description_en)` — language-specific stemming |
| `tsv_ar` | `tsvector` generated | `to_tsvector('simple', description_ar_norm)` — Arabic uses `'simple'` config + `normalize_ar()` |
| `chapter / heading / hs6 / hs8 / hs10` | `varchar` generated | Prefix slices: chapter=2, heading=4, hs6=6, hs8=8, hs10=10. `hs10` is the sibling group for `/boost`. |

*Indexes: HNSW on `embedding` (cosine); GIN on `tsv_en` + `tsv_ar`; GIN trigram on `description_en` + `description_ar_norm`; B-tree on `chapter / heading / hs6 / hs8 / hs10`; unique on `code`.*

### Table 2 — naqel_hs_decision_ledger

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK default `gen_random_uuid()` | GUID primary key |
| `merchant_hs_code` | `text` not null | Raw code as merchant declared |
| `hs_code` | `varchar(12)` not null | Naqel-verified 12-digit code |
| `ar_description` | `text` | Arabic description |
| `created_at` | `timestamptz` default `now()` | |

### Table 3 — classification_events

*Status-driven schema. No raw confidence column. Decision drivers (status + reason) and retrieval evidence are persisted side-by-side so we can tune thresholds offline.*

| Column | Type / Notes |
|---|---|
| `id` | `uuid` PK default `gen_random_uuid()` |
| `created_at` | `timestamptz` default `now()` |
| `endpoint` | `text` — `'describe'` \| `'expand'` \| `'boost'` |
| `request` | `jsonb` — raw request body |
| `language_detected` | `text` — `'en'` \| `'ar'` \| `'mixed'` |
| `decision_status` | `text` — `'accepted'` \| `'needs_clarification'` \| `'degraded'` |
| `decision_reason` | `text` — see A.5 reason table |
| `confidence_band` | `text` nullable — `'high'` \| `'medium'` \| `'low'` |
| `chosen_code` | `varchar(12)` nullable — null when `needs_clarification` |
| `alternatives` | `jsonb` — top candidates with `retrieval_score` (no LLM confidence persisted) |
| `top_retrieval_score` | `numeric` — RRF score of the top candidate |
| `top2_gap` | `numeric` — RRF score gap between top-1 and top-2 |
| `candidate_count` | `integer` — number of candidates after retrieval/walk |
| `branch_size` | `integer` nullable — total descendants under prefix (`/expand` and `/boost` only) |
| `llm_used` | `text` nullable — `'sonnet'` \| `'haiku'` \| null when no LLM call (gate failed or short-circuit) |
| `llm_status` | `text` — `'ok'` \| `'unavailable'` \| `'not_called'` |
| `guard_tripped` | `boolean` default `false` |
| `model_calls` | `jsonb` — per-call trace: model, tokens, latency, retry_count |
| `embedder_version` | `text` |
| `llm_model` | `text` |
| `total_latency_ms` | `integer` |
| `error` | `text` nullable |

### Table 4 — setup_meta

| Column | Type |
|---|---|
| `id` | `uuid` PK default `gen_random_uuid()` |
| `key` | `text` unique not null |
| `value` | `text` |
| `updated_at` | `timestamptz` default `now()` |

*Stores per-endpoint thresholds (`MIN_SCORE_describe`, `MIN_GAP_describe`, `MIN_SCORE_expand`, `MIN_GAP_expand`, `MIN_SCORE_boost`, `MIN_GAP_boost`, `BOOST_MARGIN`), `embedder_version`, `llm_model`, and `confidence_band` cut points. Editable without redeploy.*

## A.7  Data ingestion & re-embedding lifecycle

*How the `hs_codes` table gets populated and stays current. v1 is a single dev environment, so this is a manual/scripted lifecycle, not an automated pipeline.*

| Lifecycle event | Mechanism | Behavior |
|---|---|---|
| Initial load | `scripts/migrate-from-sqlite.ts` (one-shot) | Reads the legacy SQLite HS table, writes 4 v1 tables to Postgres. Inserts `hs_codes` rows with description fields populated; `embedding` is left NULL. Run once at v1 setup; idempotent on conflict (code) do nothing. |
| Embedding backfill | `scripts/embed-hs-codes.ts` | Iterates rows where `embedding IS NULL`, batches of 64, embeds `'passage: ' + description_en + ' ' + description_ar` with multilingual-e5-small, writes back. Resumable. Run once after initial load (~5–10 min for full table). |
| Updating a row | `scripts/upsert-hs-code.ts <code>` | Manual update for a single code. Updates description fields, sets `embedding=NULL`, then re-embeds that row. Used when ZATCA publishes a description correction. |
| Bulk re-embed (model change) | `scripts/reembed-all.ts` | Truncates the `embedding` column and re-runs `embed-hs-codes.ts`. Triggered when migrating to a new embedder model (logged in `setup_meta.embedder_version`). |
| Schema migrations | `drizzle-kit migrate` | Run via `deploy.yml` on every push to `main`, before the new revision is promoted. Migrations live in `packages/db/migrations/`. |

*Versioning: `setup_meta` stores `embedder_version` (e.g. `'multilingual-e5-small@v1'`) and `llm_model`. Every `classification_events` row records these so we can correlate quality regressions with model changes. If `embedder_version` changes, a re-embed pass is required before serving traffic on the new version.*

## A.8  Failure handling, timeouts, retries

*Failure handling has two layers: (1) what the endpoint returns to the client, expressed in the shared decision contract; (2) what we do to dependencies (timeouts, retries, fallbacks). Layer 1 is the contract; Layer 2 is the implementation that supports it.*

### Endpoint behavior — response contract per failure class

| Failure class | HTTP status | Response body shape | Rationale |
|---|---|---|---|
| Bad input (Zod validation failure, malformed code, unknown HS code, description too short/long) | 400 Bad Request | `{ error: 'validation_error', field, message }` | Caller can fix and retry. Zero retry on our side. **400 is reserved for malformed input only.** |
| No candidates / invalid prefix (semantic — input was well-formed but produced nothing) | 200 OK | `decision_status='needs_clarification'`, `decision_reason='weak_retrieval'` or `'invalid_prefix'` | Not an error class — this is a refusal. Same shape as any other refusal. |
| Evidence gate failed (`top_retrieval_score < MIN_SCORE` or `top2_gap < MIN_GAP`) | 200 OK | `decision_status='needs_clarification'`, `decision_reason='weak_retrieval'` or `'ambiguous_top_candidates'`, `alternatives` populated, `missing_attributes` populated when inferable | First-class structured outcome. Decision grounded on retrieval metrics + status flags only — no LLM self-report. **LLM was NOT called** (the rule: LLM never rescues weak retrieval). |
| Postgres down or unreachable after retries | 503 Service Unavailable | `{ error: 'database_unavailable', requestId, retryAfterSeconds: 5 }` | We cannot serve any classification without the DB. Caller should back off. |
| Foundry/LLM down after retries (gate already passed) | 200 OK | `decision_status='degraded'`, `decision_reason='llm_unavailable'`, `result` populated with top retrieval candidate | Retrieval still works; we degrade gracefully. Batch caller decides whether to accept or queue these rows for re-run when LLM recovers. |
| Key Vault unreachable at startup | Container fails health check | Container App does NOT promote the revision. No client traffic ever reaches a misconfigured replica. | Operational, not a request-time failure. |
| Hallucination guard trip (LLM returned code not in candidate set) | 200 OK | `decision_status='needs_clarification'`, `decision_reason='guard_tripped'`, `alternatives` populated | We do **NOT** silently substitute the top retrieval pick — guard-trip is a strong signal. Surface to caller as a refusal so it can be queued for review. `guard_tripped=true` in `classification_events` for monitoring. |
| Request timeout budget exceeded (cumulative ≥ 18 s of the 20 s ceiling) | 504 Gateway Timeout | `{ error: 'request_timeout', stageReached, requestId }` | Partial result is logged for diagnostics but not returned (would be misleading). |
| Unhandled exception | 500 Internal Server Error | `{ error: 'internal_error', requestId }` | Stack trace + full request logged via pino. Never leak internals to the client. |

### Dependency-level timeouts & retries (Layer 2 — what supports the contract above)

| Dependency | Timeout | Retry policy | Fallback / failure mode |
|---|---|---|---|
| Postgres query (Drizzle) | 5 s statement timeout (set per-session) | 1 retry on transient connection error (`ECONNRESET`, `ETIMEDOUT`) | If retry fails: 503, `error='database_unavailable'`. Logged with full stack. |
| LocalEmbedder (in-process) | n/a — synchronous in-process | No retry (failure means model didn't load → process is broken) | Health check fails → Container Apps restarts the replica. |
| Foundry LLM call (Sonnet/Haiku) | 15 s request timeout | 2 retries with exponential backoff (250ms, 1s) on 429 / 5xx / network error | If all retries fail AND evidence gate had passed: return `decision_status='degraded'` with top retrieval candidate. If gate had not yet been evaluated, evaluate it; if gate fails, return `needs_clarification` (gate result trumps fallback). |
| Key Vault secret read | 5 s timeout, cached in memory after first read | 1 retry on transient | If both fail at startup: container exits with non-zero so the bad revision is not promoted. |
| Hallucination guard trip | n/a (in-process check) | n/a | Force `decision_status='needs_clarification'` with `decision_reason='guard_tripped'`. Log `guard_tripped=true` in `classification_events`. **No silent substitution.** |

**Request timeout budget — explicit per dependency**

| Stage | Budget | Notes |
|---|---|---|
| Total request ceiling | 20 s | Hard cap from edge → response. If exceeded → 504. |
| Soft trip threshold | 18 s cumulative | After this, remaining steps are skipped — we return 504 rather than running into the hard cap mid-step. |
| Postgres (per query) | 5 s statement timeout | Set via `SET statement_timeout` per session. |
| Postgres (cumulative across all queries in a request) | ≤ 8 s | Hybrid retrieval = 1 vector + 2 BM25 + up to 2 trigram queries; budget keeps room for LLM. |
| LocalEmbedder (in-process) | ≤ 250 ms warm / ≤ 1.5 s first call | No network. First call after restart pays model-load cost (covered by health check, not request). |
| Foundry LLM (per call) | 15 s request timeout | Includes 2 retries with backoff (250 ms, 1 s). Retries count against this 15 s — not added on top. |
| Key Vault (per secret read) | 5 s | Cached in process after first read, so this only hits at startup. |

*Budgets are tracked with a per-request deadline timer (AbortController + `Date.now()`). Each step checks remaining budget before starting; if too little remains for that step's expected cost, we short-circuit to 504 with `stageReached` field populated.*

*Observability hooks: every fallback / retry / timeout is logged as a structured pino event with `requestId`, step name, `elapsed_ms`, and error class. `classification_events.error` captures the surfaced failure, `model_calls` captures per-LLM-call latency and retry count.*

## A.9  Validation & calibration plan

*Without this section the design is hand-wavy. Thresholds (`MIN_SCORE`, `MIN_GAP`, `BOOST_MARGIN`, `confidence_band` cut points) are not knobs we set by intuition — they are tuned against ground truth and tracked in production.*

### Eval set — build before locking thresholds

- Naqel ground-truth decisions (merchant raw → Naqel-verified 12-digit) — primary source.
- Reviewed historical examples — cases where the right answer was confirmed by human classifier.
- Hard ambiguous cases — cases where reasonable classifiers disagree; these belong in the "should abstain" bucket.
- Arabic, English, and mixed inputs — the eval set must mirror real input distribution.
- Stored in a versioned file (`eval/v1.jsonl`) so we can replay old eval runs after threshold changes.

### Threshold tuning — per endpoint, separately

Retrieval score distributions differ across endpoints (full corpus vs heading-bounded vs HS10-bounded). Same threshold across all three would either over-accept on `/describe` or over-refuse on `/boost`. Tune each independently:

| Threshold set | Tightness | Tuning target |
|---|---|---|
| `MIN_SCORE_describe` / `MIN_GAP_describe` | Strictest — full corpus, hardest path | Optimize for ≥ X% precision on `accepted` ('X' set by business; 95% is a defensible v1 target) |
| `MIN_SCORE_expand` / `MIN_GAP_expand` | Looser — branch-bounded by prefix | Same precision target, achievable with lower thresholds because retrieval space is constrained |
| `MIN_SCORE_boost` / `MIN_GAP_boost` / `BOOST_MARGIN` | Loosest baseline — but `BOOST_MARGIN` gates whether a sibling actually beats current | Same precision target. `BOOST_MARGIN` ensures we don't "refine" to a sibling that's only marginally better. |

### Metrics tracked in production

| Metric | Definition | Notes |
|---|---|---|
| `acceptance_rate` | % of requests where `decision_status='accepted'` | Per-endpoint. |
| `precision_on_accepted` | % of accepted decisions that match Naqel/human-verified ground truth | Sampled offline against eval set + spot-checks. |
| `abstention_rate` | % of requests where `decision_status='needs_clarification'` | Per-endpoint, per `decision_reason`. |
| `guard_trip_rate` | % of requests where `guard_tripped=true` | Anomaly indicator. Should be < 1% in steady state. |
| `degraded_rate` | % of requests where `decision_status='degraded'` | Tracks LLM availability. Should be near 0%. |
| `confidence_band_calibration` | For each band, what % of decisions are correct against ground truth | `'high'` should be ≥ 95% correct; `'medium'` ≥ 80%; `'low'` is honest signal that this answer is borderline. |

*Target operating principle: **only auto-answer when precision is high; otherwise abstain.** The acceptance rate is a knob, not a goal — we can always raise acceptance by lowering thresholds, but precision is what matters for ZATCA filings. A high abstention rate is acceptable in v1 if it means we never auto-file a wrong code.*

*Threshold storage: `setup_meta`. Editable via a single `UPDATE` without redeploy. Every threshold change is logged with a timestamp so we can correlate metric shifts to threshold changes.*

---

# Part B — Functionality

## B.1  User goals

| Goal | What the user wants | Endpoint | Input | Output |
|---|---|---|---|---|
| Goal 1 — Description → 12-digit code | I have a product description; tell me the 12-digit ZATCA HS code | `POST /classify/describe` | Description (EN, AR, or mixed). Language auto-detected. | `decision_status` + 12-digit code (when accepted) OR `missing_attributes` (when `needs_clarification`) |
| Goal 2 — Partial code → 12-digit code | I have a partial code (4–11 digits); complete it to a 12-digit code. Description optional. | `POST /classify/expand` | Partial code, optional description | `decision_status` + before/after pair (when accepted) OR refusal with reason |
| Goal 3 — Generic 12-digit code → more specific 12-digit code | I have a 12-digit code that is the generic catch-all; refine it to a more specific sibling if one fits the description. | `POST /boost` | 12-digit code + description (recommended) | `decision_status` + before/after pair (`after` may equal `before` for `'already_most_specific'`) |

## B.2  Flow per goal

*All three flows share the same skeleton: **retrieve → measure evidence → gate → (LLM if gate passes) → guard → resolve decision.** The LLM is never asked to rescue weak retrieval.*

### Goal 1 — POST /classify/describe flow

1. Input Validation
2. Language Detection
3. Digit Normalization
4. Query Vectorization (embed)
5. Hybrid Retrieval
6. Candidate Assembly (RRF merge, with prefix bias if applicable)
7. **Evidence Gate**
8. LLM Picking (Sonnet) — *only if gate passed*
9. Hallucination Guard
10. Decision Resolution
11. Response Composition
12. Audit Logging

### Goal 2 — POST /classify/expand flow

1. Input Validation
2. Prefix Resolution
3. Hierarchical Walk
4. Branch Ranking *(skipped if no description)*
5. **Evidence Gate**
6. LLM Picking (Haiku) — *only if gate passed AND > 1 candidate*
7. Hallucination Guard
8. Decision Resolution
9. Before/After Composition
10. Audit Logging

### Goal 3 — POST /boost flow

1. Input Validation
2. Prefix Resolution
3. Hierarchical Walk *(siblings only)*
4. Branch Ranking *(skipped if no description)*
5. **Boost Margin Check**
6. **Evidence Gate**
7. LLM Picking (Haiku) — *only if gate passed AND a sibling beats current by margin*
8. Hallucination Guard
9. Decision Resolution
10. Before/After Composition
11. Audit Logging

## B.3  Step library

*Each step is shared across goals where applicable. Format: "N. Name: short purpose." followed by its sub-steps table.*

**1. Input Validation:** Reject malformed requests at the API. Tech: Fastify + Zod.

| # | Action |
|---|---|
| 1.1 | Fastify receives request |
| 1.2 | Zod parses body against the endpoint's request schema |
| 1.3 | Reject malformed input (returns 400 with structured error) |
| 1.4 | Attach `requestId` from `x-request-id` header or generate a new GUID |

**2. Language Detection:** Decide if input is English, Arabic, or mixed so we know which BM25/trigram queries to run. Tech: pure TS, Unicode block counting.

| # | Action |
|---|---|
| 2.1 | Count Arabic Unicode codepoints (U+0600–U+06FF) vs Latin in the description |
| 2.2 | Set `lang ∈ {en, ar, mixed}` based on ratio thresholds |
| 2.3 | Persist into `classification_events.language_detected` |

**3. Digit Normalization:** Handle digit-runs in descriptions deterministically. No silent endpoint routing, no advisory hints. Tech: pure TS regex + one cheap SQL existence check.

| # | Action |
|---|---|
| DN.1 | Find all digit-runs of length ≥ 4 in description |
| DN.2 | For each run: `SELECT 1 FROM hs_codes WHERE code LIKE run \|\| '%' LIMIT 1` |
| DN.3 | If run does NOT match any chapter/heading → strip from text before embedding |
| DN.4 | If run matches a chapter/heading → keep in text AND record run as soft prefix bias for RRF merge |
| DN.5 | 12-digit run that matches a real `hs_codes` row: **TBD/deferred for v1** — keep in text, no auto-route. Decision deferred to a later version pending Naqel data analysis. |
| DN.6 | Pass normalized text + bias prefixes (if any) forward |

**4. Query Vectorization (embed):** Turn the description text into a 384-dim numeric vector that lives in the same space as HS row vectors. Tech: `@xenova/transformers` + multilingual-e5-small.

| # | Action |
|---|---|
| 3.1 | Prefix description with `'query: '` (e5 convention) |
| 3.2 | Call `LocalEmbedder.embed([text])` → in-process ONNX inference |
| 3.3 | Returns `Float32Array(384)`, L2-normalized |
| 3.4 | Convert to pgvector literal for SQL parameter |

**5. Hybrid Retrieval:** Pull candidate HS rows using complementary signals: semantic (single multilingual vector) + keyword (language-specific BM25) + fuzzy (trigram). Tech: pgvector + tsvector + pg_trgm.

| # | Action |
|---|---|
| 4.1 | Vector query: `ORDER BY embedding <=> $queryVec LIMIT 50` |
| 4.2 | EN BM25 (if `lang ∈ {en, mixed}`): `ts_rank(tsv_en, plainto_tsquery('english', $text)) DESC LIMIT 50` |
| 4.3 | AR BM25 (if `lang ∈ {ar, mixed}`): `ts_rank(tsv_ar, plainto_tsquery('simple', normalize_ar($text))) DESC LIMIT 50` |
| 4.4 | EN trigram fallback (if EN BM25 < 10 hits AND `lang ∈ {en, mixed}`): `ORDER BY similarity(description_en, $text) DESC LIMIT 25` |
| 4.5 | AR trigram fallback (if AR BM25 < 10 hits AND `lang ∈ {ar, mixed}`): `ORDER BY similarity(description_ar_norm, normalize_ar($text)) DESC LIMIT 25` |

**6. Candidate Assembly (RRF merge):** Combine candidate lists from different retrieval methods into one ranked list. Tech: pure TS, reciprocal rank fusion.

| # | Action |
|---|---|
| 5.1 | Merge result sets keyed by `code` |
| 5.2 | RRF: `score = Σ 1 / (k + rank_i)` across methods |
| 5.3 | If digit-normalization recorded a soft prefix bias, add `+ε` to candidates whose code starts with that prefix (**NOT a hard filter** — losing candidates still in play) |
| 5.4 | Take top 25 by RRF score |
| 5.5 | Hydrate full row text (EN + AR) for the LLM prompt |

**7. Prefix Resolution:** Read the input code, fetch human-readable text for the `before` field, and decide the search prefix for the walk. Tech: SQL lookups + plain TS.

| # | Action |
|---|---|
| PR.1 | Determine input length |
| PR.2 | If 12 digits (Goal 3 — `/boost`): look up the row for `before` text; set search prefix = `code.slice(0, parentPrefixLength)`. v1 uses `parentPrefixLength=10`. |
| PR.3 | If 4–11 digits (Goal 2 — `/expand`): look up heading text if available for `before`, else null; set search prefix = input as-is |
| PR.4 | Pass the resolved prefix forward to Hierarchical Walk |

**8. Hierarchical Walk:** Traverse the HS tree downward from the resolved prefix to collect 12-digit descendants. Tech: PostgreSQL B-tree + LIKE filter.

| # | Action |
|---|---|
| W.1 | SQL: `SELECT * FROM hs_codes WHERE code LIKE $prefix \|\| '%' AND length(code) = 12` |
| W.2 | For Goal 3 (`/boost`): exclude the declared code itself before ranking — siblings only. |
| W.3 | Record `branch_size` = number of descendants returned |
| W.4 | If 0 descendants for `/expand` → short-circuit: `decision_reason='invalid_prefix'`. If 0 siblings for `/boost` → short-circuit: `decision_reason='already_most_specific'`. |
| W.5 | If exactly 1 descendant for `/expand` → short-circuit: `decision_reason='single_valid_descendant'`, skip LLM, go to Decision Resolution. |

**9. Branch Ranking:** Score the candidates against the description so the Evidence Gate sees them in priority order. Skipped entirely if no description was provided. Tech: pgvector + tsvector scoped to the branch.

| # | Action |
|---|---|
| R.1 | Embed description with LocalEmbedder (`'query: '` prefix) |
| R.2 | Score each descendant: cosine similarity on `embedding` + `ts_rank` on `tsv_en`/`tsv_ar` by detected language |
| R.3 | Sort by combined RRF score, keep top 10 |
| R.4 | If no description was provided, skip ranking; pass the unranked descendant set forward (Evidence Gate may still gate on `candidate_count` or short-circuit to `needs_clarification`). |

**10. Boost Margin Check:** `/boost` only. Decide whether any sibling actually beats the current code by enough to warrant a refinement. Tech: pure TS.

| # | Action |
|---|---|
| BM.1 | Compute `current_score` = retrieval_score of the declared code against the description (or null if no description) |
| BM.2 | Compute `top_sibling_score` = retrieval_score of the highest-ranked sibling |
| BM.3 | If `(top_sibling_score - current_score) < BOOST_MARGIN` OR no description was given → short-circuit: `decision_reason='already_most_specific'`, skip LLM, `after = before` |
| BM.4 | Else: pass the sibling candidate set to the Evidence Gate |

**11. Evidence Gate:** Decide whether retrieval evidence is strong enough to call the LLM. **The architectural rule: the LLM never rescues weak retrieval.** Tech: pure TS thresholding on retrieval metrics + per-endpoint thresholds from `setup_meta`.

| # | Action |
|---|---|
| EG.1 | Compute `top_retrieval_score` = `alternatives[0].retrieval_score` |
| EG.2 | Compute `top2_gap` = `alternatives[0].retrieval_score - alternatives[1].retrieval_score` (or `+∞` if only 1 candidate) |
| EG.3 | Persist `top_retrieval_score`, `top2_gap`, `candidate_count`, `branch_size` to request context for logging |
| EG.4 | If `candidate_count == 0` → gate FAILS with reason `'weak_retrieval'` (or `'invalid_prefix'` for `/expand`) |
| EG.5 | If `top_retrieval_score < MIN_SCORE(endpoint)` → gate FAILS with reason `'weak_retrieval'` |
| EG.6 | If `top2_gap < MIN_GAP(endpoint)` → gate FAILS with reason `'ambiguous_top_candidates'` |
| EG.7 | Otherwise → gate PASSES; proceed to LLM Picking |
| EG.8 | If gate fails: skip LLM entirely, populate alternatives + `missing_attributes`, hand off to Decision Resolution with the failure reason |
| EG.9 | Endpoint-specific thresholds (initial placeholder, calibrate per A.9): `describe MIN_SCORE=0.30 / MIN_GAP=0.04`; `expand MIN_SCORE=0.20 / MIN_GAP=0.03`; `boost MIN_SCORE=0.20 / MIN_GAP=0.03 / BOOST_MARGIN=0.05`. All in `setup_meta`. |

**12. LLM Picking (Sonnet):** Have a strong LLM read the description and pick from candidates that ALREADY passed the evidence gate. Tech: Anthropic SDK → Foundry → Claude Sonnet.

| # | Action |
|---|---|
| 6.1 | Build prompt: system message + user message with description and numbered candidate list (EN + AR) |
| 6.2 | Call Sonnet via `@anthropic-ai/sdk` pointed at Foundry baseURL |
| 6.3 | Parse JSON: `{ chosen_code, rationale }` |
| 6.4 | **Note: we do NOT ask the LLM for a confidence number.** The LLM is a picker, not a calibrator. |

**13. LLM Picking (Haiku):** Pick the most specific 12-digit leaf from a small candidate set. Used by `/expand` and `/boost` after the evidence gate passes. Tech: Anthropic SDK → Foundry → Claude Haiku.

| # | Action |
|---|---|
| P.1 | Build prompt: declared/prefix code + optional description + ranked candidates with EN + AR text |
| P.2 | Instruction: `'Return the most specific 12-digit code from the list. Do NOT invent a code.'` |
| P.3 | Call Haiku via `@anthropic-ai/sdk` pointed at Foundry baseURL |
| P.4 | Parse `{ chosen_code, rationale }` |

**14. Hallucination Guard:** Make sure the LLM only returned a code we actually showed it. Tech: pure TS.

| # | Action |
|---|---|
| G.1 | Verify `chosen_code` exists in the candidate set we sent |
| G.2 | If not: set `guard_tripped=true` on the request context, log a guard-trip event with the offending `chosen_code` and the candidate set. |
| G.3 | Pass the `guard_tripped` flag forward to Decision Resolution. **Do NOT silently substitute the top retrieval pick.** |

**15. Decision Resolution:** Map the (gate result, LLM result, guard result) tuple to `decision_status` + `decision_reason`. Single source of truth for the API contract. Tech: pure TS.

| # | Action |
|---|---|
| DR.1 | If `guard_tripped` → `decision_status='needs_clarification'`, `decision_reason='guard_tripped'` |
| DR.2 | Else if gate failed → `decision_status='needs_clarification'`, `decision_reason` from gate (`'weak_retrieval'` / `'ambiguous_top_candidates'` / `'invalid_prefix'`) |
| DR.3 | Else if `/boost` short-circuited `'already_most_specific'` → `decision_status='accepted'`, `decision_reason='already_most_specific'`, `after = before` |
| DR.4 | Else if `/expand` short-circuited `'single_valid_descendant'` → `decision_status='accepted'`, `decision_reason='single_valid_descendant'` |
| DR.5 | Else if LLM was called and returned a valid pick → `decision_status='accepted'`, `decision_reason='strong_match'` |
| DR.6 | Else if LLM was called but unavailable AND fallback ran → `decision_status='degraded'`, `decision_reason='llm_unavailable'`, use top retrieval candidate |
| DR.7 | Map to `confidence_band` (when accepted): `'high'` if `top_retrieval_score ≥ HIGH_BAND_CUT` AND `top2_gap ≥ HIGH_BAND_GAP_CUT`; `'medium'` if ≥ MEDIUM cuts; else `'low'`. Cuts in `setup_meta`, calibrated per A.9. |

**16. Response Composition:** Assemble the `/describe` response with canonical text and validated shape. Tech: Drizzle + Zod.

| # | Action |
|---|---|
| RC.1 | If accepted: look up `chosen_code` in `hs_codes` for canonical EN + AR; populate `result.code`, `.description_en`, `.description_ar`, `.rationale`, `.alternatives` |
| RC.2 | If `needs_clarification`: `result` is omitted; populate `alternatives` (top 3) + `missing_attributes` (inferred heuristically from what's absent in the description: material/intended_use/product_type/dimensions/composition) + `rationale` |
| RC.3 | If degraded: same as accepted shape, but `decision_status='degraded'` |
| RC.4 | Validate against Zod response schema before returning |

**17. Before/After Composition:** Build the before/after diff for `/expand` and `/boost`. Tech: pure TS + Zod.

| # | Action |
|---|---|
| BA.1 | `before.code = input.code`; `before.description_en` from prefix lookup (may be null in `/expand`) |
| BA.2 | If accepted: `after.code = chosen_code`; `after.description_en` + `.description_ar` from row lookup |
| BA.3 | If `decision_reason='already_most_specific'` (`/boost`): `after = before`. `evidence='no sibling beats current code by required margin'`. |
| BA.4 | If `needs_clarification`: `after` omitted; `alternatives` + `missing_attributes` populated |
| BA.5 | If degraded: `after` = top retrieval candidate; `evidence` notes LLM was unavailable |
| BA.6 | Validate against Zod response schema |

**18. Audit Logging:** Persist every classification with full trace for compliance, debugging, and threshold tuning. Tech: PostgreSQL + Drizzle + pino.

| # | Action |
|---|---|
| AL.1 | Insert `classification_events` row with: `decision_status`, `decision_reason`, `confidence_band`, `chosen_code`, `alternatives`, `top_retrieval_score`, `top2_gap`, `candidate_count`, `branch_size`, `llm_used`, `llm_status`, `guard_tripped`, `model_calls`, `embedder_version`, `llm_model`, `total_latency_ms`, `error` |
| AL.2 | Log structured pino event with same key fields for stdout aggregation |
| AL.3 | Return response to client |

---

# Part C — Scaffold checklist (when you say "go")

- GitHub repo with two branches: `dev` (working), `main` (deployable, linked to Container App)
- `clearai-backend/` pnpm workspace root
- `apps/api/` Fastify + Zod + Swagger; three routes wired with stub handlers (`/classify/describe`, `/classify/expand`, `/boost`)
- `packages/db/` Drizzle schema for the 4 v1 tables (uuid PKs), migration files
- `packages/embeddings/` `Embedder` interface + `LocalEmbedder` (multilingual-e5-small)
- `packages/retrieval/` hybrid retrieval, branch-walk helper, RRF merge with prefix bias, evidence gate
- `packages/decision/` Decision Resolution module + threshold loader from `setup_meta`
- `packages/llm/` Anthropic SDK pointed at Foundry baseURL, Sonnet + Haiku exports, prompt templates (no confidence-asking)
- `packages/eval/` eval harness + `eval/v1.jsonl` seed set + threshold sweep CLI
- `scripts/migrate-from-sqlite.ts` one-shot importer for the 4 v1 tables
- `docker-compose.yml` pgvector pg16 + extensions
- `infra/bicep/` `postgres.bicep`, `cae.bicep`, `containerapp.bicep`, `keyvault.bicep`, `main.bicep`
- `.github/workflows/` `ci.yml` (`dev` + `main`) + `deploy.yml` (`main` only) with OIDC
- `docs/adr/` ADRs 001–008 (incl. ADR on shared decision contract + LLM-never-rescues-weak-retrieval rule)
