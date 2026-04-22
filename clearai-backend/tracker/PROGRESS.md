# ClearAI Build Progress Tracker

> Each task has a **Verify** step — a command or check you can run independently
> to confirm the task works before moving on. Never skip verification.

---

## Snapshot (updated 2026-04-20)

| Phase | Status | Progress |
|-------|--------|----------|
| Phase 1 — Foundation & Data Layer | ✅ Complete | 5/5 done |
| Phase 2 — Resolution Engine | ✅ Complete | 5/5 done |
| Migration V1 (UI split + FastAPI + Frontend) | ✅ Complete | 10/10 M-phases |
| Migration V2 (Azure AI Foundry integration) | 🟡 In progress | 6/7 F-phases |
| Phase 3 — Output & CLI (XML + batch) | ⚪ Not started | 0/5 |
| Phase 4 — Testing & Hardening | ⚪ Not started | 0/4 |
| **Overall** | | **23/36 tasks complete (64%)** |

**Next up:** F6 (Key Vault + ADR-009) when backend moves off the laptop. Then **Embedder swap** → replace `all-MiniLM-L6-v2` with `intfloat/multilingual-e5-small` for Arabic support. Then Phase 3 (XML builder + batch resolver).

**Migration V2 — Azure AI Foundry (2026-04-20):** Path 3 was blocked in V1 because the Anthropic direct API (platform.claude.com) had no credit balance on this account, even though Claude Pro billing is active on claude.ai. Rather than top up a second billing surface, ClearAI is pivoting to Azure AI Foundry — the org already has a shared AI landing zone provisioned by the platform team, and Anthropic exposes a drop-in `AnthropicFoundry` client that routes to `https://<resource>.services.ai.azure.com/anthropic`. Same SDK shape, same response schema, enterprise billing instead of personal credits.

Progress on Migration V2:

- ✅ **F1** — Access + landing zone discovery: confirmed Contributor on `rg-infp-clearai-common-dev-gwc-01` (app LZ, `sub-infp-clearai-nonprod-gwc`, Germany West Central) and on `rg-infp-ai-dev-swc-01` (shared AI LZ, `sub-infp-ai-nonprod-eu`, Sweden Central). Registered `Microsoft.CognitiveServices` RP on the AI subscription. Identified shared Foundry resource `aif-infp-dev-swc-01` as the parent hub for ClearAI's project.
- ✅ **F2** — Foundry project created: `proj-clearai-dev` provisioned as a child of the shared hub `aif-infp-dev-swc-01` via `az cognitiveservices account project create` (portal UI forced a new parent; CLI was the clean path). Endpoint: `https://aif-infp-dev-swc-01.services.ai.azure.com/api/projects/proj-clearai-dev`. System-assigned managed identity enabled. Orphan resources from the earlier portal attempt (`ais-infp-clearai-dev-swc` + its project) scheduled for cleanup.
- ✅ **F3** — Claude Haiku 4.5 + Claude Sonnet 4.6 deployed into `proj-clearai-dev` (Foundry). Endpoint: `https://aif-infp-dev-swc-01.services.ai.azure.com/anthropic`. Single Foundry key authenticates both deployments (Azure keys are per-resource, not per-deployment).
- ✅ **F4** — Reasoner wired to Foundry via `ANTHROPIC_BASE_URL` env var. The existing Anthropic SDK accepts the Foundry URL as a drop-in; no adapter refactor needed for V2. (The formal port/adapter split stays on the roadmap for when a second provider — Bedrock, Vertex — is actually required; speculative refactor avoided per architecture principle "flexibility through interfaces, not premature abstraction.")
- ✅ **F5** — Local end-to-end acceptance run: frontend at `:3000` → backend at `:8787` → Foundry. Path 3 (description-only) now returns a real classification with justification, not `path=failed`. Latency is slow (~2-4s cold) but within expected for Foundry cold-start + multi-hop reasoning; streaming UI is a Phase-4 concern.
- ⚪ **F6** — Governance + secrets: move the Foundry API key out of `.env` into Key Vault in `rg-infp-clearai-common-dev-gwc-01`; eventually switch to managed identity so no key ships with the backend at all. Write ADR-009 capturing the Foundry pivot. **Deferred until backend is deployed off the laptop** — on local dev, Key Vault adds no functional value; it becomes mandatory the moment the backend runs in a shared cloud environment.
- ✅ **F7** — `ComplexityHint` added to `clearai/ports/reasoner.py` (pure evidence dataclass) + builder/predicates/escalation rules in `clearai/services/complexity.py`. Resolver now computes a hint at Ranker and Reasoner call sites, logs it, and applies two deterministic escalation rules (R1: wide tie + low conf; R2: long Arabic-heavy + low conf) to redo a sub-threshold Ranker result at Reasoner tier. Every escalation logs its reason code (`R1_wide_tie_low_conf` / `R2_long_arabic_low_conf`) for audit. 20 unit tests (`tests/unit/test_complexity.py`) lock the rule contract. All 4 import-linter contracts still pass. See ADR-010 for the rationale (and why Foundry's Model Router was rejected).

**Unblockers for V2:** F3 needs an Anthropic model family to be available in Sweden Central at deploy time. If unavailable, fall back to requesting Microsoft to enable it, **not** to swapping providers — GPT-4o via Azure OpenAI was considered and rejected because it breaks the tiered-model architecture in ADR-004 (Haiku for translation, Sonnet for ranking, Opus for the reasoner). Reasoner-provider swaps would force re-validating every prompt and the WCO justification schema on a different model family, for no gain.

**Why not Foundry's Model Router (recorded here, ADR-010 follows):** Foundry offers a `model-router` deployment that dynamically picks Haiku / Sonnet / Opus / GPT / Grok / DeepSeek per prompt using Quality / Cost / Balanced modes. Attractive on paper, rejected for ClearAI because (1) the pipeline's output becomes a customs declaration — cost of a wrong model choice is a regulatory issue, not a UX issue; (2) the WCO 7-section JSON schema is prompt-tuned per model family, and letting the router silently swap families breaks the Pydantic parser; (3) router decisions are opaque and not reliably logged, making classification errors hard to debug; (4) the built-in tiered router (ADR-004) is a three-line dict — not technical debt worth replacing with opaque cloud behavior. Instead, F7 builds a deterministic escalation layer on top of ADR-004 using the `complexity_hint`, which captures the one real benefit of model routers (escalating hard-within-tier cases) without losing auditability.

**Planned — Embedder swap (Arabic support):** Today's FAISS index uses
`all-MiniLM-L6-v2` (English-only, 384-dim). Arabic merchant descriptions
map to near-random points in the embedding space, so retrieval silently
degrades on Arabic input. Fix: swap the embedder for
`intfloat/multilingual-e5-small` (also 384-dim → same FAISS schema) in
both `clearai/data_setup/build_faiss.py` and `clearai/services/hs_resolver.py`,
then regenerate the index. Stays local, no API cost. Scheduled after
Foundry wiring lands.

**Migration V1 (2026-04-19):** Split the repo into `clearai-backend/` (hexagonal,
FastAPI) + `clearai-wiki/` (docs site) + `clearai-frontend/` (Astro + React)
so the resolver can be demoed end-to-end before Phase 3's XML builder lands.
Progress as of this update:

- ✅ **M1** — Repo state audit (clean working tree before moves)
- ✅ **M2** — `git mv clearai-app → clearai-backend`, `clearai-wiki → clearai-wiki` (commit `c921b14`)
- ✅ **M3** — Hexagonal reshape: `clearai/{domain,ports,adapters,services,parsing,rendering,data_setup}`, plus `api/`, `cli/`, layered `tests/` (commit `79d5bcb`)
- ✅ **M4** — All imports rewritten; `pyproject.toml` switched to `setuptools.packages.find` (folded into M3 commit)
- ✅ **M5** — Fresh `.venv` on Python 3.13 + editable install + smoke test (Path 1 passes against live DB, Path 3 blocked only by Anthropic credit balance — not a code issue)
- ✅ **M6** — ADR-008 written + `.importlinter` 4-contract enforcement passing (commit `339528a`)
- ✅ **M7** — FastAPI surface live: `GET /api/health`, `POST /api/resolve`, `HSReasoner.build_justification` port method, Foundry `ANTHROPIC_BASE_URL` routing; tested end-to-end against Path 1 with live FAISS evidence trail
- ✅ **M8** — `clearai-frontend/` scaffolded: Astro 6 + React 19 island + Tailwind 4, design system (parchment/Najdi green/amber stamp, Fraunces + JetBrains Mono + IBM Plex Sans Arabic), typed API client (`src/lib/api.ts`), `ClassifyApp` island wired end-to-end to `POST /api/resolve`, dev server bound to `:3000` to match backend CORS allowlist, Cloudflare-Pages-ready static build (`npm run build` passes clean)
- ✅ **M9** — Components landed: `ClassifyForm` (dumb input), `HSCodePill` (4-2-2-2-2 stamp with path/confidence), `ResultPanel` (customs desc EN+AR, duty, review flags, rationale), `JustificationSection` (7 WCO sections, null-safe), `EvidenceDetails` (FAISS table with score bars, chosen-row highlight, RTL Arabic). Staggered reveal animation with `prefers-reduced-motion` guard.
- ✅ **M10** — End-to-end acceptance test PASSED:
  - `GET /api/health` → `status=ok`, FAISS index present ✓
  - `POST /api/resolve` with `hs_code=490300900005` → Path 1, 98% conf, correct EN+AR customs descriptions ("Illustrative books for children…" / "كتـب مصورة للأطفال…"), 0% duty, 10 FAISS evidence rows ✓
  - Frontend `GET /` → 200, correct `<title>`, 31KB hydrated ✓
  - Description-only comic case degrades gracefully: 200 with `path=failed` and FAISS evidence still attached (Anthropic credit balance blocks Path 3 — this is an account issue, not a code issue; the API surface handles it correctly).

See `tracker/ARCHITECTURE.md` ADR-008 for the hexagonal rules enforced by
import-linter in M6.

**V1 scope note (2026-04-19):** V1 is API-only (Anthropic). The earlier planned
local/Ollama backend has been cut — see ADR-004 and LESSONS.md entry
"V1 goes API-only, drops local LLM backend". Flexibility comes from per-task
model tiering (TRANSLATION_MODEL / RANKER_MODEL / REASONER_MODEL), not from
swapping providers.

**Phase 2 consolidation note:** The original 8-task Phase 2 plan split the
resolver into 4 paths + 3 other modules. During implementation the 4 resolver
paths collapsed into a single `HSResolver.resolve()` dispatch (2.3), making
Phase 2 a 5-task phase, not 8. The subtasks in this file have been renumbered
to match what shipped.

---

## Phase 1 — Foundation & Data Layer

### 1.1 Project scaffolding — ✅ **COMPLETE** (2026-04-16)
- Create `pyproject.toml` with all dependencies
- Create `.env.example` with all env vars documented
- Create `.gitignore` (data/, output/, *.db, *.index, .env)
- Create `__init__.py` files where needed
- Create `data/README.md` and top-level `README.md`

**Verify (passed):**
```bash
python3 -c "
import tomllib, pathlib
p = pathlib.Path('.')
with open('pyproject.toml', 'rb') as f: cfg = tomllib.load(f)
assert cfg['project']['name'] == 'clearai-app'
for d in ['llm', 'db', 'tests', 'templates', 'data', 'output', 'tracker']:
    assert p.joinpath(d).is_dir()
for d in ['llm', 'db', 'tests']:
    assert p.joinpath(d, '__init__.py').is_file()
print('✓ PHASE 1.1 VERIFIED')
"
```
**Result:** 8 deps declared, 6 required env keys present, 7 dirs + 3 __init__.py stubs OK.

---

### 1.2 Config module — ✅ **COMPLETE** (2026-04-16, revised 2026-04-19)
- `config.py` — loads all settings via python-dotenv
- Fails fast: missing `ANTHROPIC_API_KEY`, non-numeric floats
- Three-tier model split via env: `TRANSLATION_MODEL` (Haiku), `RANKER_MODEL` (Sonnet), `REASONER_MODEL` (Opus)
- `BAYAN_CONSTANTS` dict (27 values from baseline XMLs) — broker info, declarationType, hardcoded defaults
- `BAYAN_NAMESPACES` dict (7 XML namespace prefixes: decsub, deccm, sau, cm, deckey, xsi, xsd)
- `describe()` helper for startup logging (no secrets leaked)
- Relative paths resolved against project root, not cwd

**2026-04-19 revision:** Dropped `LLM_BACKEND` / `OLLAMA_*` / `*_LOCAL_MODEL` vars
(V1 is API-only). See ADR-004.

**Verify (passed):**
```bash
# Test 1: no API key → fails fast ✓
ANTHROPIC_API_KEY= python3 -c "import config"
# Test 2: API key set → succeeds ✓
ANTHROPIC_API_KEY=sk-test python3 -c "import config; print(config.describe())"
# Test 3: custom threshold → honored ✓
ANTHROPIC_API_KEY=sk-test CONFIDENCE_THRESHOLD=0.85 python3 -c "import config"
# Test 4: model overrides → honored ✓
ANTHROPIC_API_KEY=sk-test REASONER_MODEL=claude-opus-4-7 python3 -c "import config; print(config.REASONER_MODEL)"
ANTHROPIC_API_KEY=sk-test TRANSLATION_MODEL=claude-haiku-4-7 python3 -c "import config; print(config.TRANSLATION_MODEL)"
```
**Result:** 27 BAYAN_CONSTANTS, 7 namespaces, fail-fast works.

---

### 1.3 Database setup — schema & mapping load — ✅ **COMPLETE** (2026-04-17)
- `db/setup.py` — creates 9 tables (8 data + 1 meta) with prefix indexes for fast HS code lookups
- Streaming xlsx loader (openpyxl read_only + iter_rows) — no whole-file loads
- HS code normalization: strip non-digits, zero-pad to 12 digits
- Duty rate parser: extracts % from text, handles Arabic "معفاة"/English "Exempted" → 0.0
- Idempotent: drops & recreates tables each run
- Fail-fast: checks source files exist before touching DB; warns on row-count shortfalls

**Schema adjustments from initial design:**
- `tabdul_city` PK changed to composite `(city_cd, ctry_cd)` — CITY_CD is not globally unique; cycles 1..N per country
- `source_company_mapping.source_company_no` typed as `TEXT` — one row contains non-numeric `"QA Test"`
- Added bonus `country_code` table — needed to translate numeric `country_origin` → 2-letter ISO (e.g. 145 → `CN`)
- Added bonus `city_mapping_bridge` table — required for 2-step city lookup

**Verify (passed):**
```bash
python db/setup.py
# Row counts:
#   hs_decision_ledger    499      (from 500 raw; 1 dupe on normalized raw_code)
#   hs_code_master      19138
#   currency_mapping       13
#   city_mapping_bridge   328
#   tabdul_city          1084      (from 2168 raw; source has exact-row duplicates)
#   source_company_mapping 206
#   country_origin_mapping 104
#   country_code          307
```

**Spot checks (passed):**
- 10 tables created ✓
- All 19,138 HS codes have Arabic names ✓
- 6,767 codes parsed as duty-exempt (Arabic "معفاة" → 0.0) ✓
- Country lookup works: `CN` → CHINA ✓
- All 499 ledger codes normalized to 12 digits ✓
- Fallback source company `(client_id=-1, port=23) → "ناقل"` present ✓

---

### 1.4 FAISS index build — ✅ **COMPLETE** (2026-04-17)
- `db/build_faiss.py` — loads corpus from SQLite, embeds with `sentence-transformers/all-MiniLM-L6-v2`
- Uses `IndexFlatIP` with L2-normalized embeddings → cosine similarity via inner product
- Writes `hs_master_faiss.index` + `hs_codes.json` (codes list + model/dim metadata)
- Self-test on build: round-trip a known description, expect it back at rank 0 with score ~1.0

**Verify (passed):**
```bash
python3 db/build_faiss.py
# Output: 19,104 vectors, dim=384, self-test score 1.000
# Semantic spot-check:
#   "wireless bluetooth earbuds" → 851762900009 "wireless headphones" (0.73)
#   "cotton dress for women"     → 620630000001 "Blouses for women and girls of cotton" (0.76)
#   "baby formula powder"        → 330491100000 "Baby powders" (0.71)
```
**Result:** semantic retrieval quality is strong out of the box — no fine-tuning required.

---

### 1.5 Invoice parser — ✅ **COMPLETE** (2026-04-17)
- `invoice_parser.py` — streaming xlsx (openpyxl read_only) + CSV reader
- `parse_invoice(path)` yields cleaned row dicts
- `group_by_waybill(rows)` buckets into per-declaration lists
- Type coercion: `Quantity → int`; `TotalCost/UnitCost/Amount → float`; dates → ISO string
- Whitespace stripped on all strings; empty strings → None
- Header validation: raises `InvoiceParseError` if any of 21 required columns missing
- Per-row warnings (not failures) on bad type coercion — keeps big files flowing

**Verify (passed on real 30MB sample):**
```bash
python3 -c "
from invoice_parser import parse_invoice, group_by_waybill
rows = list(parse_invoice('data/client_commercial_invoices_sample2.xlsx'))
groups = group_by_waybill(iter(rows))
print(f'{len(rows):,} rows, {len(groups):,} waybills')
"
# Output: 353,622 rows, 31,017 waybills, parsed in 30s
# avg 11.4 items per waybill, max 232
```

**Edge cases verified:**
- ✓ CSV backend works identically to xlsx
- ✓ Empty strings coerced to None
- ✓ Missing required column → `InvoiceParseError` with clear message
- ✓ Missing file → `FileNotFoundError`
- ✓ Arabic text preserved through parse (UTF-8)

---

## Phase 2 — Resolution Engine

### 2.1 LLM abstract interface — ✅ **COMPLETE** (2026-04-19)
- `llm/base.py` — `HSReasoner` ABC with three tier-routed methods:
  - `translate_to_arabic(description_en) -> ReasonerResult`  → TRANSLATION_MODEL
  - `rank_candidates(RankerInput) -> ReasonerResult`          → RANKER_MODEL
  - `infer_hs_code(ReasonerInput) -> ReasonerResult`          → REASONER_MODEL
- Typed input/output dataclasses: `Candidate`, `RankerInput`, `ReasonerInput`, `ReasonerResult`
- Single exception type `ReasonerError` — resolver catches to route failing rows to review
- `ReasonerResult` is uniform across all three methods so the resolver handles them identically (parse → gate on confidence → accept or flag)
- `agrees_with_naqel` flag populated only by `infer_hs_code` (per ADR-007)

**Verified:** AST parse + abstract-method enumeration pass; no missing methods.

---

### 2.2 API backend (Anthropic) — V1's only backend — ✅ **COMPLETE** (2026-04-19)
- `llm/api_backend.py` — `AnthropicReasoner(HSReasoner)` implementing all three methods
- Three-tier model split (see ADR-004):
  - `translate_to_arabic` → `TRANSLATION_MODEL` (Haiku — cheapest, narrow task)
  - `rank_candidates`     → `RANKER_MODEL` (Sonnet — middle tier, comparison judgement)
  - `infer_hs_code`       → `REASONER_MODEL` (Opus — top tier, hardest inference)
- Temperature 0, JSON-object responses with schema per task
- Single `_call_json` choke-point: handles API errors, empty bodies, ```json fence stripping, JSON validation, dict-type enforcement
- HS-code validation via `^\d{12}$` after digit-stripping — invalid → `ReasonerError`
- Confidence clamped to `[0.0, 1.0]`; malformed → 0.0 (forces review via threshold gate)
- `agrees_with_naqel` tolerates bool or stringified bool/null
- Two system prompts: classifier (rank + infer) and translator (narrow Arabic)

**Verified:** AST confirms all three abstract methods implemented; `AnthropicReasoner` inherits `HSReasoner`.

---

### 2.3 Resolver — all four paths in one module — ✅ **COMPLETE** (2026-04-19)
- `hs_resolver.py` — `HSResolver` class owning DB connection + lazy FAISS index + reasoner handle
- **Path 1 · Direct** — 12-digit declared code exists in `hs_code_master` → confidence 0.98
- **Path 2 · Longest-prefix-wins** — 4–11 digit declared code; traverses prefixes `len(declared)-1 → 4`, takes the row with shortest HS code at the winning prefix length; ties resolved via `RANKER_MODEL`. Confidence 0.70–0.95 by prefix length.
- **Path 3 · Reasoner** — no usable declared code / no prefix match; embeds description via sentence-transformers, pulls top-K FAISS candidates, calls `REASONER_MODEL` with Naqel bucket hint as advisory context (per ADR-007)
- **Ledger is a hint, not a gate** — bucket lookup (scoped to `client_id`) is always done, surfaced to the Reasoner, and compared against the final code via `agrees_with_naqel`
- `_should_flag()` — flags below `CONFIDENCE_THRESHOLD` OR when confident-but-disagrees-with-Naqel (highest-value review items)
- Never raises mid-batch — top-level `try/except` on `resolve()` returns a `path="failed"` `Resolution` with `error` populated
- Context-manager support (`__enter__` / `__exit__`) for DB lifecycle
- FAISS + sentence-transformers are lazy-loaded on first Reasoner call so Path 1+2 runs don't pay the import cost

**Verified (live, against real `clear_ai.db`):**
```
Path 1 direct ✓  hs=010100000000 conf=0.98 flagged=False
Path 2 prefix ✓  path=prefix hs=010100000000 conf=0.8
Failure      ✓  path=failed  (empty declared + empty description → flagged, error captured)
```

---

### 2.4 Lookup engine — ✅ **COMPLETE** (2026-04-19)
- `lookup_engine.py` — `LookupEngine` class with indexed lookups against all five mapping tables
- Typed result dataclasses: `CurrencyLookup`, `CityLookup`, `SourceCompany`, `CountryLookup`
- Methods:
  - `currency_by_iso(iso)` — ISO-4217 → (infotrack_id, tabdul_id)
  - `currency_by_infotrack_id(id)` — reverse path
  - `city_by_info_id(info_city_id)` — bridges `city_mapping_bridge` → `tabdul_city`
  - `source_company(client_id, port_code)` — falls back to `BAYAN_CONSTANTS["defaultSourceCompanyName"]` (`"ناقل"`) when no mapping
  - `country_of_origin(client_id)` — joins `country_origin_mapping` → `country_code` (origin comes from mapping, not Excel `CountryofManufacture`, per INSTRUCTIONS.md)
  - `country_by_intl_code(iso2)` — general ISO-2 country lookup

**Verified (live):**
```
currency USD  → CurrencyLookup(infotrack_currency_id=4, tabdul_currency_id=410, iso_code='USD')
country  CN   → CountryLookup(code=142, en='CHINA', ar='الصين الشعبية', intl='CN')
source_company fallback (unknown client/port) → name='ناقل' number='340476' is_fallback=True
```

---

### 2.5 Arabic translation engine — ✅ **COMPLETE** (2026-04-19)
- `arabic_translation_engine.py` — `ArabicTranslationEngine` with 4-path resolution (cheapest first):
  1. **Invoice row** — scans all row fields for any Arabic-Unicode string; first hit wins
  2. **Master** — `hs_code_master.arabic_name` for the resolved code
  3. **Ledger** — `hs_decision_ledger.arabic_name` tied to merchant's declared raw code
  4. **LLM translation** via `TRANSLATION_MODEL` (Haiku), with in-process cache keyed by English description so the same phrase isn't re-translated per row
- Returns `ArabicResolution(arabic, source, cache_hit)` — source is one of `invoice | master | ledger | llm_translation | missing`
- Never raises — `ReasonerError` logs + returns `source=missing`, caller decides what to do

**Verified (live):**
```
Path 1 invoice ✓   src=invoice
Path 2 master  ✓   src=master  (real ZATCA Arabic name from hs_code_master)
Path 4 LLM     ✓   src=llm_translation  ar='قميص قطن'  (from stub)
cache hit      ✓   cache_hit=True on second call with same English description
```

---

## Phase 3 — Output & CLI

### 3.1 XML template
- `templates/declaration.xml.j2` — 7-section ZATCA structure
- All template variables documented in comments

**Verify:**
```bash
python -c "
from jinja2 import Environment, FileSystemLoader
env = Environment(loader=FileSystemLoader('templates'))
tmpl = env.get_template('declaration.xml.j2')
# Render with dummy data
xml = tmpl.render(
    doc_ref_no='NQD260416001', waybill_no='WB001', declaration_date='2026-04-16',
    source_company='ناقل', tier='LV', country_origin='CN', cpc='40',
    items=[{'hs_code': '620442000000', 'arabic_desc': 'فساتين', 'quantity': 1, 'unit_type': 'PCS', 'unit_cost': 10.0, 'amount': 10.0, 'currency': 'SAR'}],
    consignee='Test', consignee_address='Riyadh', city_cd='RUH', city_arabic='الرياض', phone='0500000000',
    invoice_date='2026-04-16', transport_type='5'
)
print(xml[:200])
assert '620442000000' in xml and 'ناقل' in xml
print('XML TEMPLATE OK')
"
```

---

### 3.2 XML builder
- `xml_builder.py` — takes resolved rows + lookups, renders XML per declaration

**Verify:**
```bash
python -c "
from xml_builder import build_declaration_xml
xml = build_declaration_xml(waybill_no='WB001', resolved_items=[...], lookups={...})
print(f'XML length: {len(xml)} chars')
# Validate it parses as XML
import xml.etree.ElementTree as ET
ET.fromstring(xml)
print('XML BUILDER OK — valid XML produced')
"
```

---

### 3.3 CLI entry point
- `run.py` — `--input`, `--output`, `--compare` flags
- Orchestrates: parse → group → resolve → lookup → xml → review.csv → audit.log

**Verify:**
```bash
python run.py --input data/sample_invoice.xlsx --output ./output/
ls -la output/
# Expect: declaration_*.xml files, review.csv, audit.log
head -5 output/audit.log
head -5 output/review.csv
echo "CLI OK"
```

---

### 3.4 Comparator
- `comparator.py` — diff generated XML against baseline XMLs
- Output: MATCH / DIFFER / MISSING per line item

**Verify:**
```bash
python run.py --input data/sample_invoice.xlsx --output ./output/ --compare ./baseline/
cat output/diff_report.txt
# Expect: MATCH/DIFFER/MISSING lines per waybill+item
echo "COMPARATOR OK"
```

---

### 3.5 Feedback write-back
- `db/write_verified.py` — reads reviewed CSV, writes corrections to ledger

**Verify:**
```bash
# Add a verified_code to a review.csv row, then:
python db/write_verified.py --review-csv output/review.csv
sqlite3 clear_ai.db "SELECT * FROM hs_decision_ledger ORDER BY created_at DESC LIMIT 5;"
# Expect: newly inserted row with provenance='human_verified'
echo "WRITE-BACK OK"
```

---

## Phase 4 — Testing & Hardening

### 4.1 Unit tests
- `tests/test_resolver.py` — one test per resolution path
- Mock LLM calls with fixture responses

**Verify:**
```bash
python -m pytest tests/ -v
```

---

### 4.2 End-to-end validation
- Full run with real invoice → inspect all outputs
- Spot-check 10 HS codes manually

**Verify:**
```bash
python run.py --input data/real_invoice.xlsx --output ./output/
# Manual inspection checklist:
# [ ] XML files created per waybill
# [ ] review.csv contains low-confidence items only
# [ ] audit.log has one line per row with path + confidence
# [ ] Spot-check 10 codes against manual tariff lookup
```

---

### 4.3 Comparator validation
- Run against Naqel baseline XMLs
- Match rate target: >85% on first run

**Verify:**
```bash
python run.py --input data/real_invoice.xlsx --output ./output/ --compare ./baseline/
grep -c "MATCH" output/diff_report.txt
grep -c "DIFFER" output/diff_report.txt
# Calculate match rate
```

---

### 4.4 Code review & security pass
- No hardcoded keys
- All SQL parameterized (no injection)
- LLM prompts don't leak data file contents
- Error handling on per-row processing

**Verify:**
```bash
grep -r "API_KEY" --include="*.py" . | grep -v ".env" | grep -v "os.getenv"
# Expect: no hardcoded keys
grep -r "f\"SELECT\|f'SELECT" --include="*.py" .
# Expect: no f-string SQL (should all be parameterized)
echo "SECURITY CHECK DONE"
```

---

## Blockers

| # | Blocker | Blocks | Status | Resolution |
|---|---------|--------|--------|------------|
| B1 | Data xlsx files not in `data/` | 1.3+ | ✅ Resolved | All 4 files received from Naqel (2026-04-16) |
| B2 | Real Bayan XSD unavailable | 3.1 accuracy | ✅ Resolved | Schema extracted from 5 baseline XMLs in `data/Baseline XML output/` |
| B3 | SAR conversion rates undefined | 3.3 (tier calc) | Open | Decide: static table vs live API (use static for V1) |
| B4 | Transport ID type rule unconfirmed | 3.1 | ✅ Resolved | Consignee NatID: starts 1→type 5, starts 2→type 3 |
| B5 | `DestinationStationID` field mapping | 2.5 (city lookup) | ✅ Resolved | Maps to `InfoCityId` in `CityMaping` sheet |
| B6 | `PREFIX_RANKER_MAX_CANDIDATES` threshold | 2.4c | ✅ Resolved | Naqel uses longest-prefix-wins (no threshold needed) |
| B7 | Sample merchant invoice for E2E test | 4.2 | ✅ Resolved | `data/client_commercial_invoices_sample2.xlsx` (50k rows, 3,020 waybills) |
| B8 | Baseline XML for comparator | 4.3 | ✅ Resolved | `data/Baseline XML output/` (5 XMLs: 3 full + 2 post-processed) |
| B9 | Bayan XML schema (real) | 3.1 | ✅ Resolved | Extracted from baselines — see INSTRUCTIONS.md "Bayan XML schema" section |

See [DATA_AUDIT.md](./DATA_AUDIT.md) for full data coverage analysis.
