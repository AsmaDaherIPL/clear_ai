# Clear AI — V1 Build Instructions

> Feed this file to Claude Code as the starting point. It covers everything needed to build the first working version of the HS resolution pipeline: project layout, data loading, the four resolution paths, all lookups, XML output, and the pluggable LLM interface.

---

## What you are building

A Python CLI that reads a merchant invoice file (`.xlsx` or `.csv`), resolves every line item to a valid 12-digit Saudi HS code, fills in all required customs fields using lookup tables, and writes ZATCA-compliant XML declarations per waybill.

No UI. No server. No cloud dependency at runtime. Everything runs locally.

---

## Project layout

```
clear_ai/
├── run.py                    # entry point
├── config.py                 # thresholds, paths, LLM_BACKEND setting
├── invoice_parser.py         # reads xlsx/csv, yields rows
├── hs_resolver.py            # 4-path resolution logic
├── lookup_engine.py          # all static table joins
├── arabic_engine.py          # Arabic description resolution
├── xml_builder.py            # Jinja2 → ZATCA XML
├── comparator.py             # optional diff vs baseline XML
├── llm/
│   ├── base.py               # HSReasoner abstract interface
│   ├── api_backend.py        # Sonnet / Opus / GPT-4o via API
│   └── local_backend.py      # Ollama local models
├── db/
│   └── setup.py              # loads all xlsx mapping files into SQLite
├── templates/
│   └── declaration.xml.j2    # Jinja2 ZATCA XML template
├── data/                     # place mapping xlsx files here
│   ├── Naqel_HS_code_mapping_lookup.xlsx
│   ├── HSCodeMaster.xlsx
│   ├── CurrencyMapping.xlsx
│   ├── CityMaping.xlsx
│   ├── SourceCompanyPortMaping.xlsx
│   └── CountryOfOriginClientMapping.xlsx
├── output/                   # generated XML, review.csv, audit.log
└── tests/
    └── test_resolver.py
```

---

## Dependencies

```
pandas
openpyxl
jinja2
sqlite3          # stdlib
faiss-cpu
sentence-transformers
ollama           # only needed for local backend
anthropic        # only needed for API backend
python-dotenv
```

Install: `pip install pandas openpyxl jinja2 faiss-cpu sentence-transformers anthropic python-dotenv ollama`

---

## Config (`config.py`)

```python
import os
from dotenv import load_dotenv
load_dotenv()

LLM_BACKEND         = os.getenv("LLM_BACKEND", "api")     # "api" or "local"
CONFIDENCE_THRESHOLD = float(os.getenv("CONFIDENCE_THRESHOLD", "0.75"))
PREFIX_RANKER_MAX_CANDIDATES = 15   # above this, skip Ranker and go to Reasoner
HV_THRESHOLD_SAR    = 1000.0

# API backend
ANTHROPIC_API_KEY   = os.getenv("ANTHROPIC_API_KEY", "")
RANKER_API_MODEL    = "claude-sonnet-4-6"      # fast, cheap, good for ranking
REASONER_API_MODEL  = "claude-opus-4-6"        # strongest reasoning for GRI inference

# Local backend (Ollama)
RANKER_LOCAL_MODEL  = "phi3-mini"
REASONER_LOCAL_MODEL = "llama3:70b"
OLLAMA_BASE_URL     = "http://localhost:11434"

DB_PATH             = "clear_ai.db"
FAISS_INDEX_PATH    = "hs_master_faiss.index"
OUTPUT_DIR          = "output"
```

---

## Step 1 — Database setup (`db/setup.py`)

Run once before first use: `python db/setup.py`

Load every mapping xlsx file into a single SQLite database at `DB_PATH`.

### Tables to create

**`hs_decision_ledger`**
```sql
CREATE TABLE hs_decision_ledger (
  client_id       TEXT,
  raw_code        TEXT,
  verified_code   TEXT NOT NULL,
  arabic_name     TEXT,
  provenance      TEXT DEFAULT 'human_verified',
  created_at      TEXT
);
CREATE UNIQUE INDEX idx_ledger ON hs_decision_ledger(client_id, raw_code);
```
Source: `Naqel_HS_code_mapping_lookup.xlsx`
Key columns to map: whatever columns represent the merchant's original code and the verified 12-digit code. Inspect the file — there will be a "from" code column and a "to" verified code column.

**`hs_code_master`**
```sql
CREATE TABLE hs_code_master (
  hs_code       TEXT PRIMARY KEY,   -- 12 digits
  arabic_name   TEXT,
  duty_rate     REAL,
  description_en TEXT               -- for FAISS embedding
);
```
Source: `HSCodeMaster.xlsx` (~10,000 rows)

**`currency_mapping`**
```sql
CREATE TABLE currency_mapping (
  infotrack_currency_id  TEXT PRIMARY KEY,
  tabdul_currency_id     TEXT NOT NULL
);
```
Source: `CurrencyMapping.xlsx` (14 rows)

**`city_mapping`**
```sql
CREATE TABLE city_mapping (
  station_id    TEXT,
  city_name     TEXT,
  city_cd       TEXT,
  arabic_name   TEXT
);
```
Source: `CityMaping.xlsx` (329 rows). The mapping is 2-step: `DestinationStationID → city_name → CITY_CD + arabic_name`. Inspect the actual columns in the file and map accordingly.

**`source_company_mapping`**
```sql
CREATE TABLE source_company_mapping (
  client_id         TEXT,
  cust_reg_port_code TEXT,
  source_company    TEXT
);
CREATE UNIQUE INDEX idx_source ON source_company_mapping(client_id, cust_reg_port_code);
```
Source: `SourceCompanyPortMaping.xlsx` (207 rows). Fallback value: `"ناقل"`

**`country_origin_mapping`**
```sql
CREATE TABLE country_origin_mapping (
  client_id      TEXT PRIMARY KEY,
  country_origin TEXT
);
```
Source: `CountryOfOriginClientMapping.xlsx` (105 rows)

### Build FAISS index

After loading `hs_code_master`, embed `description_en` for every row using `sentence-transformers` (`all-MiniLM-L6-v2` is sufficient) and save the FAISS index to `FAISS_INDEX_PATH`. Store a parallel list of hs_codes in the same order as the index so you can retrieve the code by index position.

```python
# pseudo
from sentence_transformers import SentenceTransformer
import faiss, numpy as np

model = SentenceTransformer("all-MiniLM-L6-v2")
rows = db.execute("SELECT hs_code, description_en FROM hs_code_master").fetchall()
codes = [r[0] for r in rows]
texts = [r[1] for r in rows]
embeddings = model.encode(texts, show_progress_bar=True)
index = faiss.IndexFlatL2(embeddings.shape[1])
index.add(np.array(embeddings))
faiss.write_index(index, FAISS_INDEX_PATH)
# also save codes list as codes.json
```

---

## Step 2 — Invoice parser (`invoice_parser.py`)

```python
def parse_invoice(filepath: str) -> list[dict]:
    """
    Read xlsx or csv. Return list of row dicts with original field names preserved.
    Required fields:
        WayBillNo, InvoiceDate, Consignee, ConsigneeAddress, ConsigneeEmail,
        MobileNo, Phone, TotalCost, CurrencyCode, ClientID, Quantity, UnitType,
        CountryofManufacture, Description, CustomsCommodityCode,
        UnitCost, Amount, Currency, ChineseDescription, SKU, CPC
    Strip whitespace from all string fields.
    Coerce TotalCost, UnitCost, Amount to float. Coerce Quantity to int.
    """
```

Group rows by `WayBillNo` after parsing. Each group is one declaration.

---

## Step 3 — HS resolver (`hs_resolver.py`)

This is the core of the product. Implement `resolve(row: dict) -> ResolveResult`.

```python
@dataclass
class ResolveResult:
    hs_code: str
    arabic_name: str
    confidence: float
    path: str           # "ledger" | "direct" | "prefix_deterministic" | "prefix_ranked" | "reasoner"
    flag_for_review: bool = False
```

### Normalize the code first

```python
def normalize_code(raw: str) -> str:
    if not raw:
        return ""
    return re.sub(r"[^0-9]", "", str(raw).strip())
```

### Resolution logic — implement in this exact order

```
1. Ledger lookup
   key = (row["ClientID"], normalized_code)
   hit → return with confidence 1.0, path="ledger"

2. 12-digit direct lookup
   if len(code) == 12:
       hit in hs_code_master → confidence 0.98, path="direct"
       miss → fall through to step 4 (malformed code)

3. Prefix traversal  (only if 4 <= len(code) <= 11)
   candidates = all hs_code_master rows where hs_code starts with code
   
   if len(candidates) == 0:
       fall through to step 4
   
   elif len(candidates) == 1:
       return confidence 0.95, path="prefix_deterministic"
   
   elif len(candidates) <= PREFIX_RANKER_MAX_CANDIDATES (default 15):
       call Ranker
       if ranker_confidence >= 0.70 AND (top_score - second_score) > 0.05:
           return path="prefix_ranked"
       else:
           fall through to step 4 (too ambiguous for Ranker)
   
   else:  # > 15 candidates, too broad (typical at 4-5 digit heading level)
       fall through to step 4

4. Reasoner (full inference)
   build_search_text from Description + ChineseDescription + SKU
   faiss_hits = faiss_index.search(search_text, top_k=10)
   call Reasoner with faiss_hits as candidate context
   return path="reasoner"
```

---

## Step 4 — LLM interface (`llm/base.py`)

Define the abstract interface. Both backends must implement it.

```python
from abc import ABC, abstractmethod

class HSReasoner(ABC):

    @abstractmethod
    def rank_candidates(
        self,
        candidates: list[dict],   # list of {hs_code, arabic_name, description_en}
        description: str,
        sku: str = ""
    ) -> tuple[str, float]:
        """
        Returns (best_hs_code, confidence_score).
        Used in PATH 2 prefix traversal when multiple candidates exist.
        """

    @abstractmethod
    def infer_hs_code(
        self,
        description: str,
        chinese_description: str,
        candidates: list[dict],   # top-K from FAISS
        gri_rules: list[str] = ["3a", "3b", "6"]
    ) -> tuple[str, float]:
        """
        Returns (inferred_hs_code, confidence_score).
        Used in PATH 3 when no code or no candidates found.
        """

    @abstractmethod
    def translate_to_arabic(self, description: str) -> str:
        """
        Returns Arabic description.
        Used when hs_code_master has no arabic_name for the resolved code.
        """
```

### API backend (`llm/api_backend.py`)

Use the Anthropic SDK. For `rank_candidates`, prompt Sonnet with a structured list of candidates and ask it to pick the best match with a confidence score. For `infer_hs_code`, prompt Opus with the description, GRI rules context, and the top-K FAISS candidates and ask for the best 12-digit code with reasoning. Ask the model to respond in JSON with fields `hs_code` and `confidence`.

### Local backend (`llm/local_backend.py`)

Use the `ollama` Python library. Same prompts, different models. `rank_candidates` → `RANKER_LOCAL_MODEL`. `infer_hs_code` → `REASONER_LOCAL_MODEL`.

### Factory

```python
# hs_resolver.py
from config import LLM_BACKEND
from llm.api_backend import APIReasoner
from llm.local_backend import LocalReasoner

def get_reasoner() -> HSReasoner:
    if LLM_BACKEND == "api":
        return APIReasoner()
    return LocalReasoner()
```

---

## Step 5 — Lookup engine (`lookup_engine.py`)

All pure SQLite queries. No LLM calls here.

```python
def run_all_lookups(row: dict, declaration_rows: list[dict]) -> LookupResult:

    # Currency
    tabdul_currency = db.get("SELECT tabdul_currency_id FROM currency_mapping
                              WHERE infotrack_currency_id = ?", row["CurrencyCode"])

    # City (2-step via ConsigneeAddress or DestinationStationID if present)
    city = db.get("SELECT city_cd, arabic_name FROM city_mapping
                   WHERE station_id = ? OR city_name LIKE ?", ...)

    # Source company
    source_company = db.get("SELECT source_company FROM source_company_mapping
                              WHERE client_id = ? AND cust_reg_port_code = ?",
                              row["ClientID"], declaration.CustRegPortCode)
                    or "ناقل"

    # Country of origin (from ClientID, NOT from CountryofManufacture)
    country_origin = db.get("SELECT country_origin FROM country_origin_mapping
                              WHERE client_id = ?", row["ClientID"])

    # Transport ID type
    national_id = str(row.get("MobileNo") or row.get("Phone") or "")
    transport_type = "5" if national_id.startswith("1") else "3"

    # DocRefNo
    doc_ref_no = "NQD" + datetime.today().strftime("%y%m%d") + next_sequence()

    return LookupResult(...)
```

**Important:** `CountryofManufacture` from the Excel input is NOT the `countryOfOrigin` in the XML. The XML value always comes from `CountryOfOriginClientMapping` keyed by `ClientID`. Ignore `CountryofManufacture` for XML output.

---

## Step 6 — Arabic engine (`arabic_engine.py`)

```python
def resolve_arabic(hs_code: str, description: str, reasoner: HSReasoner) -> str:
    row = db.get("SELECT arabic_name FROM hs_code_master WHERE hs_code = ?", hs_code)
    if row and row["arabic_name"]:
        arabic = row["arabic_name"]
        arabic = arabic.replace("ـ", "").strip("-").strip()
        return arabic
    # fallback — translate using Ranker (tuned on master Arabic tariff terminology)
    return reasoner.translate_to_arabic(description)
```

---

## Step 7 — XML template (`templates/declaration.xml.j2`)

The ZATCA Bayan XML has 7 top-level sections. Create a Jinja2 template with the exact structure below. Fill values from resolved row data and lookup results.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomsDeclaration>

  <!-- Section 1: reference -->
  <reference>
    <docRefNo>{{ doc_ref_no }}</docRefNo>
    <wayBillNo>{{ waybill_no }}</wayBillNo>
    <declarationDate>{{ declaration_date }}</declarationDate>
  </reference>

  <!-- Section 2: senderInformation -->
  <senderInformation>
    <sourceCompany>{{ source_company }}</sourceCompany>
  </senderInformation>

  <!-- Section 3: declarationHeader -->
  <declarationHeader>
    <tier>{{ tier }}</tier>
    <countryOfOrigin>{{ country_origin }}</countryOfOrigin>
    <cpc>{{ cpc }}</cpc>
  </declarationHeader>

  <!-- Section 4: invoices (repeat per line item) -->
  <invoices>
    {% for item in items %}
    <invoice>
      <hsCode>{{ item.hs_code }}</hsCode>
      <arabicDescription>{{ item.arabic_desc }}</arabicDescription>
      <quantity>{{ item.quantity }}</quantity>
      <unitType>{{ item.unit_type }}</unitType>
      <unitCost>{{ item.unit_cost }}</unitCost>
      <amount>{{ item.amount }}</amount>
      <currency>{{ item.currency }}</currency>
    </invoice>
    {% endfor %}
  </invoices>

  <!-- Section 5: exportAirBL -->
  <exportAirBL>
    <consignee>{{ consignee }}</consignee>
    <consigneeAddress>{{ consignee_address }}</consigneeAddress>
    <cityCode>{{ city_cd }}</cityCode>
    <cityArabic>{{ city_arabic }}</cityArabic>
    <phone>{{ phone }}</phone>
  </exportAirBL>

  <!-- Section 6: declarationDocuments -->
  <declarationDocuments>
    <invoiceDate>{{ invoice_date }}</invoiceDate>
  </declarationDocuments>

  <!-- Section 7: expressMailInformation -->
  <expressMailInformation>
    <transportIdType>{{ transport_type }}</transportIdType>
  </expressMailInformation>

</CustomsDeclaration>
```

> **Note:** This template is a starting point. The actual Bayan XML schema has more required fields and specific tag names. When you have access to a real ZATCA declaration or the Bayan schema XSD, update this template to match exactly. Do not guess field names.

---

## Step 8 — Main entry point (`run.py`)

```python
python run.py --input invoice.xlsx --output ./output/
python run.py --input invoice.xlsx --output ./output/ --compare ./baseline/
```

Flow:
1. Parse invoice file
2. Group rows by `WayBillNo`
3. For each declaration:
   a. Calculate HV/LV tier from `TotalCost` + `CurrencyCode` (convert to SAR)
   b. For each row: `resolve()` → `confidence_gate()` → `resolve_arabic()` → `run_lookups()`
   c. Write `declaration_{docRefNo}.xml`
4. Write `output/review.csv` — all rows flagged by confidence gate
5. Write `output/audit.log` — one line per row: waybill, hs_code, path, confidence
6. If `--compare` passed: run `comparator.py` and write `output/diff_report.txt`

---

## Step 9 — Comparator (`comparator.py`)

```python
python comparator.py --generated ./output/ --baseline ./baseline/

# For each matching waybill XML pair:
# Parse both XMLs, compare hs_code per line item position.
# Write diff_report.txt:
#   MATCH   waybill=X item=1 hs=620442000000
#   DIFFER  waybill=X item=2 generated=610910000000 baseline=620442000000
#   MISSING waybill=X item=3 (not in generated output)
```

---

## Step 10 — Feedback loop (write-back to ledger)

After human review of `review.csv`, provide a script to write verified decisions back to the ledger:

```python
python db/write_verified.py --review-csv output/review.csv
# For each row in review.csv that has been manually filled with verified_code:
# INSERT OR REPLACE INTO hs_decision_ledger
#   (client_id, raw_code, verified_code, provenance, created_at)
#   VALUES (?, ?, ?, 'human_verified', datetime('now'))
```

---

## Open questions before coding

- **Candidate threshold:** `PREFIX_RANKER_MAX_CANDIDATES = 15` is a guess. Run the actual `Naqel_HS_code_mapping_lookup.xlsx` through prefix traversal to see how many candidates typical partial codes return. Adjust the threshold based on real data.

- **XML schema:** The Jinja2 template above is structural. Get the real Bayan XSD or a valid sample declaration from Naqel before finalising tag names.

- **CurrencyCode → SAR conversion:** For the HV/LV split, you need live or static exchange rates to convert non-SAR values to SAR. Decide: static table, or live API call?

- **`DestinationStationID` vs `ConsigneeAddress`:** The city lookup uses station ID as the primary key. Verify which field in the actual invoice maps to `DestinationStationID` — it may come from the client integration layer, not the merchant invoice directly.

- **Transport ID type rule:** The pseudocode says `NationalID[0] == "1" → type 5, "2" → type 3`. Confirm this rule with Naqel ops before coding — it may apply to consignee national ID, not phone number.

---

## How to run end to end

```bash
# 1. First-time setup
python db/setup.py   # loads all xlsx files into SQLite + builds FAISS index

# 2. Set config
export LLM_BACKEND=api
export ANTHROPIC_API_KEY=sk-...
# or for local:
# export LLM_BACKEND=local
# ollama pull phi3-mini && ollama pull llama3:70b

# 3. Run
python run.py --input data/sample_invoice.xlsx --output ./output/

# 4. Review flagged rows
open output/review.csv

# 5. Write back verified decisions
python db/write_verified.py --review-csv output/review.csv

# 6. Compare against baseline (optional)
python run.py --input data/sample_invoice.xlsx --output ./output/ --compare ./baseline/
```
