# Lessons Learned

> Capture what worked, what didn't, and what to do differently next time.
> Add entries as the build progresses — don't wait until the end.

---

## Format

Each entry follows this structure:

```
### [Date] — Short title
**Context:** What were we doing?
**What happened:** What went wrong/right?
**Lesson:** What do we know now?
**Action:** What changes going forward?
```

---

## Entries

### 2026-04-19 — Three-tier model split (Haiku / Sonnet / Opus) replaces two-tier
**Context:** Right after dropping local inference and moving to API-only, the natural design was two tiers — cheap Ranker (Sonnet) for narrow tasks, strong Reasoner (Opus) for hard ones. Arabic translation was bundled under the Ranker tier.
**What happened:** On closer look, Arabic translation is noticeably simpler than candidate ranking — it's a narrow terminology task, not a comparison/judgement task. Running it on Sonnet works but pays a Sonnet price for what is likely the most-frequently-called LLM site in the pipeline (every row that needs a fallback Arabic description). Haiku does this task well at roughly an order of magnitude lower cost.
**Lesson:** "Cheap vs strong" is already an improvement over "API vs local," but two tiers collapses real task-difficulty variance. Three tiers (one per clearly-separable task class) is still boring-simple — one env var per task, one default per env var, no dynamic routing — but captures the actual cost structure of the workload.
**What we explicitly rejected:** confidence-based routing (Haiku → escalate to Sonnet) and content-based heuristic routing. Both sound clever; both have a well-known track record of complexity outpacing savings. Revisit only if V1 cost data from real runs justifies it.
**Action:**
- Added `TRANSLATION_MODEL` env var (default `claude-haiku-4-6`) to `.env.example` and `config.py`
- `RANKER_MODEL` narrowed in scope to "candidate ranking only" (no longer covers translation)
- ADR-004 rewritten from "two-tier" to "three-tier" split with explicit rationale for not doing dynamic routing
- `describe()` in config now prints all three models
- INSTRUCTIONS.md prompt rules split into three bullets (Ranker / Reasoner / Translation), each with the env var named

---

### 2026-04-19 — V1 goes API-only, drops local LLM backend
**Context:** The original design had a pluggable LLM backend — Anthropic API *or* Ollama local — behind the `HSReasoner` interface. `.env.example`, `config.py`, `pyproject.toml`, and PROGRESS.md all carried the dual-backend assumption. Stakeholder feedback: "don't bother — this isn't running locally or offline, so there's no reason for local inference. Why a separate rig, complexity, and 'dumbness' when we can call the API cheaply on the Foundry."
**What happened:** On reflection the local-backend plan was speculative insurance against a requirement that doesn't actually exist. V1 is not an air-gapped deployment. Data residency is handled at the API-vendor layer (regional endpoints / Bedrock) more cleanly than by hosting an open-source 70B on a separate box. And the accuracy ceiling of the strongest local model is still measurably below Opus on the hardest HS classification cases — the very cases where a model call is most justified.
**Lesson:** Don't build in flexibility for a requirement you can't name a concrete deployment for. Abstractions cost — test surface, doc surface, dep surface, mental surface. "Pluggable backend" sounds free but it bought us an Ollama install step in docs, a second code path to maintain, an `ollama` pip dep, and an `LLM_BACKEND` env switch that had to be validated in 5 places. Dropping it removed 30+ lines of config, one Python dep, one PROGRESS task, and simplified the quick-start from "pick a backend → configure it" to "set ANTHROPIC_API_KEY."
**Action:**
- Removed `ollama>=0.2` from pyproject.toml
- Removed `LLM_BACKEND`, `OLLAMA_BASE_URL`, `RANKER_LOCAL_MODEL`, `REASONER_LOCAL_MODEL` from `.env.example` and `config.py`
- Renamed env vars: `RANKER_API_MODEL` → `RANKER_MODEL`, `REASONER_API_MODEL` → `REASONER_MODEL` (the "_API_" infix was only meaningful when there was a local counterpart)
- Dropped Phase 2.3 (Local backend task) from PROGRESS.md; renumbered 2.4a-d → 2.3-2.6
- Rewrote ADR-004 from "Pluggable API or local" to "API-only with per-task model tiering"
- Updated INSTRUCTIONS.md architecture principles — "Pluggable LLM backend" → "Model tiering, not backend switching"
- The flexibility axis is now cheap-vs-strong model per task (Sonnet for Ranker/translation, Opus for Reasoner). Same spirit, simpler mechanism.

---

### 2026-04-16 — BUILD.md XML schema was a placeholder, not the real Bayan schema
**Context:** Planning Phase 3.1 (XML template). BUILD.md provided an illustrative `<CustomsDeclaration>` template with simple tag names. We received 5 real baseline XMLs from Naqel.
**What happened:** The real ZATCA/SaudiEDI schema uses a completely different structure — SOAP-style namespaced XML with `decsub:` / `deccm:` / `sau:` / `cm:` prefixes, root `<decsub:saudiEDI>`, and field names like `tariffCode` (not `hsCode`), `goodsDescription` (not `arabicDescription`), `countryOfOrigin` (not `countryOfOrigin`), etc.
**Lesson:** Never take BUILD.md templates literally when real baseline output exists. Always extract schema from ground-truth samples. BUILD.md was clear about this ("This template is a starting point… update to match exactly") but the warning is easy to miss.
**Action:**
- Treat baseline XMLs in `data/Baseline XML output/` as the schema source of truth
- Document extracted schema in INSTRUCTIONS.md (Data Inventory section)
- Hardcoded constants (userid, acctId, broker info, etc.) go into `config.BAYAN_CONSTANTS`, not the template
- Jinja2 template renders only the dynamic per-declaration/per-item fields

---

### 2026-04-16 — Longest-prefix-wins replaces LLM Ranker for most cases
**Context:** BUILD.md Path 3 used a Ranker LLM call when prefix traversal returned 2-15 candidates. Planned threshold `PREFIX_RANKER_MAX_CANDIDATES = 15`.
**What happened:** `HS Code Mapping - Logic.xlsx` shows Naqel's actual algorithm: generate prefix variants (strip last digit repeatedly), match each against master, order by `LEN(ClientHSCode) DESC, LEN(HSCode) ASC`, take first row. **No LLM involved.**
**Lesson:** Naqel's production algorithm is deterministic and cheaper than what BUILD.md proposed. Deterministic beats probabilistic when the rule is clear.
**Action:**
- Replace Ranker LLM path with longest-prefix-wins deterministic logic
- Keep the LLM Reasoner (Path 4) for the truly-unknown-code case (FAISS-based)
- Update hs_resolver.py paths accordingly when we build 2.4c

---

### 2026-04-16 — Phase 1.1 scaffolding: verify `.gitignore` patterns match what your smoke test checks
**Context:** Completed Phase 1.1 scaffolding (pyproject.toml, .env.example, .gitignore, __init__.py stubs).
**What happened:** First smoke test failed because `.gitignore` had `clear_ai.db` written out explicitly, but the verify script checked for the glob `*.db`. Semantically equivalent, literally different.
**Lesson:** When the verify script asserts on exact strings in files, be deliberate about specificity. Globs (`*.db`) are safer and more portable than named files (`clear_ai.db`) — they cover test databases, temp dbs, future renames, etc.
**Action:**
- Default to glob patterns in `.gitignore` (`*.db`, `*.index`, `*.log`) unless there's a reason to pin a specific name
- Keep verify scripts checking globs too — they survive refactors

---

### 2026-04-16 — Phase 1.2 config: resolve paths against project root, not cwd
**Context:** Writing `config.py`. The `.env.example` declares `DB_PATH=clear_ai.db` (relative).
**What happened:** If a user runs `python db/setup.py` from inside the `db/` subdir, a relative `DB_PATH` would resolve to `db/clear_ai.db` — surprising and wrong. Same risk for FAISS index, output dir, data dir.
**Lesson:** Relative paths in config are a footgun. They silently resolve against the caller's cwd, creating inconsistent artifacts depending on where the user runs scripts from.
**Action:**
- All `*_PATH` vars in `config.py` use a `_get_path()` helper that resolves relative paths against `_PROJECT_ROOT` (the dir containing `config.py`)
- Same trick to use for any future file-path configs
- Downside: absolute paths in env still win, which is fine for deployments that need it

---

### 2026-04-17 — Phase 1.5 invoice parser: sample has 7× more rows than the earlier scan showed
**Context:** DATA_AUDIT.md recorded the sample invoice at "~50k rows, 3,020 waybills" based on an early probe.
**What happened:** Full parse revealed 353,622 rows across 31,017 waybills — the earlier scan had a 50k row cap. Avg 11 items per waybill, with the largest single waybill at 232 items.
**Lesson:** Bounded probes lie. If the real file is ≥10× what you assume, resource-planning decisions downstream (LLM call budget, grouping memory, output XML volume) drift silently.
**Action:**
- Updated DATA_AUDIT.md figures (will do in next pass)
- Phase 3.3 CLI budget planning: if every waybill needs ~1 LLM call (Reasoner path), that's 31k calls per full run — cost estimate needs revisiting
- `group_by_waybill` currently materializes all rows; for 31k groups × 11 items this is still fine memory-wise (~50MB) but worth revisiting if files scale further

---

### 2026-04-17 — Phase 1.4 FAISS: IndexFlatIP + normalized embeddings beats IndexFlatL2
**Context:** BUILD.md pseudocode uses `IndexFlatL2`, which gives distance (lower=better). The Reasoner LLM prompt will include candidate scores.
**What happened:** Switched to `IndexFlatIP` (inner product) with `normalize_embeddings=True`. For L2-normalized vectors, inner product == cosine similarity, so scores land in [-1, 1] with 1.0 = perfect match.
**Lesson:** LLMs interpret scores better when the scale is semantically meaningful. "0.73 cosine similarity" is immediately interpretable; "0.54 L2 distance" requires the LLM to know the embedding dimensionality.
**Action:**
- Index is IndexFlatIP
- `hs_codes.json` stores model name and dim alongside codes — gives us a versioning hook if we switch embedding models later
- Self-test on build confirms round-trip works (query a known description → get its own code back at rank 0 with score ≈ 1.0)

---

### 2026-04-17 — Phase 1.4 FAISS: semantic retrieval is strong out of the box
**Context:** First qualitative test of the Reasoner retrieval path.
**What happened:** Tested 4 unseen queries (bluetooth earbuds, cotton dress, steel knife, baby formula). Every query returned semantically plausible top-3 candidates with cosine ≥ 0.55. "wireless bluetooth earbuds" → "wireless headphones" at 0.73, "cotton dress for women" → "cotton blouses for women" at 0.76.
**Lesson:** MiniLM-L6-v2 is sufficient for this domain at this scale (19k codes, English descriptions). No need for domain-specific fine-tuning in V1.
**Action:**
- Stick with `all-MiniLM-L6-v2` for V1
- Revisit only if we see LLM mis-classifications concentrated in specific domains (e.g. chemicals, machinery)
- The 0.05 gap between rank-1 and rank-3 for knife queries (0.66 → 0.59) shows FAISS alone can't distinguish culinary vs tactical — that's what the LLM is for

---

### 2026-04-18 — Product vision reframe: precise classifier, not Naqel bucket replayer
**Context:** Designing the Phase 2 resolver. The `hs_decision_ledger` showed a single code (e.g. `620442000000`) reused 137× across 7 different HS chapters of input codes. I initially read this as "human corrections" (wrong — Naqel does it automatically), then as "the authoritative bucket-map that defines our output" (also wrong).
**What happened:** User clarified the goal: build something like Zonos' HS lookup tool — resolve a merchant's incomplete/wrong HS code into the **correct** 12-digit Saudi ZATCA code. Naqel's ledger is an operational bucket-mapping for consolidated express clearance; helpful as a hint, not as the answer.
**Lesson:** When ground-truth-looking data is actually operational shortcut data, treating it as the oracle makes the product a re-implementation of someone else's shortcut instead of a real classifier. Always separate "what the data encodes" from "what the product must decide."
**Action:**
- Added ADR-007 documenting this reframe
- Phase 2 resolver redesign: ledger becomes a **prior / hint**, not a gate. 4-path short-circuit on ledger-hit is removed
- Reasoner prompt will include ledger hint as one evidence stream alongside FAISS + prefix + description + duty-rate
- Highest-value review items are those where correct-classification disagrees with Naqel's bucket — surface both
- Confidence scoring: primary = classification correctness, secondary = agreement with Naqel bucket

---

### 2026-04-17 — Phase 1.3 DB setup: CITY_CD is not globally unique
**Context:** Writing the `tabdul_city` schema for `db/setup.py`. BUILD.md shows `city_cd` as a simple lookup key; my initial schema used it as a single-column PRIMARY KEY.
**What happened:** Loading the 2,168-row sheet blew up — CITY_CD cycles 1..N within each country (e.g. `city_cd=3` appears 198 times, once per country context). The real unique key is the composite `(city_cd, ctry_cd)`. Also discovered the sheet contains exact-row duplicates (each row appears twice), so 2,168 raw rows produce 1,084 unique entries.
**Lesson:** Never trust a column name to imply uniqueness. Always check cardinality in the real data before committing to a PK. The fact that BUILD.md said "city_cd" without qualifier is exactly the kind of ambiguity that bites you at schema time.
**Action:**
- `tabdul_city` PK is now composite `(city_cd, ctry_cd)`
- Added `idx_tabdul_city_intl` and `idx_tabdul_city_eng` for the likely lookup patterns
- The `run_all_lookups` city logic (Phase 2.5) must route by country context, not just city_cd
- Updated expected row count in setup sanity check from 2000 → 1000 (reflects actual unique count)

---

### 2026-04-17 — Phase 1.3 DB setup: test data leaked into production mapping data
**Context:** Loading `SourceCompanyPortMaping` sheet — `SourceCompanyNo` column declared to hold integers.
**What happened:** Row 88 contains `SourceCompanyName="It test Comapoany QA", SourceCompanyNo="QA Test"` — test data Naqel forgot to clean out before sharing.
**Lesson:** Real enterprise data often has test rows mixed in. Don't assume every row meets the declared type. Better to type columns permissively and validate at query time than to blow up on load.
**Action:**
- `source_company_no` is TEXT not INTEGER
- Future loaders: use `str()` coercion for fields where we care more about preserving the value than enforcing type strictness
- Consider flagging these test rows during load (e.g. if name matches `/test|QA/i`) and logging a warning

---

### 2026-04-17 — Phase 1.3 DB setup: duty rate is text, not a number
**Context:** Writing the `hs_code_master` schema — BUILD.md showed `duty_rate REAL`.
**What happened:** The ZATCA Tariff sheet's duty column contains mixed values: `"5%"`, `"معفاة"` (Exempted in Arabic), blank strings, and occasional numeric strings. A `REAL` column would force lossy conversion and lose the original text.
**Lesson:** When source data is authored by humans in Excel, expect mixed content in "numeric" columns. Always keep the original string AND a parsed numeric beside it, so XML output can match the source exactly.
**Action:**
- Schema has both `duty_rate_text TEXT` (verbatim) and `duty_rate_pct REAL` (parsed, nullable)
- Parser: 0.0 for "معفاة"/"Exempted", extracted % otherwise, NULL if unparseable
- 6,767 / 19,138 codes (~35%) are duty-exempt

---

### 2026-04-16 — Phase 1.2 config: expose Bayan constants as a dict, not 27 module-level vars
**Context:** Writing `config.py`. The baseline XMLs reveal 27 hardcoded values (broker info, declarationType, measurement units, etc.).
**What happened:** Initial instinct was to export each as its own uppercase constant (`BAYAN_USER_ID`, `BAYAN_ACCT_ID`, …). That bloats the module and couples template rendering to individual imports.
**Lesson:** Grouping related constants into a single dict (`BAYAN_CONSTANTS`) makes the template renderer cleaner (`{{ bayan.userid }}`), keeps env override flags collocated, and adds a natural integration point for future per-client overrides.
**Action:**
- `BAYAN_CONSTANTS` is a dict with 27 values, each still overridable via `BAYAN_*` env var
- `BAYAN_NAMESPACES` is a similar dict (7 XML namespace prefixes)
- Templates receive these dicts as a single context object rather than individual globals

---

### 2026-04-16 — Sample invoice is 30MB / 50k rows / 3,020 waybills
**Context:** Planning E2E test for Phase 4.2.
**What happened:** `client_commercial_invoices_sample2.xlsx` is much larger than expected (30MB, 50k rows). Column layout matches BUILD.md spec exactly.
**Lesson:** Test infrastructure needs to handle large inputs. Streaming xlsx read (openpyxl read_only mode) is essential — loading the whole thing into memory will crash.
**Action:**
- `invoice_parser.py` must use `openpyxl.load_workbook(readonly=True)` + `iter_rows(values_only=True)`
- Do NOT use `pandas.read_excel` for the main parser path — it loads everything in memory
- For Phase 4.2 test: use a 100-row subset first, then scale up
