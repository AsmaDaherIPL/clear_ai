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
      stack: 'Node 20 · TypeScript · Fastify',
      body: 'Exposes the endpoints: description-to-code, partial-code expansion, and pre-submission validation. Handles input validation, the APIM origin lock, and rate limiting.',
    },
    {
      key: 'pg',
      tag: 'PostgreSQL — system of record',
      stack: 'PostgreSQL 16 · pgvector · pg_trgm · tsvector',
      body: 'Stores HS master data, prior decisions, and audit events — and runs vector, keyword, and fuzzy retrieval. Search and source-of-truth live in one platform.',
    },
    {
      key: 'embed',
      tag: 'Embedding layer',
      stack: 'multilingual-e5-small · 384-dim · in-process ONNX',
      body: 'Converts product descriptions into multilingual vectors so the system can retrieve semantically similar HS codes in English or Arabic.',
    },
    {
      key: 'llm',
      tag: 'LLM decision layer',
      stack: 'Anthropic via Foundry · Sonnet (broad) · Haiku (narrow)',
      body: 'Once retrieval has reduced the problem to a small candidate set, the LLM picks the best code and explains the choice. Stronger model on the broadest path; cheaper model on narrow within-branch picks.',
    },
    {
      key: 'audit',
      tag: 'Audit & controls',
      stack: 'classification_events · setup_meta · structured logs',
      body: 'Every request captures input, candidate evidence, model usage, latency, and outcome — enabling review, tuning, and compliance-grade traceability.',
    },
  ],

  // ── Request flow — the named steps
  flowTitle: 'How a request works',
  flowIntro:
    'Every request follows the same operating pattern. The LLM never rescues weak retrieval — when evidence is weak or ambiguous, the service returns a structured needs_clarification outcome instead of forcing an answer. That is a deliberate quality control mechanism, not a failure mode.',
  flow: [
    { n: '01', name: 'Validate input',          icon: '◉', body: 'Schema-checked request body. Bad shape → 400, no further work happens.' },
    { n: '02', name: 'Query Vectorization (embed)', icon: '∿', body: 'Free-text or description is embedded into a 384-dim multilingual vector — in-process, no external model service.' },
    { n: '03', name: 'Hybrid retrieval',        icon: '⌖', body: 'Three arms over Postgres: semantic similarity (pgvector cosine), keyword search (tsvector BM25), and typo-tolerant matching (pg_trgm).' },
    { n: '04', name: 'Hierarchical Walk',       icon: '⌥', body: 'For partial-code requests, retrieval is constrained to one branch of the HS tree — chapter → heading → subheading → leaf — so the candidate set respects HS hierarchy.' },
    { n: '05', name: 'Evidence Gate',           icon: '▣', body: 'Measures whether the top candidate is strong enough and far enough ahead of the runner-up. Below threshold → abstain. The LLM is never called on weak retrieval.' },
    { n: '06', name: 'LLM pick',                icon: '◆', body: 'The LLM chooses from the shortlist only and returns a rationale. Sonnet for the broad path, Haiku for narrow within-branch picks.' },
    { n: '07', name: 'Guard + log',             icon: '✓', body: 'Reject any code outside the candidate set (no hallucinated codes). Return the structured envelope and write a full audit row.' },
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
    { layer: 'Embeddings',     choice: '@xenova/transformers · Xenova/multilingual-e5-small (384-dim)', why: 'In-process ONNX, multilingual (EN + AR + CN), no GPU, no extra service. E5 query/passage prefix convention used.' },
    { layer: 'LLM',            choice: '@anthropic-ai/sdk → Foundry baseURL (Sonnet for /describe, Haiku for /expand)', why: 'Sonnet handles broad picking from a wide candidate set; Haiku handles narrow within-branch picking.' },
    { layer: 'Logging',        choice: 'pino + pino-pretty (dev only)',                     why: 'Structured logs in prod, human-readable in dev.' },
    { layer: 'Tooling',        choice: 'pnpm workspace · vitest · tsx · tsc',               why: 'Same scripts run locally and in CI.' },
    { layer: 'Container',      choice: 'Multi-stage Docker on distroless/nodejs20',          why: 'Small attack surface; pnpm install --prod in the runtime stage.' },
    { layer: 'IaC',            choice: 'Bicep (Postgres / Key Vault / Container Apps Env / Container App)', why: 'One `./deploy.sh` is idempotent and reproducible.' },
    { layer: 'CI/CD',          choice: 'GitHub Actions OIDC → GHCR → Container App revision', why: 'No long-lived cloud creds; image promoted by digest, not tag.' },
  ],
};

// ── Section B: Azure Deployment ────────────────────────────
export const DEPLOYMENT = {
  sectionLabel: 'B',
  sectionName: 'V1 Deployment',
  title: 'APIM in front, Container App scale-to-zero, Postgres B1ms always-on',
  desc:
    "Total dev cost is roughly $20–25/month — the Postgres B1ms is the only always-on line item " +
    "(~$13–15/mo); the Container App Consumption tier scales to zero between requests; Key Vault " +
    "Standard is effectively free at this volume. APIM Consumption fronts the Container App with a " +
    "per-key rate-limit policy and injects a shared secret on every forwarded request — the backend " +
    "rejects any request that arrives without that exact header, so the Container App's public FQDN " +
    "is unreachable in practice.",
  resources: [
    { name: 'Postgres Flexible Server (B1ms, PG 16, 32 GB, public + SSL)',         note: 'Extensions: vector / pg_trgm / unaccent / pgcrypto' },
    { name: 'Database `clearai`',                                                 note: '4 tables: hs_codes / naqel_hs_decision_ledger / classification_events / setup_meta' },
    { name: 'Key Vault (Standard, RBAC, soft-delete)',                            note: 'postgres-password · postgres-conn-string · anthropic-api-key' },
    { name: 'Container Apps Environment (Consumption, no Log Analytics)',          note: 'Per-revision scale-to-zero' },
    { name: 'Container App `ca-infp-clearai-be-dev-gwc-01` (1 vCPU / 2 GiB)',      note: 'System-assigned MI; secretref to KV; min=0 / max=2' },
    { name: 'API Management (Consumption tier)',                                   note: 'Per-key rate limit · injects x-apim-shared-secret on forward' },
  ],
  posture: [
    {
      heading: 'APIM origin lock — fail closed.',
      body:
        'The Fastify onRequest hook rejects every non-/health request that does not carry the exact ' +
        'shared secret APIM injects. In production with the secret unset the hook returns 401 on ' +
        'everything (loud signal that the wire-up is broken, never silently allows traffic). In ' +
        'development the hook is bypassed entirely so `pnpm dev` does not need a fake APIM key.',
      code: 'x-apim-shared-secret',
    },
    {
      heading: 'CORS is an explicit allowlist, not "*".',
      body:
        'Browsers refuse `*` once credentials are added later, so the allowlist is read from ' +
        'CORS_ORIGINS (comma-separated) and the matched origin is reflected back. Local dev ' +
        'defaults cover :5173 (Vite) and :4321 (Astro alt port).',
    },
    {
      heading: 'In-process per-IP rate limit alongside APIM.',
      body:
        '@fastify/rate-limit (default 30 req/min) is defence-in-depth so that a runaway script from ' +
        'an otherwise-legitimate APIM-fronted client still gets throttled per-IP. /health is exempt — ' +
        'platform probes must never see a 429.',
    },
    {
      heading: '/health stays cheap and side-effect-free.',
      body:
        'Returns `{ status, db }` from a `SELECT 1` against the pool. Container Apps and APIM probes ' +
        'hit it constantly; anything heavier here would push the replica into CPU-throttle and start ' +
        'churning revisions.',
    },
    {
      heading: 'setup_meta is fail-closed.',
      body:
        'The Evidence Gate refuses to operate on silent defaults. A missing or non-numeric row in ' +
        'setup_meta makes loadThresholds() throw — the global error handler turns that into a clean ' +
        '503 instead of letting a stale threshold quietly approve a bad code (ADR-0009).',
    },
  ],
};

// ── Section C: Decision Contract ──────────────────────────
export const CONTRACT = {
  sectionLabel: 'C',
  sectionName: 'Decision Contract',
  title: 'One envelope, three closed enums — the same shape across every endpoint',
  desc:
    "Every response — accepted or not, /describe or /expand — uses the same envelope. The frontend " +
    "branches on (decision_status, decision_reason); it never has to guess what a 200 means. Every " +
    "field below is a closed enum, defined once in src/decision/types.ts and mirrored on the client " +
    "in clearai-frontend/src/lib/api.ts.",
  enums: [
    {
      name: 'decision_status',
      values: [
        { v: 'accepted',             desc: '`result` (or `before/after`) is present and is the answer.' },
        { v: 'needs_clarification',  desc: 'Retrieval was too weak / too ambiguous, or the LLM tripped a guard. The user must refine input.' },
        { v: 'degraded',             desc: 'An operational dependency (LLM, DB) is unavailable. Caller should retry; no answer is given.' },
      ],
    },
    {
      name: 'decision_reason',
      values: [
        { v: 'strong_match',              desc: 'Top candidate clearly leads after the LLM pick.' },
        { v: 'single_valid_descendant',   desc: '/expand — the parent prefix has exactly one leaf; no LLM call needed.' },
        { v: 'weak_retrieval',            desc: 'Top RRF score is below MIN_SCORE for this endpoint.' },
        { v: 'ambiguous_top_candidates',  desc: 'Gap to the runner-up is below MIN_GAP, OR the LLM said "no fit".' },
        { v: 'invalid_prefix',            desc: '/expand — the supplied prefix does not name a real branch.' },
        { v: 'guard_tripped',             desc: 'LLM returned a code that was not in the candidate set, or unparseable JSON.' },
        { v: 'llm_unavailable',           desc: 'LLM call timed out, hit a 5xx, or returned an empty content block.' },
      ],
    },
    {
      name: 'confidence_band',
      values: [
        { v: 'high · medium · low',  desc: 'Optional. Calibrated post-launch from eval data; v1 leaves it unset on most paths.' },
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
    {
      method: 'POST', path: '/classify/describe',
      input: '{ description: string (1–2000 chars) }',
      output: 'envelope + optional `result` (12-digit code + EN/AR description + retrieval_score)',
      llm: 'Sonnet (LLM_MODEL_STRONG) — broad picking from up to 8 candidates',
    },
    {
      method: 'POST', path: '/classify/expand',
      input: '{ code: 4|6|8|10 digits, description: 1–2000 chars }',
      output: 'envelope + optional `before` / `after` pair (the prefix → the chosen leaf under it)',
      llm: 'Haiku (LLM_MODEL) — narrow within-branch picking; skipped when the branch has a single leaf',
    },
  ],
};

// ── Section D: End-to-End Flow ────────────────────────────
export const FLOW = {
  sectionLabel: 'D',
  sectionName: 'End-to-end Flow',
  title: 'Where every request goes, in the exact order it goes there',
  desc:
    "Both endpoints share the same skeleton: validate → normalise → retrieve → measure evidence " +
    "→ gate → (LLM if gate passes) → guard → resolve. The differences below are which steps are " +
    "skipped per endpoint, and which model tier the LLM step uses.",
  shared: [
    { step: '01', name: 'Origin lock',          where: 'src/server.ts onRequest hook',                 detail: 'Reject any non-/health request that does not carry x-apim-shared-secret in production. Bypassed in development.' },
    { step: '02', name: 'Body validation',      where: 'src/routes/schemas.ts (Zod)',                   detail: '400 on bad shape — no further work happens. /expand pattern is anchored: ^(?:\\d{4}|\\d{6}|\\d{8}|\\d{10})$ (the un-anchored alternation in an earlier draft let `12345` and `abc123456def` through).' },
    { step: '03', name: 'Language detection',   where: 'src/util/lang.ts',                              detail: 'Cheap Arabic-vs-Latin char counter; logged on classification_events.language_detected (en | ar | mixed | unk).' },
    { step: '04', name: 'Threshold load',        where: 'src/decision/setup-meta.ts',                   detail: 'MIN_SCORE_describe / MIN_GAP_describe / MIN_SCORE_expand / MIN_GAP_expand / RRF_K read from the setup_meta table. Fail-closed if any row is missing or non-numeric (ADR-0009).' },
  ],
  describe: {
    title: 'POST /classify/describe — free-text → 12-digit code',
    intro:
      'Used when the merchant gave a description but no usable code. Sonnet picks across the full ' +
      'candidate space; the gate prevents the LLM from ever rescuing a weak retrieval.',
    steps: [
      { step: '05', name: 'Digit normalisation',     where: 'src/retrieval/digit-normalize.ts', detail: 'Free-text often carries digit runs ("shirt 89123"). Per-length rule: <4 keep as text noise, 4–11 → check 10/8/6/4-digit prefixes against the known-prefix sets and apply a soft +0.05 RRF bias on matches; 12 deferred for v1; >12 noise.' },
      { step: '06', name: 'Query embedding',         where: 'src/embeddings/embedder.ts',       detail: 'multilingual-e5-small via @xenova/transformers, in-process ONNX. Pipeline init promise is cached to serialise concurrent first-callers — no duplicate model downloads.' },
      { step: '07', name: 'Hybrid retrieval (3 arms)', where: 'src/retrieval/retrieve.ts',      detail: 'Arm A: cosine via `embedding <=> $1::vector`. Arm B: GREATEST(ts_rank_cd(tsv_en, plainto_tsquery(\'english\', $1)), ts_rank_cd(tsv_ar, plainto_tsquery(\'simple\', $1))). Arm C: GREATEST(similarity(description_en, $1), similarity(description_ar, $1)). Each arm pulls 50 rows; leaves only.' },
      { step: '08', name: 'RRF fusion',              where: 'src/retrieval/retrieve.ts',        detail: 'For each arm: rrf_score += 1 / (RRF_K + rank). Apply a small additive prefix-bias uplift if digit-normalisation surfaced one. Normalise so top1 = 1.0. Return topK = 12.' },
      { step: '09', name: 'Evidence Gate',           where: 'src/decision/evidence-gate.ts',    detail: 'PASS only if top.rrf_score ≥ MIN_SCORE_describe AND (top.rrf_score − second.rrf_score) ≥ MIN_GAP_describe. Otherwise FAIL with reason ∈ {weak_retrieval, ambiguous_top_candidates, invalid_prefix} and the LLM is never called.' },
      { step: '10', name: 'LLM pick (Sonnet)',       where: 'src/decision/llm-pick.ts',         detail: 'System = GIR-distilled prompt (~400 tok) + picker-describe.md. User = description + top-8 candidates as `code / en / ar`. Temperature = 0, max_tokens = 512. Returns { chosen_code, rationale, missing_attributes }.' },
      { step: '11', name: 'Hallucination guard',     where: 'src/decision/llm-pick.ts',         detail: 'If chosen_code (12 digits) is not in the candidate list, set guardTripped=true and drop the code. JSON parse failure → also guardTripped. The LLM cannot invent codes — it can only choose or abstain.' },
      { step: '12', name: 'Decision resolution',     where: 'src/decision/resolve.ts',          detail: 'Single function maps (gate, llm) → (decision_status, decision_reason). gate failed → needs_clarification + gate.reason. llm error/timeout/empty → degraded + llm_unavailable. guard tripped → needs_clarification + guard_tripped. chosen=null → needs_clarification + ambiguous_top_candidates. else → accepted + strong_match.' },
      { step: '13', name: 'Audit logging',           where: 'src/decision/log-event.ts',        detail: 'Async insert into classification_events: full request, language, decision, top_retrieval_score, top2_gap, candidate_count, branch_size, llm_used/status/model, guard_tripped, model_calls[], embedder_version, total_latency_ms. Fire-and-forget; the response never waits for it.' },
    ],
  },
  expand: {
    title: 'POST /classify/expand — partial code + description → leaf code',
    intro:
      'Used when the merchant gave a 4/6/8/10-digit prefix and a description. Retrieval is restricted ' +
      'to leaves under that prefix. Haiku is the right tier here: the picking is narrow because the ' +
      'candidate set is already filtered.',
    steps: [
      { step: '05', name: 'Branch existence check', where: 'src/routes/expand.ts',             detail: 'COUNT(*) FROM hs_codes WHERE is_leaf AND code LIKE $1. Zero leaves → short-circuit needs_clarification + invalid_prefix (no embedding, no retrieval, no LLM).' },
      { step: '06', name: 'Hybrid retrieval (filtered)', where: 'src/retrieval/retrieve.ts',   detail: 'Same three arms as /describe, but every arm carries `parent10 LIKE $prefix%` so the candidate set is bounded by the supplied branch.' },
      { step: '07', name: 'RRF fusion',              where: 'src/retrieval/retrieve.ts',        detail: 'Identical to /describe. No prefix-bias uplift on this path — the prefix is already a hard filter.' },
      { step: '08', name: 'Evidence Gate',           where: 'src/decision/evidence-gate.ts',    detail: 'Uses MIN_SCORE_expand / MIN_GAP_expand from setup_meta — typically tighter than the /describe pair because the candidate set is much smaller.' },
      { step: '09', name: 'Single-descendant short-circuit', where: 'src/routes/expand.ts',     detail: 'If branchSize === 1 and the gate passed, accept the only leaf with reason=single_valid_descendant. No LLM call.' },
      { step: '10', name: 'LLM pick (Haiku)',        where: 'src/decision/llm-pick.ts',         detail: 'System = GIR + picker-expand.md (the within-branch picker). User adds the parent prefix as context. Same JSON shape as /describe.' },
      { step: '11', name: 'Hallucination guard',     where: 'src/decision/llm-pick.ts',         detail: 'Identical to /describe.' },
      { step: '12', name: 'Decision resolution',     where: 'src/decision/resolve.ts',          detail: 'Same resolve() with `singleValidDescendant` flag where applicable. Response carries `before = { code: parentPrefix }` and `after = { code, en, ar, retrieval_score }`.' },
      { step: '13', name: 'Audit logging',           where: 'src/decision/log-event.ts',        detail: 'Logs branchSize alongside the usual fields — it is the per-endpoint signal for "how narrow was this pick".' },
    ],
  },
};

// ── Section E: Data Model & Retrieval Internals ───────────
export const DATA_MODEL = {
  sectionLabel: 'E',
  sectionName: 'Data Model & Retrieval',
  title: 'Four tables; the index is the table',
  desc:
    "There is no separate vector store, no separate full-text index store, no separate ledger DB. " +
    "Postgres holds everything, the columns are computed once at ingest, and every retrieval query " +
    "reads straight from hs_codes. HS4 rows were dropped at ingest (ADR — too coarse to be useful as " +
    "leaves; only 6/8/10/12-digit branches and leaves are kept).",
  tables: [
    {
      name: 'hs_codes',
      kind: 'authoritative',
      cols: [
        'code (12-digit PK)',
        'description_en · description_ar',
        'is_leaf',
        'embedding vector(384)  -- multilingual-e5-small, L2-normalised',
        'tsv_en · tsv_ar  -- generated tsvector columns (BM25)',
        'chapter (2) · heading (4) · hs6 · hs8 · hs10 · parent10  -- generated, indexed',
      ],
      indexes: [
        'HNSW on `embedding vector_cosine_ops` for cosine ANN',
        'GIN on tsv_en and tsv_ar for ts_rank_cd',
        'GIN on description_en and description_ar with gin_trgm_ops for similarity()',
        'btree on parent10, hs6, hs8, hs10 for the prefix filters / single-descendant check',
      ],
    },
    {
      name: 'naqel_hs_decision_ledger',
      kind: 'historical evidence',
      cols: [
        'declared_code · resolved_code',
        'context fields (origin, weight band, etc.)',
        'occurred_at · source_batch',
      ],
      indexes: [
        'btree on declared_code for the ledger lookup arm (planned for v1.1, not active in v1)',
      ],
    },
    {
      name: 'classification_events',
      kind: 'audit ledger',
      cols: [
        'id (uuid, gen_random_uuid()) · created_at',
        'endpoint · request (jsonb)',
        'language_detected · digit_normalisation (jsonb) · prefix_bias',
        'decision_status · decision_reason · confidence_band · chosen_code',
        'alternatives (jsonb)',
        'top_retrieval_score · top2_gap · candidate_count · branch_size',
        'llm_used · llm_status · llm_model · guard_tripped',
        'model_calls (jsonb) · embedder_version',
        'total_latency_ms · error',
      ],
      indexes: [
        'btree on (created_at desc) for the operator dashboard tail',
        'btree on (endpoint, decision_status) for the per-endpoint funnel queries',
      ],
    },
    {
      name: 'setup_meta',
      kind: 'tunables',
      cols: [
        'key (PK) · value_kind (\'number\' | \'json\' | \'string\') · value_numeric · value_json · value_text',
        'CHECK (value_kind != \'number\' OR value_numeric IS NOT NULL)',
      ],
      indexes: [
        'PK on key',
      ],
      seeds: 'MIN_SCORE_describe · MIN_GAP_describe · MIN_SCORE_expand · MIN_GAP_expand · RRF_K',
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
    { dep: 'PostgreSQL',                        timeout: '5 s statement timeout',  on_failure: '503 from the global error handler — caller retries.' },
    { dep: 'Anthropic / Foundry LLM',           timeout: '15 s + 2 retries on 429/5xx/timeout (250 ms, 1 s backoff)', on_failure: 'envelope: decision_status=degraded · decision_reason=llm_unavailable. The retrieval result is never returned as a fallback "best guess".' },
    { dep: 'Empty content block from LLM',      timeout: '—',                       on_failure: 'Treated as an operational failure (provider response shape error), NOT as "the user input was unclear" — same envelope as a timeout. Fixed in llm-pick.ts because the earlier behaviour was misclassifying it as ambiguous_top_candidates and giving the wrong remediation hint.' },
    { dep: 'Embedder pipeline init',            timeout: '—',                       on_failure: 'Cached promise is cleared on rejection so the next caller gets a fresh attempt instead of being stuck behind a stale rejected promise.' },
    { dep: 'setup_meta missing/non-numeric row', timeout: '—',                      on_failure: 'loadThresholds() throws with the exact missing keys → 503 via the global error handler. Refuses to operate on silent defaults (ADR-0009).' },
    { dep: 'Total request budget',              timeout: '20 s ceiling, 18 s soft trip', on_failure: 'envelope: decision_status=degraded · decision_reason=llm_unavailable, with the partial trace logged.' },
  ],
};

// ── Section G: Frontend ───────────────────────────────────
export const FRONTEND = {
  sectionLabel: 'G',
  sectionName: 'Frontend',
  title: 'Astro + a single React island, deployed on Cloudflare Pages',
  desc:
    "The customer-facing UI is intentionally small: an Astro site that hydrates one React island " +
    "(ClassifyApp) on the index page. The bundle is tiny because nothing on the marketing surfaces " +
    "ships JS; the API client is the single source of truth for the decision contract on the browser side.",
  stack: [
    { layer: 'Framework',  choice: 'Astro 6 + React 19 island',                     why: 'Static-by-default; ship JS only where it is needed (the workbench).' },
    { layer: 'Styling',    choice: 'Tailwind CSS 4 via @tailwindcss/vite',          why: 'No PostCSS toolchain, no config bloat.' },
    { layer: 'Runtime',    choice: 'Node ≥ 22.12 (build) · static at runtime',     why: 'No SSR — the deployed site is plain HTML + JS + CSS on Cloudflare.' },
    { layer: 'API client', choice: 'src/lib/api.ts — typed wrapper over the three endpoints', why: 'DecisionStatus / DecisionReason / MissingAttribute mirror clearai-backend/src/decision/types.ts exactly so a `grep` across both repos finds matches.' },
    { layer: 'Components', choice: 'ClassifyApp · InputCard · HSResultCard · AlternativesCard · MetaPanel · Pipeline · Suggestions · ModeTabs', why: 'Each component renders one slice of the decision envelope; no component owns the network call.' },
  ],
  deployment: [
    { item: 'Host',                  detail: 'Cloudflare Pages (clearai-frontend.pages.dev). Static HTML + JS + CSS shipped from the Astro `dist/`.' },
    { item: 'Backend wiring',        detail: 'PUBLIC_CLEARAI_API_BASE points the client at the Azure APIM gateway (NOT the Container App FQDN — that origin is locked).' },
    { item: 'Auth header',           detail: 'PUBLIC_CLEARAI_API_KEY is sent as Ocp-Apim-Subscription-Key on every request. Visible in the bundle by design (per-key APIM rate limit + CORS scoping make it bounded). Move behind a Pages Function in v1.5.' },
    { item: 'CORS',                  detail: 'Backend allowlists the Cloudflare origin via CORS_ORIGINS; preflight + the actual POST go through the same allowlist.' },
    { item: 'Dev parity',            detail: 'Astro dev on :5173, Fastify dev on :3000 — same ports the Container App and APIM use under the hood, so the only thing that changes between dev and prod is the API_BASE env var.' },
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
