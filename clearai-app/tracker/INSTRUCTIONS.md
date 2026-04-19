# ClearAI — Implementation Instructions

> Ground rules and conventions to follow throughout the entire build.
> Re-read this before starting any new phase.

---

## Architecture Principles

1. **Single-machine Python CLI.** Everything runs on the developer's machine. The only external service call is the Anthropic API. V1 is API-only — no local inference, no Ollama. See ADR-004.

2. **SQLite as the single data store.** All mapping tables live in one `.db` file. No Postgres, no Redis, no file-based lookups at runtime.

3. **Three-tier model split.** The `HSReasoner` interface exposes one Anthropic-backed implementation. Flexibility comes from per-task model choice — three tiers, configured via env vars:
   - `TRANSLATION_MODEL` (default Haiku) — Arabic description translation fallback. Very narrow task; cheapest tier is enough.
   - `RANKER_MODEL` (default Sonnet) — candidate ranking when prefix traversal returns multiple plausible matches. Needs comparison judgement; middle tier.
   - `REASONER_MODEL` (default Opus) — full HS inference from a free-text description. Only runs when deterministic paths fail (~2.5% of rows). Strongest tier earns its cost here.

4. **Confidence-gated output.** Every resolved HS code carries a confidence score. Below threshold = flagged for human review. Never silently output low-confidence results.

5. **Deterministic paths first.** The 4-path resolution order is deliberate: ledger > direct > prefix > reasoner. Cheaper/faster/more reliable paths run first. LLM is the last resort.

---

## Coding Conventions

- **Language:** Python 3.11+, type hints on all public functions
- **Style:** PEP 8, max line length 100
- **Imports:** stdlib > third-party > local, separated by blank lines
- **Naming:** snake_case for everything. No abbreviations except well-known ones (hs, xml, db)
- **Error handling:** Fail loud on setup errors (bad data files, missing config). Fail graceful on per-row processing (log + flag, don't crash)
- **Logging:** Use stdlib `logging` module. One logger per module. INFO for flow, DEBUG for detail, WARNING for fallbacks, ERROR for failures.

---

## File-by-File Build Order

Follow this order strictly. Each file depends only on files above it.

```
1. config.py              — no dependencies
2. db/setup.py            — depends on config
3. invoice_parser.py      — depends on config
4. llm/base.py            — no dependencies
5. llm/api_backend.py     — depends on base, config (Anthropic-only; V1 has no local backend)
6. hs_resolver.py         — depends on config, llm/*, db
7. lookup_engine.py       — depends on config, db
8. arabic_translation_engine.py — depends on config, llm/base, db
9. xml_builder.py         — depends on config
10. templates/declaration.xml.j2  — no code deps
11. run.py                — depends on everything
12. comparator.py         — depends on xml_builder
13. db/write_verified.py  — depends on config, db
14. tests/test_resolver.py — depends on hs_resolver
```

---

## Data Handling Rules

- **Never modify source xlsx files.** Read-only. All writes go to SQLite or output/.
- **Normalize HS codes immediately.** Strip non-digits on input. All internal comparisons use normalized codes.
- **`CountryofManufacture` from Excel != `countryOfOrigin` in XML.** Origin always comes from `CountryOfOriginClientMapping` keyed by `ClientID`.
- **Source company fallback is `"ناقل"`.** If no mapping found for (client_id, port_code), use this default.

---

## LLM Prompt Rules

- Always request JSON responses with `hs_code` and `confidence` fields
- **Ranker** prompts: structured candidate list, ask for best match. Use `RANKER_MODEL` (Sonnet, middle tier).
- **Reasoner** prompts: include description, GRI rules context, FAISS candidates, Naqel bucket hint. Use `REASONER_MODEL` (Opus, top tier).
- **Arabic translation**: use tariff-specific terminology, not casual translation. Use `TRANSLATION_MODEL` (Haiku, cheapest tier) — this is a narrow task, no need for Sonnet or Opus.
- Set temperature to 0 for deterministic outputs
- Include system prompt establishing HS classification domain context

---

## Testing Strategy

- Unit tests for each resolution path (ledger, direct, prefix, reasoner)
- Mock LLM calls in tests — use fixture responses
- End-to-end test with a known invoice → compare against expected XML
- Comparator validation against Naqel baseline XMLs

---

## Open Questions to Resolve

Track these in PROGRESS.md blockers section. Do not implement assumptions — flag and ask.

1. ~~Real Bayan XSD tag names~~ — **Resolved** via baseline XMLs (see DATA_INVENTORY below)
2. SAR conversion approach (static vs live) — **still open** for V1 tier calc
3. ~~`DestinationStationID` field mapping~~ — **Resolved** (`InfoCityId` → `TabdulCityId`)
4. ~~Transport ID type rule confirmation~~ — **Resolved** (NatID prefix 1→5, 2→3)
5. ~~`PREFIX_RANKER_MAX_CANDIDATES` threshold~~ — **Resolved** (longest-prefix-wins, no threshold)

---

## Data Inventory — Where to Look and What For

All source data lives in `clearai-app/data/`. Re-read this section before building
any module that touches source data. The files are **read-only**; load into SQLite
at setup time, never at runtime.

### Mapping tables (load into SQLite)

| File | Purpose | Loads into |
|------|---------|------------|
| `Naqel_HS_code_mapping_lookup.xlsx` | 500 historical HS decisions (ledger seed) | `hs_decision_ledger` |
| `Zatca Tariff codes.xlsx` | 19,138 official ZATCA tariff codes + Arabic/English names + duty rates | `hs_code_master` |
| `Naqel (Fields details + Mapping data).xlsx` | Multi-sheet: currency, city, source company, country origin + XML field specs | Multiple tables (see per-sheet breakdown in DATA_AUDIT.md) |
| `HS Code Mapping - Logic.xlsx` | **Reference only** — worked example of the longest-prefix-wins algorithm | Do not load; use as implementation reference |

### Sample input (for Phase 4.2 end-to-end test)

| File | Purpose |
|------|---------|
| `client_commercial_invoices_sample2.xlsx` | **Real merchant invoice sample** (30 MB, ~50k rows, 3,020 unique waybills). Use this for Phase 4.2 E2E test. Columns match BUILD.md spec exactly (WayBillNo, InvoiceDate, Consignee, ConsigneeAddress, ConsigneeEmail, MobileNo, Phone, TotalCost, CurrencyCode, ClientID, Quantity, UnitType, CountryofManufacture, Description, CustomsCommodityCode, UnitCost, Amount, Currency, ChineseDescription, SKU, CPC). |
| `client_commercial_invoices_API_Request_template.xml` | **SOAP API request template** showing the single-waybill shape Naqel's API accepts. Use this to understand the live integration path — reference only, not the pipeline input. |

### Baseline XML output (for Phase 4.3 comparator validation)

**Location:** `data/Baseline XML output/` (5 examples)

| File | Type | Purpose |
|------|------|---------|
| `NQD26030942060.XML` | Full declaration (51 items) | Baseline for comparator |
| `NQD26030942061.XML` | Full declaration | Baseline for comparator |
| `NQD26030942062.XML` | Full declaration | Baseline for comparator |
| `post-processed item 1 (NQD26033110789).XML` | Single-item (post-processed) | Baseline for comparator |
| `post-processed item 2 (NQD26033110790).XML` | Single-item (post-processed) | Baseline for comparator |

### Bayan XML schema (extracted from baselines — CRITICAL)

The baseline XMLs reveal the **real** ZATCA/SaudiEDI schema. Update `templates/declaration.xml.j2` to match exactly — do NOT use the placeholder schema in BUILD.md.

**Root namespaces:**
```
xmlns:decsub="http://www.saudiedi.com/schema/decsub"
xmlns:deccm="http://www.saudiedi.com/schema/deccm"
xmlns:sau="http://www.saudiedi.com/schema/sau"
xmlns:cm="http://www.saudiedi.com/schema/common"
xmlns:deckey="http://www.saudiedi.com/schema/deckey"
```

**Root element:** `<decsub:saudiEDI decsub:docType="DEC" decsub:id="{docRefNo}" decsub:msgType="H2HDECSUB">`

**Structural sections** (in order):
1. `decsub:reference` — userid, acctId, docRefNo, regPort
2. `decsub:senderInformation` — brokerLicenseType, brokerLicenseNo, brokerRepresentativeNo
3. `decsub:declarationHeader` — declarationType, finalCountry, inspectionGroupID, paymentMethod, totalNoOfInvoice
4. `decsub:invoices` — invoiceSeqNo, invoiceType, invoiceNo, totalNoItems, invoiceCost, invoiceCurrency, totalGrossWeight, totalNetWeight, sourceCompany block, deal, paymentInfo block, then repeated `decsub:items` blocks
5. Per `decsub:items` — itemSeqNo, countryOfOrigin, tariffCode, goodsDescription, invoiceMeasurementUnit, quantityInvoiceUnit, internationalMeasurementUnit, quantityInternationalUnit, grossWeight, netWeight, unitPerPackages, unitInvoiceCost (conditional), itemCost, itemDutyType

**Namespace prefix rule:**
- `decsub:` for top-level declaration structure, reference, items wrapper
- `deccm:` for item-level fields and common invoice fields
- `sau:` for payload wrapper
- `cm:` for type attribute on regPort

**Observed constants in baselines (likely hardcoded or configured):**
- `userid`: `uwqfr002`, `uwqfr003` (broker-specific)
- `acctId`: `uwqf`
- `regPort cm:type="4"`: value `23`
- `brokerLicenseType`: `5`
- `brokerLicenseNo`: `1`
- `brokerRepresentativeNo`: `1732`, `1749` (varies)
- `declarationType`: `2`
- `finalCountry`: `SA`
- `inspectionGroupID`: `10`
- `paymentMethod`: `1`
- `invoiceType`: `5`
- `invoiceMeasurementUnit`: `7`
- `itemDutyType`: `1`
- `unitPerPackages`: `1`
- `deal`: `1`

These constants should go into `config.py` as `BAYAN_CONSTANTS` dict, not hardcoded in the template.

### Files NOT to commit

Add to `.gitignore`:
```
clearai-app/data/*.xlsx
clearai-app/data/*.XML
clearai-app/data/*.xml
clearai-app/data/Baseline XML output/
clearai-app/output/
clearai-app/*.db
clearai-app/*.index
clearai-app/hs_codes.json
.env
```

Keep in git:
- `clearai-app/data/.gitkeep` (placeholder)
- `clearai-app/data/README.md` (explains what should live here)

---

## Git Conventions

- Branch per phase: `phase-1/foundation`, `phase-2/resolution`, etc.
- Commit messages: `[phase] step: description` (e.g., `[1] 1.3: load xlsx mapping files into SQLite`)
- No large data files in git — add `data/` to `.gitignore`
- Tag working milestones: `v0.1-foundation`, `v0.2-resolution`, etc.
