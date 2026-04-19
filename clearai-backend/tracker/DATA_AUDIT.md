# Naqel Data Audit

> Assessment of the data files received from Naqel against BUILD.md requirements.
> Date: 2026-04-16

---

## Files received

| File | Size | Purpose |
|------|------|---------|
| `Naqel_HS_code_mapping_lookup.xlsx` | 32 KB | Historical HS code decisions (ledger seed) |
| `Zatca Tariff codes.xlsx` | 1.1 MB | HS Code Master (ZATCA official tariff) |
| `HS Code Mapping - Logic.xlsx` | 17 KB | Worked example of the resolution algorithm |
| `Naqel (Fields details + Mapping data).xlsx` | 140 KB | Field mappings + 6 lookup sheets |

---

## Coverage vs BUILD.md requirements

### ✅ `hs_decision_ledger` — COVERED
**Source:** `Naqel_HS_code_mapping_lookup.xlsx`
**Rows:** 500
**Columns:** `ClientHSCode`, `HSCode`, `UnitPerPrice`, `ArbName`
**Mapping:**
- `ClientHSCode` → `raw_code`
- `HSCode` → `verified_code` (12-digit)
- `ArbName` → `arabic_name`
- `UnitPerPrice` → **bonus field** (not in original schema, but used by `InvoiceItem.UnitInvoiceCost` logic)
- **Missing:** `ClientID` column. All ledger entries appear global (not per-client). Need to decide: store with `client_id = NULL` or `client_id = '*'` for global entries.

---

### ✅ `hs_code_master` — COVERED
**Source:** `Zatca Tariff codes.xlsx` (sheet: `Grid`)
**Rows:** 19,138 (nearly 2× the expected 10k — this is the full ZATCA tariff)
**Columns:**
- `Harmonized Code` → `hs_code` (12 digits)
- `Item Arabic Name` → `arabic_name`
- `Item English Name` → `description_en` (for FAISS embedding)
- `Arabic/English Duty Rate` → `duty_rate` (parse from text)
- `Procedures`, `Date` → extra metadata

**Note:** Richer than BUILD.md expected. Duty rate field is text not numeric — will need parsing.

---

### ✅ `currency_mapping` — COVERED
**Source:** `Naqel (Fields details + Mapping data).xlsx` → sheet `CurrencyMapping`
**Rows:** 14 (matches BUILD.md)
**Columns:** `InfoTrackCurrencyId`, `TabdulCurrencyId`, `InfoTraclCurCode`
**Bonus:** Includes ISO code (`InfoTraclCurCode` = SAR, AED, etc.) — useful for SAR conversion logic.

---

### ⚠️ `city_mapping` — COVERED BUT 2-STEP
**Source:** Two sheets needed for the 2-step lookup described in BUILD.md:
1. `CityMaping` (329 rows): `TabdulCityId` ↔ `InfoCityId`
2. `Tabdul City` (2,169 rows): `CITY_CD`, `CITY_ARB_NAME`, `CITY_ENG_NAME`, `CITY_INTL_CD`, `CTRY_CD`

**Mapping flow:**
```
DestinationStationID (InfoCityId)
    → CityMaping: InfoCityId → TabdulCityId
    → Tabdul City: CITY_CD = TabdulCityId → CITY_ARB_NAME
```
**Default `City` value when lookup fails: 131** (confirmed in ExpressMailInformation fields).

---

### ✅ `source_company_mapping` — COVERED
**Source:** `Naqel (Fields details + Mapping data).xlsx` → sheet `SourceCompanyPortMaping`
**Rows:** 207 (matches BUILD.md)
**Columns:** `SourceCompanyName`, `SourceCompanyNo`, `ClientID`, `CustRegPortCode`
**Fallback:** `ClientID = -1, CustRegPortCode = 23 → "ناقل", SourceCompanyNo 340476` — confirmed explicit in data.

---

### ✅ `country_origin_mapping` — COVERED
**Source:** `Naqel (Fields details + Mapping data).xlsx` → sheet `CountryOfOriginClientMapping`
**Rows:** 105 (matches BUILD.md)
**Columns:** `ClientID`, `Countryoforigin`
**Note:** `Countryoforigin` is a numeric country code (e.g. 145). Need to join to `Tabadul CountryCode` sheet to get `INTLCODE` (2-letter ISO like "CN") per `InvoiceItem.CountryOfOrigin` field spec.

---

### 🎁 BONUS: `country_code_mapping` — NOT IN BUILD.md BUT PROVIDED
**Source:** `Naqel (Fields details + Mapping data).xlsx` → sheet `Tabadul CountryCode`
**Rows:** 308
**Columns:** `CountryCode`, `Name` (Arabic), `FName` (English), `INTLCODE` (2-letter ISO)
**Purpose:** Required to translate `country_origin_mapping.Countryoforigin` (numeric) → ISO code used in XML.
**Action:** Add new table `country_code_mapping` to schema.

---

### 🎁 BONUS: Resolution algorithm worked example
**Source:** `HS Code Mapping - Logic.xlsx`
**Content:** Step-by-step worked example showing:
1. Strip non-digits from client code
2. Generate prefix variants (61082100, 6108210, 610821, 61082, 6108)
3. Match all variants against HSCode master
4. Order by `LEN(ClientHSCode) DESC, LEN(HSCode) ASC`
5. Take first row

**This changes the BUILD.md prefix traversal logic** — Naqel does NOT use a candidate-count threshold. They use a **longest-prefix-wins** deterministic algorithm. This is more deterministic and cheaper than the LLM Ranker. Recommend aligning with Naqel's approach.

---

### 🎁 BONUS: Field mapping sheets
**Source:** `Naqel (Fields details + Mapping data).xlsx`
- `ExpressMailInfomation - Fields` (12 rows)
- `Invoice - Fields` (15 rows)
- `InvoiceItem - Fields` (15 rows)

**Purpose:** Documents the **exact XML field names** and value derivations Naqel expects. This closes **Blocker B2 (Real Bayan XSD)** partially — we now have the authoritative field list with source mappings.

Key confirmations from these sheets:
- **B4 Transport ID rule confirmed:** "If consignee National ID start with 1 → TransportTypeID=5, starts with 2 → TransportTypeID=3"
- `City` default value when lookup fails = 131
- `ZipCode` = 111, `POB` = 11 (hardcoded defaults)
- `AddCountryCode` = 100, `Country` = 100 (hardcoded for KSA)
- `InvoiceMeasurementUnit` = 7 (hardcoded)
- `GrossWeight` per item = `Waybill.weight / items.count`
- `TransportID` = Consignee National ID (NOT phone — this was a BUILD.md assumption)

---

## Blockers resolved by data

| ID | Blocker | Status | Resolution |
|----|---------|--------|------------|
| B1 | Data files not in `data/` | ✅ **RESOLVED** | All 4 files received |
| B2 | Real Bayan XSD | ⚠️ **PARTIAL** | Field names known via `Naqel (Fields details)` sheets — sufficient to build; real XSD still ideal for validation |
| B4 | Transport ID type rule | ✅ **RESOLVED** | National ID 1→5, 2→3. Source: consignee NatID, not phone |
| B5 | `DestinationStationID` field mapping | ✅ **RESOLVED** | Maps to `InfoCityId` in `CityMaping` sheet |
| B6 | Prefix candidate threshold | ✅ **RESOLVED** | Naqel uses longest-prefix-wins, not candidate count |

## Blockers still open

| ID | Blocker | Status |
|----|---------|--------|
| B3 | SAR conversion rates for HV/LV tier | Still open — decide static vs live API |
| B7 | Sample invoice file for end-to-end test | NEW — need a real merchant invoice |
| B8 | Baseline XML for comparator validation | NEW — need reference XML output |

---

## Verdict

**We can start building immediately.** The received data covers 6/6 required tables plus 2 bonus tables (country codes, field specs) that resolve 4 of 5 previously open blockers.

The only remaining implementation-critical question is **SAR conversion rates (B3)** — and that doesn't block Phase 1 or most of Phase 2. We can ship with a static table of major currency rates for V1.

## Recommended schema adjustments

Based on the data:

1. **Make `client_id` nullable** in `hs_decision_ledger` (ledger seed is global)
2. **Add `unit_per_price` column** to `hs_decision_ledger` AND `hs_code_master` (used by InvoiceItem logic)
3. **Add `country_code_mapping` table** for numeric → ISO translation
4. **Store both sheets from city mapping** as `city_mapping_bridge` (InfoCityId → TabdulCityId) and `tabdul_city` (main city data)
5. **Align `hs_resolver` prefix logic** with Naqel's longest-prefix-wins approach (cheaper than LLM Ranker)
