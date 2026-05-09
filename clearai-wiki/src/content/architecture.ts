// ─── Architecture — Content (single source of truth) ─────
// V1 = the TypeScript / Fastify backend that ships against Naqel today.
// V2 = a short list of structural changes when traffic and features force them.
// Edit HERE → TSX page picks it up; nothing else has to change.

export const PAGE = {
  chapter: 'Chapter 03 · Engineering',
  pageTitle: 'Technical Architecture',
  hero: {
    kicker: 'Chapter 03 · Engineering',
    title: 'Technical architecture',
    titleAccent: 'architecture',
    lede:
      "V1 is a single TypeScript service (Fastify on Node 20) backed by PostgreSQL with pgvector. " +
      "Two endpoints, one shared decision contract, an Evidence Gate that runs before any LLM call, " +
      "and a hallucination guard that refuses any code outside the candidate set. Everything below is " +
      "pulled directly from the shipping code in clearai-backend.",
  },
};

export const SYSTEM_ARCH = {
  num: '03',
  label: 'Architecture',
  title: 'V1 system architecture',
  oneLiner:
    "A controlled classification engine — not a generic chatbot. Retrieve a narrow set of valid ZATCA codes from our database, then let the model choose among them under guardrails.",

  // ── Identity card: what + why
  identity: {
    what: {
      title: 'What it is',
      body:
        'A retrieval-plus-reasoning system. We do not ask an LLM to invent classifications. We narrow the universe to plausible ZATCA-compliant HS codes from our own database, then use the LLM only to choose among those candidates and explain the choice. That is the core safety pattern.',
    },
    why: {
      title: 'Why it matters',
      body:
        'Customs decisions must be accurate and auditable. The design optimises for three things — high precision on accepted classifications, explicit abstention when evidence is weak, and full traceability of every result.',
      pillars: [
        { tag: 'Precision',     body: 'High accuracy on accepted classifications.' },
        { tag: 'Abstention',    body: 'Explicit "needs clarification" when evidence is weak.' },
        { tag: 'Traceability',  body: 'Full audit trail from request to result.' },
      ],
    },
  },

  // ── Core components (HLD blocks)
  components: [
    {
      key: 'api',
      tag: 'API layer',
      stack: 'Node 20 · TypeScript · Fastify v5',
      body: 'Exposes POST /classifications (free-text → code), POST /classifications/expand (prefix + description → leaf), GET /classifications/{id} (trace), POST /classifications/{id}/feedback, and POST /classifications/{id}/submission-description. Handles Zod validation, the APIM origin lock, per-IP rate limit, and a /health vs /ready split for cold-start gating.',
    },
    {
      key: 'pg',
      tag: 'PostgreSQL — system of record',
      stack: 'PostgreSQL 16 · pgvector HNSW · pg_trgm · tsvector',
      body: 'Stores the ZATCA tariff catalogue, the broker mapping table, the procedure-codes lookup, append-only audit events, human feedback, and tunable thresholds — and runs vector, keyword, and fuzzy retrieval. Search and source-of-truth live in one platform.',
    },
    {
      key: 'embed',
      tag: 'Embedding layer',
      stack: 'multilingual-e5-small · 384-dim · in-process ONNX',
      body: 'Converts product descriptions into multilingual vectors so the system can retrieve semantically similar HS codes in English or Arabic. Warmed at boot so the readiness probe only flips green once the first forward pass has run.',
    },
    {
      key: 'llm',
      tag: 'LLM decision layer',
      stack: 'Anthropic via Foundry · Sonnet 4.6 (broad) · Haiku 4.5 (narrow)',
      body: 'Layered: cleanup (Haiku) → researcher (Sonnet, optionally web-search) → picker (Sonnet) → branch-rank rerank (Sonnet) → submission-description generator (Haiku, on demand). Each stage either short-circuits or hands a tighter problem to the next.',
    },
    {
      key: 'controls',
      tag: 'Audit, feedback & controls',
      stack: 'classification_events · classification_feedback · broker_code_mapping · setup_meta · model_calls trace · Log Analytics',
      body: 'Every request captures input, per-stage model traces, candidate evidence, latency, and outcome. Brokers can confirm / reject / propose-alternative on any prior classification — those rows are gold-standard supervision data for tuning the picker.',
    },
  ],

  // ── Request flow — the named steps
  flowTitle: 'How a request works',
  flowIntro:
    'Every request follows the same operating pattern. The LLM never rescues weak retrieval — when evidence is weak or ambiguous the service returns a structured needs_clarification outcome (or a clearly-marked best_effort heading) instead of forcing a full leaf answer. That is a deliberate quality control mechanism, not a failure mode.',
  flow: [
    { n: '01', name: 'Validate input',                icon: '◉', body: 'Zod-checked body (description ≤ 250 chars; expand also requires a 4–10 digit parent prefix). Bad shape → 400.' },
    { n: '02', name: 'Merchant cleanup (optional)',   icon: '✂', body: 'If the input looks noisy (SKUs, brand fragments, marketing chrome), Haiku rewrites it to a clean customs noun and tags it product / merchant_shorthand / ungrounded.' },
    { n: '03', name: 'Query Vectorization (embed)',   icon: '∿', body: 'Cleaned text is embedded into a 384-dim multilingual vector — in-process ONNX, no external model service.' },
    { n: '04', name: 'Hybrid retrieval',              icon: '⌖', body: 'Three arms over Postgres fused with Reciprocal-Rank Fusion: pgvector cosine, tsvector BM25 (EN + AR), pg_trgm fuzzy similarity.' },
    { n: '05', name: 'Hierarchical Walk',             icon: '⌥', body: 'Expand path: retrieval is hard-filtered to leaves under the supplied prefix. Describe path: a chapter-coherence + noun-alignment check decides whether to trust the top set or escalate to the researcher.' },
    { n: '06', name: 'Researcher (escalation)',       icon: '🔎', body: 'When understanding fails, Sonnet rewrites the input from world knowledge ("Loewe Puzzle" → leather handbag). Optional web-search-augmented retry on UNKNOWN. Re-retrieves on the canonical phrase.' },
    { n: '07', name: 'Evidence Gate',                 icon: '▣', body: 'Top RRF score must clear MIN_SCORE and beat the runner-up by MIN_GAP, with a thin-input cross-chapter spread guard. Fail → abstain; the picker never runs.' },
    { n: '08', name: 'LLM pick',                      icon: '◆', body: 'Sonnet picks among the shortlist with a rationale; Haiku does the equivalent for within-branch expand. A hallucination guard rejects any code outside the candidate set.' },
    { n: '09', name: 'Branch-rank rerank',            icon: '↕', body: 'On accepted picks, Sonnet reranks every leaf in the chosen HS-8 branch with per-row reasoning. May override the picker when the wider view sees a better fit.' },
    { n: '10', name: 'Best-effort fallback',          icon: '◇', body: 'If picker + branch-rank produce no accepted leaf, the route may emit a 4-digit heading at confidence_band=low — gated behind a verify-toggle on the frontend.' },
    { n: '11', name: 'Enrich + log',                  icon: '✓', body: 'Look up duty rate + import procedures from the catalogue. Append a full classification_events row (request, per-stage model_calls trace, latency, outcome). Return the structured envelope with a request_id for trace + feedback.' },
  ],

  // ── The two business flows (paths through the same skeleton)
  businessFlows: [
    {
      key: 'describe',
      tag: 'Describe',
      title: 'Free-text → 12-digit code',
      body: 'A free-text product description is matched against the full HS universe. The most complex path, so it uses the strictest evidence gate before any answer is accepted.',
      uses: ['Embed', 'Hybrid retrieval', 'Evidence Gate (strict)', 'LLM (Sonnet)', 'Guard'],
    },
    {
      key: 'expand',
      tag: 'Expand',
      title: 'Partial code (4–11 digits) → 12-digit leaf',
      body: 'A partial code narrows the search to one branch of the HS tree, then the best final 12-digit leaf is selected — a hierarchical walk under the supplied prefix.',
      uses: ['Embed', 'Hierarchical Walk', 'Hybrid retrieval (branch-filtered)', 'Evidence Gate', 'LLM (Haiku)', 'Guard'],
    },
  ],

  // ── Why this design is safe + practical (compact pillars)
  safetyTitle: 'Why this design is safe and practical',
  safety: [
    { tag: 'Constrained outputs',  body: 'The model can only choose codes that already exist in our database — never invent new ones.' },
    { tag: 'Compact stack',        body: 'Postgres is both the operational DB and the retrieval engine. One language end-to-end. One always-on line item.' },
    { tag: 'LLM where it adds value', body: 'The model picks and explains; it is never the source of truth. Retrieval and the gate decide whether the model is even called.' },
    { tag: 'Operationally lightweight', body: 'One TypeScript backend, one PostgreSQL database, Azure-hosted models, Key Vault for secrets, CI/CD with infrastructure-as-code.' },
  ],
};

// ── Section A: Tech Stack ─────────────────────────────────
export const TECH_STACK = {
  sectionLabel: 'A',
  sectionName: 'Tech Stack',
  title: 'TypeScript end-to-end, Postgres-as-the-index, in-process embeddings',
  desc:
    "V1 deliberately avoids a separate vector DB, a separate model server, and a separate orchestrator. " +
    "Everything that can live inside Postgres lives there; everything that can live inside the Fastify " +
    "process lives there. The only external dependency at request time is the Foundry-fronted Anthropic " +
    "endpoint for the LLM call.",
  rows: [
    { layer: 'Runtime',        choice: 'Node 20 + TypeScript (strict)',                     why: 'One language across server, scripts, tests, schemas, and the React island in clearai-frontend.' },
    { layer: 'HTTP',           choice: 'Fastify v5 + @fastify/sensible + @fastify/cors + @fastify/rate-limit', why: 'Fast, schema-first, first-class hooks for the APIM origin lock and per-IP rate limit.' },
    { layer: 'Validation',     choice: 'Zod',                                               why: 'Runtime body validation per endpoint; same schemas drive types via z.infer.' },
    { layer: 'DB driver',      choice: 'pg + Drizzle ORM',                                  why: 'Drizzle for migrations and typed reads; raw pg.query for the hybrid-retrieval SQL where Drizzle would only get in the way.' },
    { layer: 'Database',       choice: 'PostgreSQL 16 (Azure Flexible Server, B1ms)',        why: 'Single store for codes, embeddings, the decision ledger, and tunable thresholds.' },
    { layer: 'Extensions',     choice: 'vector (HNSW), pg_trgm, unaccent, pgcrypto',         why: 'Cosine ANN, fuzzy similarity, accent-insensitive matching, gen_random_uuid().' },
    { layer: 'Search arms',    choice: 'pgvector cosine + tsvector ts_rank_cd + similarity()', why: 'Three independent retrieval signals fused with RRF — robust to any single arm being weak.' },
    { layer: 'Embeddings',     choice: '@xenova/transformers · Xenova/multilingual-e5-small (384-dim)', why: 'In-process ONNX, multilingual (EN + AR), no GPU, no extra service. Pipeline init promise is cached and warmed at boot via /ready.' },
    { layer: 'LLM',            choice: '@anthropic-ai/sdk → Foundry baseURL · Sonnet 4.6 (LLM_MODEL_STRONG) · Haiku 4.5 (LLM_MODEL)', why: 'Sonnet for cleanup-aware tasks (research, picker, branch-rank); Haiku for cheap structural tasks (merchant cleanup, submission-description generation).' },
    { layer: 'Observability',  choice: 'pino + pino-pretty (dev) · classification_events (per-request) · Log Analytics (Container Apps)', why: 'pino for stdout, classification_events for the structured per-request decision trail, Log Analytics for platform-level telemetry.' },
    { layer: 'Tooling',        choice: 'pnpm workspace · vitest · tsx · tsc',               why: 'Same scripts run locally and in CI.' },
    { layer: 'Container',      choice: 'Multi-stage Docker on distroless/nodejs20',          why: 'Small attack surface; pnpm install --prod in the runtime stage.' },
    { layer: 'IaC',            choice: 'Bicep (Postgres / Key Vault / Log Analytics / Container Apps Env / Container App / APIM)', why: 'One `./deploy.sh` is idempotent and reproducible.' },
    { layer: 'CI/CD',          choice: 'GitHub Actions OIDC → GHCR → Container App revision', why: 'No long-lived cloud creds; image promoted by digest, not tag.' },
  ],
};

// ── Section B: Azure Deployment ────────────────────────────
export const DEPLOYMENT = {
  sectionLabel: 'B',
  sectionName: 'V1 Deployment',
  title: 'Entra-protected SPA → APIM → Container App, all secrets via managed identity',
  desc:
    "Single Azure subscription (sub-infp-clearai-nonprod-gwc, Germany West Central). The browser " +
    "loads the SPA from a Static Web App, signs the user in against Microsoft Entra ID via MSAL.js " +
    "(authorization-code + PKCE), then calls APIM with the Entra access token. APIM validates the " +
    "JWT against the Entra JWKS, injects a Key-Vault-backed shared secret as a second layer of " +
    "origin lock, then forwards to the Container App. The backend never holds passwords or API " +
    "keys directly — every secret is fetched from Key Vault using the Container App's system-assigned " +
    "managed identity at startup, and every blob read/write uses the same MI against the storage " +
    "account. Bicep modules are environment-gated: dev keeps the pragmatic public-network posture " +
    "that Container Apps Consumption requires; stg/prd flip to private endpoints. Total dev cost " +
    "is roughly $20–25/month (Postgres B1ms is the only always-on line item).",
  resources: [
    { name: 'Static Web App `stapp-infp-clearai-dev-gwc-01`',                      note: 'Hosts the SPA (Vite + React, MSAL.js). Custom domain clearai-dev.infinitepl.app + auto-hostname *.azurestaticapps.net. Static files only — no SWA-managed Functions.' },
    { name: 'API Management `apim-infp-clearai-be-dev-gwc-01` (Consumption)',      note: 'validate-jwt against Entra JWKS · KV-backed shared-secret injected on forward · per-API rate-limit · CORS allowlist mirrors backend CORS_ORIGINS.' },
    { name: 'Container App `ca-infp-clearai-be-dev-gwc-01` (0.5 vCPU / 1 GiB)',     note: 'Fastify on Node 20. System-assigned MI. min=1 (always-warm)/max=2. Liveness=/health, readiness=/ready. KV secrets via secretref; storage + DB via DefaultAzureCredential.' },
    { name: 'Container Apps Environment `cae-infp-clearai-dev-gwc-01`',            note: 'Consumption tier wired to Log Analytics. Cannot bind to Private Endpoints (would require Workload Profiles env + VNet) — drives the dev network posture decisions.' },
    { name: 'Postgres Flexible Server `psql-infp-clearai-dev-gwc-01` (B1ms, PG 16)', note: 'Public + SSL on dev only; firewall = AllowAllAzureServicesAndResourcesWithinAzureIps (dev) + operator IP. Extensions: vector (HNSW) / pg_trgm / unaccent / pgcrypto. Three roles: clearai_admin · clearai_migrator · clearai_app (least-privilege runtime).' },
    { name: 'Storage Account `stinfpclearaidevgwc01` (Standard_LRS, MI-only)',     note: 'Container `declaration-runs/` stores per-run input.csv + classifications.json + manifest.json + HV/LV XMLs under {operatorSlug}/YYYY/MM/DD/{runId}/. allowSharedKeyAccess=false; allowBlobPublicAccess=false; SPA downloads via 5-min user-delegation SAS URLs minted by the backend MI.' },
    { name: 'Key Vault `kv-infp-clearai-dev-gwc` (Standard, RBAC)',                note: 'postgres-* connection strings · anthropic-api-key · apim-shared-secret · foundry-embed-api-key. Container App MI has Key Vault Secrets User; APIM MI has Key Vault Secrets User (used by the named-value KV reference).' },
    { name: 'Log Analytics workspace `log-infp-clearai-dev-gwc`',                  note: 'Container App console + system logs (pino structured JSON). APIM diagnostic settings forward GatewayLogs and metrics. 30-day retention, 1 GB/day cap.' },
    { name: 'Azure AI Foundry deployments (Sweden Central, separate sub)',         note: 'Anthropic-on-Foundry: claude-haiku-4-5-clearai-dev + claude-sonnet-4-6-clearai-dev. Embedder: text-embedding-3-large-clearai-dev (1024 dims). Backend talks to Foundry via API key from KV, not direct anthropic.com.' },
    { name: 'Entra app registrations (Infinite Apps tenant, ef324fec-...)',         note: 'ClearAI API DEV (protected resource) · ClearAI SPA DEV (public, MSAL PKCE) · ClearAI CLI DEV (public, device code). SPA is in API\'s knownClientApplications + preAuthorizedApplications for combined consent.' },
  ],
  posture: [
    {
      heading: 'Two-layer auth at APIM: Entra JWT + KV-backed origin lock.',
      body:
        'APIM\'s inbound policy runs validate-jwt first against the Entra JWKS endpoint for the ' +
        'Apps tenant — audience = ClearAI API DEV appId, issuer pinned to v2.0. On success it ' +
        'strips any client-supplied x-apim-shared-secret (anti-spoof), then re-injects the value ' +
        'from a Key-Vault-backed named value. The backend\'s onRequest hook then enforces that ' +
        'header on every non-probe request. A request must satisfy both layers (valid user JWT ' +
        'AND APIM-injected secret) — bypassing one is not enough. The APIM named value is bound ' +
        'to the KV secret via the APIM system MI, so secret rotation propagates without redeploy.',
      code: 'validate-jwt + x-apim-shared-secret',
    },
    {
      heading: 'SPA sign-in: MSAL.js redirect + PKCE, no client secret in the browser.',
      body:
        'The browser uses @azure/msal-browser to do an authorization-code flow with PKCE against ' +
        'the ClearAI SPA DEV app reg (single-page-application platform, not Web). Cache lives in ' +
        'sessionStorage so the auth round-trip survives page unload but not tab close. The SPA is ' +
        'in the API app reg\'s knownClientApplications list, so consent for both apps is combined ' +
        'into a single prompt; otherwise the silent-token iframe times out (monitor_window_timeout). ' +
        'Redirect URIs are pinned per-environment on the SPA platform.',
    },
    {
      heading: 'Managed identity all the way down — backend never holds long-lived secrets.',
      body:
        'The Container App\'s system-assigned MI has three role assignments: Key Vault Secrets User ' +
        '(reads connection strings + API keys), Storage Blob Data Contributor (read/write blobs + ' +
        'mint user-delegation SAS), and Postgres role-mapped via password from KV. KV secretrefs ' +
        'resolve at container start so no secret material is ever rendered into env vars on disk. ' +
        'DefaultAzureCredential resolves to the MI at runtime — same credential type works locally ' +
        '(developer login) and in production (MI), no code change.',
    },
    {
      heading: 'Storage: SAS URLs minted server-side, never long-lived keys to the browser.',
      body:
        'allowSharedKeyAccess=false on the storage account permanently disables connection strings. ' +
        'Anonymous container access is also off. The SPA downloads run artifacts by calling the ' +
        'backend\'s /declaration-runs/:id/download-links — the backend MI calls getUserDelegationKey ' +
        'and returns per-blob SAS URLs with a 5-minute TTL. The browser never sees the storage account ' +
        'key, never holds a long-lived blob credential. UUIDv7-only ID validation + path-traversal ' +
        'guard on the download routes (Layer A); operator/owner ownership filter is the next layer ' +
        '(tracker handover for Layer B exists).',
      code: '/declaration-runs/:id/download-links',
    },
    {
      heading: 'Network posture is environment-gated in bicep.',
      body:
        'Every module accepts an environmentName param. dev: public-network on (Container Apps ' +
        'Consumption can\'t use Private Endpoints) + storage defaultAction=Allow + Postgres ' +
        'AllowAllAzure firewall rule + KV public network on. stg/prd flip every one of these to ' +
        'Disabled and require Private Endpoints (out of this module\'s scope — landing-zone team ' +
        'wires the PE NICs). KV purge protection forces ON for non-dev. Single param flip moves ' +
        'the entire data plane from "pragmatic dev" to "PE-only prod".',
    },
    {
      heading: 'CORS is an explicit allowlist, mirrored at APIM and backend.',
      body:
        'APIM\'s <cors> policy lists exactly the SPA origins (custom domain + SWA auto-hostname + ' +
        'localhost ports for Vite/Astro dev). The backend\'s @fastify/cors uses the same allowlist ' +
        'from CORS_ORIGINS as defence in depth. Both layers agree, so a misconfigured browser ' +
        'origin is rejected at the gateway before it ever hits the backend.',
    },
    {
      heading: 'Defence in depth: in-process rate limit + readiness gate + fail-closed setup_meta.',
      body:
        '@fastify/rate-limit (30 req/min, /health and /ready exempt) catches runaway scripts from ' +
        'otherwise-legit APIM clients. /ready stays 503 until embedder weights + setup_meta cache + ' +
        'hot prompt files are all warm — Azure withholds traffic from the new revision until it ' +
        'flips to 200, eliminating cold-start first-request tails after deploy. Evidence Gate ' +
        'thresholds are loaded from setup_meta on boot; a missing or non-numeric row makes ' +
        'loadThresholds() throw and the global error handler returns 503 (ADR-0009) — silent ' +
        'defaults are never used.',
    },
    {
      heading: 'Postgres least-privilege roles + KV-only password.',
      body:
        'Three roles: clearai_admin (DDL, used only for migrator role grants and break-glass), ' +
        'clearai_migrator (DDL on the schema, runs Drizzle migrate() at container start), ' +
        'clearai_app (no DDL, DML on application tables only — what the running server uses). ' +
        'The admin password lives only in KV (deploy.sh generates a 32-char password if one ' +
        'doesn\'t exist, never round-trips through the operator\'s shell history). When ' +
        'useRoleSeparation=true the Container App env binds DATABASE_URL to clearai_app and ' +
        'MIGRATOR_DATABASE_URL to clearai_migrator separately.',
    },
  ],
};

// ── Section C: Decision Contract ──────────────────────────
export const CONTRACT = {
  sectionLabel: 'C',
  sectionName: 'Decision Contract',
  title: 'One envelope, four closed enums — five classification endpoints + two probes',
  desc:
    "Every classification response uses the same envelope. The frontend branches on " +
    "(decision_status, decision_reason); it never has to guess what a 200 means. Every field below is " +
    "a closed enum, defined once in src/types/domain.ts and mirrored on the client in " +
    "clearai-frontend/src/lib/api.ts. The two platform probes (/health, /ready) are listed at the bottom " +
    "for completeness — they live outside the decision contract because Azure Container Apps and APIM " +
    "smoke tests need to reach them anonymously.",
  enums: [
    {
      name: 'decision_status',
      values: [
        { v: 'accepted',             desc: '`result` (or `before/after`) is present and is the answer.' },
        { v: 'needs_clarification',  desc: 'Retrieval was too weak / too ambiguous, or the LLM tripped a guard. The user must refine input.' },
        { v: 'degraded',             desc: 'An operational dependency (LLM, DB) is unavailable. Caller should retry; no answer is given.' },
        { v: 'best_effort',          desc: 'Picker + branch-rank could not commit to a leaf, but a 4-digit heading was emitted at confidence_band=low. Frontend MUST gate behind a verify-toggle (ADR-0011).' },
      ],
    },
    {
      name: 'decision_reason',
      values: [
        { v: 'strong_match',              desc: 'Top candidate clearly leads after the LLM pick.' },
        { v: 'single_valid_descendant',   desc: 'Expand — the parent prefix has exactly one leaf; no LLM call needed.' },
        { v: 'heading_level_match',       desc: 'Confident HS-4 family but cannot commit to a leaf without an attribute the input does not supply. Paired with confidence_band=medium.' },
        { v: 'weak_retrieval',            desc: 'Top RRF score is below MIN_SCORE for this endpoint.' },
        { v: 'ambiguous_top_candidates',  desc: 'Gap to the runner-up is below MIN_GAP and the cluster spans different headings, OR the LLM said "no fit".' },
        { v: 'invalid_prefix',            desc: 'Expand — the supplied prefix does not name a real branch.' },
        { v: 'guard_tripped',             desc: 'LLM returned a code that was not in the candidate set, or unparseable JSON.' },
        { v: 'llm_unavailable',           desc: 'LLM call timed out, hit a 5xx, or returned an empty content block.' },
        { v: 'brand_not_recognised',      desc: 'Researcher returned UNKNOWN — input is brand / SKU / jargon the system cannot resolve to a customs noun.' },
        { v: 'best_effort_heading',       desc: 'Logged with decision_status=best_effort when the fallback heading classifier produced a 2/4/6/8/10-digit prefix.' },
      ],
    },
    {
      name: 'confidence_band',
      values: [
        { v: 'high · medium · low',  desc: 'Set on broker-mapping hits (high), heading-level matches (medium), and best-effort headings (low). Left unset on the standard accepted path until calibration data lands.' },
      ],
    },
    {
      name: 'missing_attributes',
      values: [
        { v: 'material · intended_use · product_type · dimensions · composition', desc: 'Closed list. The LLM may surface what would have made it accept; anything outside this set is filtered.' },
      ],
    },
  ],
  endpoints: [
    // ── Classification endpoints (the product surface) ────────────────────
    {
      method: 'POST', path: '/classifications',
      input: '{ description: string (1–250 chars) }',
      output: 'envelope + optional `result` (12-digit code · EN/AR · retrieval_score · duty · procedures) + alternatives + interpretation block + model trace',
      llm: 'Sonnet 4.6 picker on a top-8 RRF shortlist; Haiku 4.5 cleanup pre-step; Sonnet researcher on understanding-fail; Sonnet branch-rank rerank on accept',
    },
    {
      method: 'POST', path: '/classifications/expand',
      input: '{ code: 4–10 digits, description: 1–250 chars }',
      output: 'envelope + optional `before` / `after` pair · alternatives. May short-circuit on broker-mapping hit OR single-descendant branch (no LLM call).',
      llm: 'Haiku 4.5 picker on a top-8 within-branch RRF shortlist; skipped on broker-mapping hit and on single-descendant branches',
    },
    {
      method: 'GET',  path: '/classifications/{id}',
      input: 'path param: id (UUID returned on the original classification response)',
      output: '{ event: …, feedback: […] } — full per-stage trace from classification_events plus every feedback row attached to it. 404 when id does not exist.',
      llm: 'None — pure DB read.',
    },
    {
      method: 'POST', path: '/classifications/{id}/feedback',
      input: '{ kind: confirm | reject | prefer_alternative, rejected_code?, corrected_code?, reason?, user_id? }',
      output: '{ ok: true, feedback_id }. UPSERT on (event_id, user_id) so a user gets one feedback row per event — repeated POSTs update in place.',
      llm: 'None — pure DB write.',
    },
    {
      method: 'POST', path: '/classifications/{id}/submission-description',
      input: 'path param: id of an accepted 12-digit classification. No body.',
      output: '{ description_ar, description_en, source: llm | guard_fallback }. Generated lazily so a typical accepted classification does not pay for it.',
      llm: 'Haiku 4.5 with a deterministic distinctness guard against the catalog AR text.',
    },

    // ── Platform probes (Container Apps · APIM smoke tests) ───────────────
    {
      method: 'GET',  path: '/health',
      input: 'No body. Anonymous — exempt from the APIM origin lock and from the per-IP rate limiter.',
      output: '{ status: "ok" | "degraded", db: boolean }. 200 as long as the Node process is alive AND `SELECT 1` returns from the pg pool.',
      llm: 'None — liveness probe; never blocks on warmup.',
    },
    {
      method: 'GET',  path: '/ready',
      input: 'No body. Anonymous — exempt from the APIM origin lock and from the per-IP rate limiter.',
      output: '503 `{ status: "warming" }` with `Retry-After: 5` until the embedder ONNX warmup, setup_meta cache, and prompt-file cache all settle. Then 200 `{ status: "ready" }`.',
      llm: 'None — readiness probe. While 503, Container Apps holds traffic on the previous revision so the first request after a deploy never hits a cold replica.',
    },
  ],
};

// ── Section D: End-to-End Flow ────────────────────────────
export const FLOW = {
  sectionLabel: 'D',
  sectionName: 'End-to-end Flow',
  title: 'Where every request goes, in the exact order it goes there',
  desc:
    "Both endpoints share a prelude (origin lock → validate → language tag → threshold load). The " +
    "describe path then runs cleanup → retrieve → understanding → researcher → gate → picker → branch-rank " +
    "→ best-effort fallback → enrichment → log. The expand path can short-circuit on a broker-mapping hit " +
    "or a single-descendant branch before any LLM runs.",
  shared: [
    { step: '01', name: 'Origin lock',          where: 'src/server/app.ts onRequest hook',              detail: 'Reject any non-/health, non-/ready request that does not carry x-apim-shared-secret in production. Bypassed in development.' },
    { step: '02', name: 'Body validation',      where: 'src/routes/schemas.ts (Zod)',                    detail: 'classifyBody: { description: 1–250 chars }. expandBody: { code: ^\\d{4,10}$, description: 1–250 chars }. Bad shape → 400.' },
    { step: '03', name: 'Language detection',   where: 'src/util/lang.ts',                               detail: 'Cheap Arabic-vs-Latin char counter; logged on classification_events.language_detected (en | ar | mixed | unk).' },
    { step: '04', name: 'Threshold load',       where: 'src/catalog/setup-meta.ts',                      detail: 'Loads ~30 numeric tunables (gate floors, top-K sizes, feature flags) from setup_meta. Fail-closed if any required row is missing, non-numeric, or has the wrong value_kind (ADR-0009). Cached for the process lifetime.' },
  ],
  describe: {
    title: 'POST /classifications — free-text → 12-digit code',
    intro:
      'Stateless v2 control flow (ADR-0011). Worst case: 4 LLM calls (cleanup + research + picker + ' +
      'branch-rank). Common path: 1 (picker only). Every stage either short-circuits or hands a tighter ' +
      'problem to the next.',
    steps: [
      { step: '05', name: 'Stage 0 — Merchant cleanup',     where: 'src/classification/stages/cleanup-stage.ts',     detail: 'looksClean() short-circuits ≤80% of inputs unchanged. Otherwise Haiku 4.5 strips brand/SKU/marketing noise and tags the input as product / merchant_shorthand / ungrounded. Cleanup output drives the noun-alignment check below.' },
      { step: '06', name: 'Digit normalisation',            where: 'src/retrieval/digit-normalize.ts',               detail: 'Detects digit runs in the cleaned text against the known-prefix sets. 10/8/6/4-digit matches surface a soft +0.05 RRF bias for retrieval rows that begin with that prefix.' },
      { step: '07', name: 'Query Vectorization (embed)',    where: 'src/embeddings/embedder.ts',                     detail: 'multilingual-e5-small via @xenova/transformers (in-process ONNX, 384-dim). Pipeline init promise is cached and warmed at boot.' },
      { step: '08', name: 'Hybrid retrieval (3 arms + RRF)', where: 'src/retrieval/retrieve.ts',                     detail: 'Arm A cosine via embedding<=>$1::vector. Arm B GREATEST(ts_rank_cd(tsv_en, …), ts_rank_cd(tsv_ar, …)). Arm C GREATEST(similarity(description_en, $1), similarity(description_ar, $1)). Each arm fetches 50; rrf_score += 1/(RRF_K + rank); +0.05 prefix-bias uplift; normalise so top1=1.0; return RETRIEVAL_TOP_K_describe rows.' },
      { step: '09', name: 'Stage 2 — Understanding check',  where: 'src/preprocess/check-understanding.ts',          detail: 'Composite signal (ADR-0020): chapter coherence (top-N within UNDERSTOOD_MAX_DISTINCT_CHAPTERS) AND noun-family alignment (the cleanup customs noun appears in at least one top-N description). Strong → continue. Weak/scattered → researcher.' },
      { step: '10', name: 'Stage 2b — Researcher (Sonnet)', where: 'src/preprocess/research.ts',                     detail: 'Sonnet rewrites the original input from world knowledge ("Loewe Puzzle bag" → "leather handbag"). On UNKNOWN with RESEARCH_WEB_ENABLED, escalates to one Anthropic-hosted web_search call (research-with-web.ts). Recognised → re-retrieve on the canonical phrase. Unknown → emit needs_clarification + brand_not_recognised.' },
      { step: '11', name: 'Stage 2c — Heading-padded inject', where: 'src/routes/classify.ts',                       detail: 'Defence-in-depth (ADR-0020): only when understanding strength is "strong" AND the heading row text mentions the customs noun, append the HS-4 heading row as a tied candidate. Either gate fails → skip injection.' },
      { step: '12', name: 'Stage 3 — Evidence Gate',        where: 'src/classification/evidence-gate.ts',            detail: 'PASS only if top.rrf_score ≥ MIN_SCORE_describe AND (top − second) ≥ MIN_GAP_describe. Same-heading escape hatch lets the picker disambiguate within a single family. Thin-input (1 token) cross-chapter spread (≥3 chapters in top-5) → ambiguous_top_candidates.' },
      { step: '13', name: 'Stage 4 — LLM picker (Sonnet)',  where: 'src/classification/llm-pick.ts',                 detail: 'System = GIR-distilled prompt + picker-describe.md. User = effective description + top PICKER_CANDIDATES_describe candidates. Temp 0. Returns { chosen_code, rationale, missing_attributes }. Hallucination guard rejects any code outside the candidate set.' },
      { step: '14', name: 'Stage 4b — Branch-rank rerank',  where: 'src/classification/branch-rank.ts',              detail: 'On accepted picks (and when BRANCH_RANK_ENABLED + retrieval is not "confidently picked"), enumerate every leaf in the chosen HS-8 (or HS-6 widened) branch and let Sonnet rerank with per-row fits/partial/excludes reasoning. May override the picker; the override is logged for offline review.' },
      { step: '15', name: 'Stage 5 — Best-effort fallback', where: 'src/classification/stages/best-effort-stage.ts', detail: 'If picker + branch-rank produced no accepted leaf AND BEST_EFFORT_ENABLED, Haiku emits a 2/4/6/8/10-digit heading at confidence_band=low. Status flips to best_effort; reason becomes best_effort_heading. Frontend gates this behind a verify-toggle.' },
      { step: '16', name: 'Decision resolution',            where: 'src/classification/resolve.ts',                  detail: 'Single function maps (gate, llm, guard) → (decision_status, decision_reason). gate failed → needs_clarification + gate.reason. llm error/timeout → degraded + llm_unavailable. guard tripped → needs_clarification + guard_tripped. chosen=null → needs_clarification + ambiguous_top_candidates. Else accepted + strong_match.' },
      { step: '17', name: 'Catalog enrichment',             where: 'src/catalog/duty-info.ts · src/catalog/procedure-codes.ts', detail: 'On a 12-digit accepted code, parse duty (rate_percent vs status_en/status_ar like "Exempted") and resolve the comma-separated procedures string into enriched rows from procedure_codes (e.g. "21" → "Saudi Standards conformity certificate via SABER").' },
      { step: '18', name: 'Audit log + response',           where: 'src/observability/log-event.ts',                 detail: 'Await insert into classification_events: full request, per-stage model_calls trace, decision, scores, branch metadata, latencies, errors. The inserted UUID is returned as request_id on the response so the frontend can deep-link to /classifications/{id} and POST feedback. logEvent returns null (not throws) on DB failure → degraded mode is "no request_id on the response", not 500.' },
    ],
  },
  expand: {
    title: 'POST /classifications/expand — partial code + description → leaf code',
    intro:
      'Used when the merchant gave a 4–10 digit prefix and a description. Retrieval is restricted to ' +
      'leaves under that prefix. The route can short-circuit twice before any LLM runs: broker-mapping ' +
      'hit, then single-descendant branch.',
    steps: [
      { step: '05', name: 'Broker-mapping short-circuit',   where: 'src/classification/broker-mapping.ts',       detail: 'When BROKER_MAPPING_ENABLED, look up the merchant prefix in broker_code_mapping (hand-curated). Exact match → walk-up by trimming trailing digits down to length 6. Hit → ship the broker’s canonical 12-digit target with confidence_band=high; no retrieval, no LLM, no branch-rank.' },
      { step: '06', name: 'Branch existence check',         where: 'src/routes/expand.ts',                       detail: 'COUNT(*) FROM hs_codes WHERE is_leaf AND code LIKE $prefix%. Zero leaves → short-circuit needs_clarification + invalid_prefix (no embedding, no retrieval, no LLM).' },
      { step: '07', name: 'Query Vectorization (embed)',    where: 'src/embeddings/embedder.ts',                 detail: 'Same in-process embedder as describe — encodes the description for the cosine arm.' },
      { step: '08', name: 'Hybrid retrieval (filtered)',    where: 'src/retrieval/retrieve.ts',                  detail: 'Same three arms as describe, but every arm carries `parent10 LIKE $prefix%` so the candidate set is bounded by the supplied branch. No prefix-bias uplift — the prefix is already a hard filter. Returns top-12.' },
      { step: '09', name: 'Evidence Gate',                  where: 'src/classification/evidence-gate.ts',        detail: 'Uses MIN_SCORE_expand / MIN_GAP_expand from setup_meta — typically tighter than the describe pair because the candidate set is much smaller. Thin-input check is skipped on this path (the prefix already bounds the family).' },
      { step: '10', name: 'Single-descendant short-circuit', where: 'src/routes/expand.ts',                      detail: 'If branchSize === 1 and the gate passed, accept the only leaf with reason=single_valid_descendant. No LLM call.' },
      { step: '11', name: 'LLM picker (Haiku)',             where: 'src/classification/llm-pick.ts',             detail: 'System = GIR + picker-expand.md (within-branch picker). User adds the parent prefix as context. Same JSON shape as describe; same hallucination guard.' },
      { step: '12', name: 'Decision resolution',            where: 'src/classification/resolve.ts',              detail: 'Same resolve() with the singleValidDescendant flag where applicable. Response carries `before = { code: parentPrefix }` and `after = { code, en, ar, retrieval_score }`.' },
      { step: '13', name: 'Audit log + response',           where: 'src/observability/log-event.ts',             detail: 'Logs branchSize and broker_mapping_hit alongside the usual fields. Returns the request_id so the trace + feedback endpoints work uniformly across both routes.' },
    ],
  },
};

// ── Section E: Data Model & Retrieval Internals ───────────
export const DATA_MODEL = {
  sectionLabel: 'E',
  sectionName: 'Data Model & Retrieval',
  title: 'Six tables; the index is the table',
  desc:
    "There is no separate vector store, no separate full-text index store, no separate feedback DB. " +
    "Postgres holds the catalogue, the broker mapping, the procedure-codes lookup, the audit ledger, " +
    "the human feedback, and the tunables. Columns are computed once at ingest and every retrieval " +
    "query reads straight from hs_codes. Only 12-digit leaves are stored (HS-4 / HS-6 / HS-8 / HS-10 " +
    "are derived prefix columns indexed for fast LIKE filters; ADR-0008).",
  tables: [
    {
      name: 'hs_codes',
      kind: 'ZATCA tariff catalogue',
      cols: [
        'code (12-digit, unique, ~^\\d{12}$)',
        'description_en · description_ar',
        'duty_en · duty_ar · procedures (comma-separated reference into procedure_codes)',
        'embedding vector(384)  -- multilingual-e5-small over EN+AR concat',
        'tsv_en · tsv_ar  -- tsvector columns built by trigger',
        'chapter (2) · heading (4) · hs6 · hs8 · hs10 · parent10  -- derived, indexed',
        'is_leaf (always true post-ADR-0008) · raw_length (always 12)',
      ],
      indexes: [
        'HNSW on `embedding vector_cosine_ops` for cosine ANN',
        'GIN on tsv_en and tsv_ar for ts_rank_cd',
        'GIN on description_en and description_ar with gin_trgm_ops for similarity()',
        'btree on chapter / heading / hs6 / hs8 / hs10 / parent10 for prefix filters and single-descendant check',
      ],
    },
    {
      name: 'broker_code_mapping',
      kind: 'broker-curated overrides',
      cols: [
        'client_code_norm (PK · the merchant-supplied code, digits only)',
        'target_code (12-digit ZATCA target the broker mapped this input to)',
        'target_description_ar (broker’s canonical AR phrasing)',
        'source_row_ref (Rxxx — back-reference into Naqel_HS_code_mapping_lookup.xlsx)',
      ],
      indexes: [
        'PK on client_code_norm',
        'btree on target_code for reverse lookups',
      ],
      seeds: 'Ingested from Naqel_HS_code_mapping_lookup.xlsx via `pnpm db:seed:broker`',
    },
    {
      name: 'procedure_codes',
      kind: 'ZATCA procedures lookup',
      cols: [
        'code (PK · varchar(8) — varchar so future "23a" sub-codes don’t need a migration)',
        'description_ar (Arabic-only, sourced from دليل رموز إجراءات فسح وتصدير السلع)',
        'is_repealed (~25 codes carry "(ملغي)" in the official text)',
      ],
      indexes: [
        'partial btree on (is_repealed = false) for the hot path',
      ],
    },
    {
      name: 'classification_events',
      kind: 'append-only audit ledger',
      cols: [
        'id (uuid, gen_random_uuid()) · created_at',
        'endpoint (`describe` | `expand`) · request (jsonb — carries every per-stage observability field)',
        'language_detected (en · ar · mixed · unk)',
        'decision_status · decision_reason · confidence_band · chosen_code',
        'alternatives (jsonb)',
        'top_retrieval_score · top2_gap · candidate_count · branch_size',
        'llm_used · llm_status · llm_model · guard_tripped',
        'model_calls (jsonb — per-stage trace: cleanup, research, picker, branch_rank, …)',
        'embedder_version · total_latency_ms · error · rationale',
      ],
      indexes: [
        'btree on (created_at desc) for the operator dashboard tail',
        'btree on endpoint and decision_status for per-endpoint funnel queries',
      ],
    },
    {
      name: 'classification_feedback',
      kind: 'human supervision',
      cols: [
        'id (uuid) · created_at · updated_at',
        'event_id (FK → classification_events ON DELETE CASCADE)',
        'kind (`confirm` | `reject` | `prefer_alternative`) — CHECK enforces shape per kind',
        'rejected_code (12-digit) · corrected_code (12-digit, required for prefer_alternative)',
        'reason (≤500 chars) · user_id (null until auth lands)',
      ],
      indexes: [
        'unique (event_id, COALESCE(user_id, "")) — one row per user per event; UPSERT on conflict',
        'btree on event_id, partial indexes on rejected_code and corrected_code',
      ],
    },
    {
      name: 'setup_meta',
      kind: 'tunables · feature flags',
      cols: [
        'key (PK) · value (text mirror) · value_numeric · value_kind (`number` | `string`)',
        'description · updated_at (bumped by BEFORE UPDATE trigger)',
        'CHECK enforces value_kind=`number` ⇒ value_numeric IS NOT NULL',
      ],
      indexes: [
        'PK on key',
      ],
      seeds:
        '~30 keys including: MIN_SCORE_describe · MIN_GAP_describe · MIN_SCORE_expand · MIN_GAP_expand · RRF_K · ' +
        'RETRIEVAL_TOP_K_describe · PICKER_CANDIDATES_describe · ALTERNATIVES_SHOWN_describe · ALTERNATIVES_MIN_SHOWN · ' +
        'UNDERSTOOD_MAX_DISTINCT_CHAPTERS · UNDERSTOOD_TOP_K_describe · MIN_ALT_SCORE · STRONG_ALT_RATIO · ' +
        'BRANCH_PREFIX_LENGTH · BRANCH_MAX_LEAVES · BEST_EFFORT_MAX_DIGITS · BEST_EFFORT_MAX_TOKENS · ' +
        'and feature flags: BEST_EFFORT_ENABLED · MERCHANT_CLEANUP_ENABLED · BRANCH_RANK_ENABLED · ' +
        'SUBMISSION_DESC_ENABLED · BROKER_MAPPING_ENABLED · RESEARCH_WEB_ENABLED.',
    },
  ],
  rrf: {
    title: 'Reciprocal-Rank Fusion in two paragraphs',
    body:
      "Three independent retrieval arms each return their top-50. For every (code, arm) pair we add " +
      "1 / (RRF_K + rank_in_that_arm) to that code's fused score. Codes that show up high in multiple " +
      "arms accumulate score from each; codes that only one arm likes get penalised by ranking lower " +
      "everywhere else. RRF is rank-based, not score-based, so the three arms' incomparable score " +
      "scales (cosine in [0,1], ts_rank_cd unbounded, similarity() in [0,1]) never have to be reconciled. " +
      "After fusion we add a small additive uplift (+0.05) to any candidate whose code starts with the " +
      "soft prefix surfaced by digit-normalisation, then divide every score by the maximum so the top " +
      "candidate normalises to 1.0 — that's what the Evidence Gate measures against MIN_SCORE / MIN_GAP.",
  },
};

// ── Section F: Failure Handling ───────────────────────────
export const FAILURE = {
  sectionLabel: 'F',
  sectionName: 'Failure Handling',
  title: 'Every dependency has its own timeout and its own decision_status',
  desc:
    "Failures are not lumped into a generic 500 — each external boundary has an explicit budget and an " +
    "explicit envelope mapping, so the frontend can show the right remediation copy and operators can " +
    "search classification_events on decision_reason to find the actual failure mode.",
  rows: [
    { dep: 'PostgreSQL',                        timeout: 'pg pool default · global error handler returns 503', on_failure: '503 from the global error handler — caller retries. logEvent failures are swallowed (return null) so a logging outage degrades to "no request_id on the response", not 500.' },
    { dep: 'Anthropic / Foundry LLM',           timeout: 'LLM_TIMEOUT_MS = 15 s per call (configurable)',       on_failure: 'envelope: decision_status=degraded · decision_reason=llm_unavailable. Retrieval results are never returned as a fallback "best guess".' },
    { dep: 'Empty content block from LLM',      timeout: '—',                                                   on_failure: 'Treated as an operational failure (provider response shape error), NOT as "the user input was unclear" — same envelope as a timeout. Misclassifying it as ambiguous_top_candidates was the regression that motivated the fix.' },
    { dep: 'Embedder pipeline init',            timeout: 'warmed at boot (/ready stays 503 until done)',        on_failure: 'Cached promise is cleared on rejection so the next caller gets a fresh attempt instead of being stuck behind a stale rejected promise. Container Apps holds traffic on the previous revision while /ready is 503.' },
    { dep: 'setup_meta missing/non-numeric row', timeout: '—',                                                   on_failure: 'loadThresholds() throws with the exact missing keys → 503 via the global error handler. Refuses to operate on silent defaults (ADR-0009).' },
    { dep: 'Researcher (Sonnet)',               timeout: 'inherits LLM_TIMEOUT_MS',                             on_failure: 'kind=`failed` returned to the route — interpretation stage stays at `cleaned`/`passthrough` and the gate handles it as it would any other retrieval. No degraded escalation just because the optional researcher failed.' },
    { dep: 'Branch-rank rerank (Sonnet)',       timeout: 'inherits LLM_TIMEOUT_MS',                             on_failure: 'Picker’s pick stands. The rerank is an optional Stage 4b — its failure never blocks an accepted classification.' },
    { dep: 'Submission-description (Haiku)',    timeout: 'inherits LLM_TIMEOUT_MS · runs only on user demand', on_failure: '500 generation_failed — frontend can re-POST. Distinctness guard fallback (`guard_fallback`) covers the case where Haiku returns text identical to the catalog AR.' },
    { dep: 'Broker-mapping fast path',          timeout: '~5 ms p95 SQL · zero LLM',                            on_failure: 'No "failure" mode worth modelling — a missed lookup just falls through to the standard expand pipeline.' },
  ],
};

// ── Section G: Frontend ───────────────────────────────────
export const FRONTEND = {
  sectionLabel: 'G',
  sectionName: 'Frontend',
  title: 'Astro + a single React island, deployed on Azure Static Web Apps',
  desc:
    "The customer-facing UI is intentionally small: an Astro site that hydrates one React island " +
    "(ClassifyApp) on the index page. The bundle is tiny because nothing on the marketing surfaces " +
    "ships JS; the API client is the single source of truth for the decision contract on the browser side. " +
    "Production is Azure SWA; the original Cloudflare Pages deployment is kept alive as a rollback target.",
  stack: [
    { layer: 'Framework',  choice: 'Astro 6 + React 19 island',                     why: 'Static-by-default; ship JS only where it is needed (the workbench).' },
    { layer: 'Styling',    choice: 'Tailwind CSS 4 via @tailwindcss/vite',          why: 'No PostCSS toolchain, no config bloat.' },
    { layer: 'Runtime',    choice: 'Node ≥ 22.12 (build) · static at runtime',     why: 'No SSR — the deployed site is plain HTML + JS + CSS on Cloudflare.' },
    { layer: 'API client', choice: 'src/lib/api.ts — typed wrapper over the five endpoints (POST /classifications · POST /classifications/expand · GET /classifications/{id} · POST /classifications/{id}/feedback · POST /classifications/{id}/submission-description)', why: 'DecisionStatus / DecisionReason / MissingAttribute mirror clearai-backend/src/types/domain.ts exactly so a `grep` across both repos finds matches.' },
    { layer: 'Components', choice: 'ClassifyApp · InputCard · HSResultCard · AlternativesCard · MetaPanel · Pipeline · Suggestions · ModeTabs · TracePanel · FeedbackButtons', why: 'Each component renders one slice of the decision envelope; no component owns the network call. TracePanel + FeedbackButtons consume the trace and feedback endpoints.' },
  ],
  deployment: [
    { item: 'Host',                  detail: 'Azure Static Web Apps (primary) — static HTML + JS + CSS shipped from the Astro `dist/`. Cloudflare Pages (clearai-frontend.pages.dev) kept alive as a rollback target.' },
    { item: 'Backend wiring',        detail: 'PUBLIC_CLEARAI_API_BASE points the client at the Azure APIM gateway (NOT the Container App FQDN — that origin is locked behind the shared-secret hook).' },
    { item: 'Auth header',           detail: 'PUBLIC_CLEARAI_API_KEY is sent as Ocp-Apim-Subscription-Key on every request. Visible in the bundle by design (per-key APIM rate limit + CORS scoping make it bounded). Move behind a SWA / Pages Function for proper key-hiding in v1.5.' },
    { item: 'CORS',                  detail: 'Backend allowlists the SWA + Cloudflare origins via CORS_ORIGINS; preflight + the actual POST go through the same allowlist. `x-apim-shared-secret` and `ocp-apim-subscription-key` are in allowedHeaders.' },
    { item: 'Dev parity',            detail: 'Astro dev on :5173, Fastify dev on :3000 — Vite picks :5174/:5175 if 5173 is busy (all four ports are in CORS_ORIGINS). Only API_BASE changes between dev and prod.' },
  ],
};

// ── V2 — high level only ──────────────────────────────────
export const V2 = {
  title: 'V2 — what would change, in one screen',
  desc:
    "V1 is a single tenant, single region, single LLM provider. The three items below are the named " +
    "structural changes V2 would force; the tracker underneath holds the rest of the planned work that " +
    "doesn't rise to a structural change but is still in the pipeline.",
  plannedItems: [
    'Multi-tenant data isolation — tenant_id on every row, per-tenant API keys at APIM, per-tenant overrides in setup_meta.',
    'Postgres → managed pgvector with replicas + Private Endpoint; drop public-IP firewall once VNet integration lands.',
    'Confidence-band calibration pipeline — feed classification_events back through an offline scorer, write thresholds back into setup_meta on a cadence.',
  ],
  trackerTitle: 'Planned tracker',
  trackerItems: [
    'Decision-ledger arm in retrieval — fourth RRF arm built from naqel_hs_decision_ledger, weighted by recency + verifier agreement.',
    'Background re-embedding job — when EMBEDDER_MODEL changes, re-embed in batches without a downtime window.',
    'Per-region LLM endpoints (Foundry residency) instead of one global baseURL.',
    'Move APIM key out of the browser — Cloudflare Pages Function as a server-side passthrough.',
    'Observability — Application Insights / OpenTelemetry on the Container App, with classification_events mirrored as an analytical view.',
  ],
};

// ── Navigation ────────────────────────────────────────────
export const NAV = {
  prev: { to: '/process',   label: 'Current Naqel Process' },
  next: { to: '/reference', label: 'Reference Material' },
};
