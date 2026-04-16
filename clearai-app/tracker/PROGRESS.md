# ClearAI Build Progress Tracker

> Each task has a **Verify** step — a command or check you can run independently
> to confirm the task works before moving on. Never skip verification.

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

### 1.2 Config module — ✅ **COMPLETE** (2026-04-16)
- `config.py` — loads all settings via python-dotenv
- Fails fast: missing `ANTHROPIC_API_KEY` when `LLM_BACKEND=api`, invalid `LLM_BACKEND` value, non-numeric floats
- `BAYAN_CONSTANTS` dict (27 values from baseline XMLs) — broker info, declarationType, hardcoded defaults
- `BAYAN_NAMESPACES` dict (7 XML namespace prefixes: decsub, deccm, sau, cm, deckey, xsi, xsd)
- `describe()` helper for startup logging (no secrets leaked)
- Relative paths resolved against project root, not cwd

**Verify (passed):**
```bash
# Test 1: api backend without key → fails fast ✓
ANTHROPIC_API_KEY= LLM_BACKEND=api python3 -c "import config"
# Test 2: local backend → succeeds ✓
LLM_BACKEND=local python3 -c "import config; print(config.describe())"
# Test 3: api + key → succeeds ✓
LLM_BACKEND=api ANTHROPIC_API_KEY=sk-test python3 -c "import config"
# Test 4: invalid backend → fails fast ✓
LLM_BACKEND=bogus python3 -c "import config"
# Test 5: custom threshold → honored ✓
LLM_BACKEND=local CONFIDENCE_THRESHOLD=0.85 python3 -c "import config"
```
**Result:** 27 BAYAN_CONSTANTS, 7 namespaces, all 5 validation paths work.

---

### 1.3 Database setup — schema & mapping load
- `db/setup.py` — create all 6 tables in SQLite
- Load each xlsx mapping file into its table
- Print row counts per table on completion

**Verify:**
```bash
python db/setup.py
sqlite3 clear_ai.db "SELECT 'ledger', COUNT(*) FROM hs_decision_ledger UNION ALL SELECT 'master', COUNT(*) FROM hs_code_master UNION ALL SELECT 'currency', COUNT(*) FROM currency_mapping UNION ALL SELECT 'city', COUNT(*) FROM city_mapping UNION ALL SELECT 'source', COUNT(*) FROM source_company_mapping UNION ALL SELECT 'country', COUNT(*) FROM country_origin_mapping;"
```
Expected: row counts matching xlsx source files (master ~10k, currency 14, city 329, source 207, country 105).

---

### 1.4 FAISS index build
- Embed all `hs_code_master.description_en` rows
- Save FAISS index to `hs_master_faiss.index`
- Save parallel codes list to `hs_codes.json`

**Verify:**
```bash
python -c "
import faiss, json
idx = faiss.read_index('hs_master_faiss.index')
codes = json.load(open('hs_codes.json'))
print(f'Index vectors: {idx.ntotal}, Codes list: {len(codes)}')
assert idx.ntotal == len(codes), 'MISMATCH'
print('FAISS index OK')
"
```

---

### 1.5 Invoice parser
- `invoice_parser.py` — read xlsx/csv, yield cleaned row dicts
- Coerce types (float, int), strip whitespace
- Group by WayBillNo

**Verify:**
```bash
python -c "
from invoice_parser import parse_invoice
rows = parse_invoice('data/sample_invoice.xlsx')
print(f'Rows: {len(rows)}')
print(f'Fields: {list(rows[0].keys())}')
print(f'WayBill sample: {rows[0][\"WayBillNo\"]}')
print(f'Types — Quantity: {type(rows[0][\"Quantity\"])}, Amount: {type(rows[0][\"Amount\"])}')
"
```
Expected: rows parsed, types coerced, no whitespace in string fields.

---

## Phase 2 — Resolution Engine (test each path independently)

### 2.1 LLM abstract interface
- `llm/base.py` — `HSReasoner` ABC with `rank_candidates`, `infer_hs_code`, `translate_to_arabic`

**Verify:**
```bash
python -c "
from llm.base import HSReasoner
import inspect
methods = [m for m in dir(HSReasoner) if not m.startswith('_')]
print(f'Abstract methods: {methods}')
assert 'rank_candidates' in methods
assert 'infer_hs_code' in methods
assert 'translate_to_arabic' in methods
print('Interface OK')
"
```

---

### 2.2 API backend (Anthropic)
- `llm/api_backend.py` — implements HSReasoner using Anthropic SDK
- `rank_candidates` uses Sonnet, `infer_hs_code` uses Opus
- JSON structured output with `hs_code` + `confidence`

**Verify:**
```bash
python -c "
from llm.api_backend import APIReasoner
r = APIReasoner()
# Test ranking with known candidates
code, conf = r.rank_candidates(
    candidates=[
        {'hs_code': '620442000000', 'arabic_name': 'فساتين', 'description_en': 'womens dresses of cotton'},
        {'hs_code': '620443000000', 'arabic_name': 'فساتين', 'description_en': 'womens dresses of synthetic fibres'}
    ],
    description='ladies cotton dress casual wear'
)
print(f'Ranked: {code} @ {conf}')
assert len(code) == 12 and 0 <= conf <= 1
print('API Ranker OK')
"
```

---

### 2.3 Local backend (Ollama)
- `llm/local_backend.py` — implements HSReasoner using Ollama
- Same prompts, different models

**Verify:**
```bash
# Requires: ollama pull phi3-mini
python -c "
from llm.local_backend import LocalReasoner
r = LocalReasoner()
code, conf = r.rank_candidates(
    candidates=[
        {'hs_code': '620442000000', 'arabic_name': 'فساتين', 'description_en': 'womens dresses of cotton'},
        {'hs_code': '620443000000', 'arabic_name': 'فساتين', 'description_en': 'womens dresses of synthetic fibres'}
    ],
    description='ladies cotton dress casual wear'
)
print(f'Ranked: {code} @ {conf}')
print('Local Ranker OK')
"
```

---

### 2.4a Resolver — Path 1: Ledger lookup
- Implement `resolve()` with ledger path only
- Exact match on (client_id, normalized_code) returns confidence 1.0

**Verify:**
```bash
python -c "
from hs_resolver import resolve
# Insert a known ledger entry first
import sqlite3
from config import DB_PATH
conn = sqlite3.connect(DB_PATH)
conn.execute(\"INSERT OR REPLACE INTO hs_decision_ledger VALUES ('TEST01', '6204', '620442000000', 'فساتين', 'human_verified', '2026-01-01')\")
conn.commit()
conn.close()

result = resolve({'ClientID': 'TEST01', 'CustomsCommodityCode': '6204', 'Description': 'test', 'ChineseDescription': '', 'SKU': ''})
print(f'Path: {result.path}, Code: {result.hs_code}, Confidence: {result.confidence}')
assert result.path == 'ledger' and result.confidence == 1.0
print('PATH 1 LEDGER OK')
"
```

---

### 2.4b Resolver — Path 2: Direct 12-digit lookup
- 12-digit code found in hs_code_master = confidence 0.98
- 12-digit code NOT found = fall through to Path 4

**Verify:**
```bash
python -c "
from hs_resolver import resolve
# Use a known 12-digit code from hs_code_master
result = resolve({'ClientID': 'UNKNOWN', 'CustomsCommodityCode': '620442000000', 'Description': 'test', 'ChineseDescription': '', 'SKU': ''})
print(f'Path: {result.path}, Code: {result.hs_code}, Confidence: {result.confidence}')
assert result.path == 'direct' and result.confidence == 0.98
print('PATH 2 DIRECT OK')
"
```

---

### 2.4c Resolver — Path 3: Prefix traversal + Ranker
- 4-11 digit code, find candidates by prefix in master
- 1 candidate = deterministic (0.95)
- 2-15 candidates = call Ranker
- 15+ or 0 candidates = fall through to Path 4

**Verify:**
```bash
python -c "
from hs_resolver import resolve
# Test with a prefix that yields exactly 1 candidate (deterministic)
result = resolve({'ClientID': 'UNKNOWN', 'CustomsCommodityCode': '62044200', 'Description': 'dress', 'ChineseDescription': '', 'SKU': ''})
print(f'Path: {result.path}, Code: {result.hs_code}, Confidence: {result.confidence}')
# Should be prefix_deterministic or prefix_ranked depending on candidate count
assert result.path in ('prefix_deterministic', 'prefix_ranked')
print('PATH 3 PREFIX OK')
"
```

---

### 2.4d Resolver — Path 4: Reasoner (FAISS + LLM)
- Build search text from Description + ChineseDescription + SKU
- FAISS top-10 candidates → Reasoner LLM call
- Returns inferred code with confidence

**Verify:**
```bash
python -c "
from hs_resolver import resolve
# No code at all — forces Reasoner path
result = resolve({'ClientID': 'UNKNOWN', 'CustomsCommodityCode': '', 'Description': 'wireless bluetooth earbuds charging case', 'ChineseDescription': '无线蓝牙耳机', 'SKU': 'BT-EARBUDS-001'})
print(f'Path: {result.path}, Code: {result.hs_code}, Confidence: {result.confidence}')
assert result.path == 'reasoner'
assert len(result.hs_code) == 12
print('PATH 4 REASONER OK')
"
```

---

### 2.5 Lookup engine
- `lookup_engine.py` — currency, city, source company, country origin, transport type, doc ref
- Each lookup independently testable

**Verify:**
```bash
python -c "
from lookup_engine import run_all_lookups
# Test with a known ClientID
result = run_all_lookups(
    row={'CurrencyCode': 'USD', 'ClientID': 'TEST01', 'ConsigneeAddress': 'Riyadh', 'MobileNo': '1234567890'},
    declaration_rows=[]
)
print(f'Currency: {result.tabdul_currency}')
print(f'City: {result.city_cd} / {result.city_arabic}')
print(f'Source: {result.source_company}')
print(f'Country: {result.country_origin}')
print(f'Transport type: {result.transport_type}')
print(f'DocRefNo: {result.doc_ref_no}')
print('LOOKUPS OK')
"
```

---

### 2.6 Arabic translation engine
- `arabic_translation_engine.py` — resolve Arabic name from master, fallback to LLM translation

**Verify:**
```bash
python -c "
from arabic_translation_engine import resolve_arabic
from llm.api_backend import APIReasoner
# Test with a code that has arabic_name in master
arabic = resolve_arabic('620442000000', 'womens cotton dresses', APIReasoner())
print(f'Arabic: {arabic}')
assert arabic and len(arabic) > 0
print('ARABIC TRANSLATION ENGINE OK')
"
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
