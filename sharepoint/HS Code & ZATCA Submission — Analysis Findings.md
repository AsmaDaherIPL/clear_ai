# HS Code & ZATCA Submission — Analysis Findings

**Date:** 2026-04-01
**Sources:** HS Code Mapping - Logic.xlsx · Naqel (Fields details + Mapping data).xlsx · Naqel_HS_code_mapping_lookup.xlsx · NQD26033110789.XML · NQD26033110790.XML · pre-processed (commercial invoice).xlsx · API Request - template.xml · Web Portal Client Commercial Invoice - Template.xlsx · client_commercial_invoices_sample2.xlsx

---

## 1. Executive Summary

This document captures findings from all files shared in the context folder. Together they describe the end-to-end flow for Naqel's AI customs clearance pipeline: how a client submits a commercial invoice (via API or web portal), how Naqel maps and resolves HS codes, and how a declaration is submitted to ZATCA via the SaudiEDI system. The two XML samples (NQD26033110789 and NQD26033110790) serve as concrete "before and after" examples of incomplete HS code resolution.

---

## 2. Data Sources Overview

| File | Purpose |
|---|---|
| HS Code Mapping - Logic.xlsx | Step-by-step algorithm for resolving client HS codes to a valid 12-digit ZATCA tariff code |
| Naqel (Fields details + Mapping data).xlsx | Field-level mapping spec for all ZATCA XML sections plus 4 reference lookup tables |
| Naqel_HS_code_mapping_lookup.xlsx | Pre-computed lookup of ~500 known client-to-ZATCA HS code mappings |
| NQD26033110789.XML | Post-processed ZATCA submission (Samsung phone — complete but dot-formatted HS code) |
| NQD26033110790.XML | Post-processed ZATCA submission (clothing item — incomplete 8-digit HS code) |
| pre-processed (commercial invoice).xlsx | Raw client input that generated the two XML samples above |
| client_commercial_invoices_sample2.xlsx | Larger dataset: 353,623 rows of real commercial invoice items |
| API Request - template.xml | SOAP envelope template for clients submitting via API |
| Web Portal Client Commercial Invoice - Template.xlsx | Spreadsheet template for clients submitting via web portal |

---

## 3. HS Code Processing Logic

### 3.1 The Five-Step Algorithm

When a client provides an HS code that is incomplete (fewer than 12 digits) or incorrectly formatted (contains dots, spaces, etc.), the system applies the following resolution logic:

**Step 1 — Normalize: Remove dots and special characters**
`610.821.00` → `61082100`

**Step 2 — Generate all prefix variants (down to 4 digits minimum)**
The system strips one digit at a time from the right to create candidate keys:
```
61082100
6108210
610821
61082
6108
```
Note: Any client HS code with fewer than 4 digits cannot be resolved and requires manual team intervention.

**Step 3 — Query the HSCodeMaster list for all candidates**
All candidate keys are matched against the master HS code list, returning columns: `HSCode (12-digit)`, `ArbName`, `CustomesDuty`, `CustomeProcedure`, `UnitPerPrice`, `ClientHSCode`.

**Step 4 — Sort results: longest client code match first, then shortest HS code**
SQL ordering: `ORDER BY LEN(ClientHSCode) DESC, LEN(HSCode) ASC`
This ensures the most specific match is preferred, and among equally specific matches the simplest HS code wins.

**Step 5 — Select the top row**
The first result after sorting is used as the final `tariffCode` in the ZATCA XML.

### 3.2 The Pre-Computed Lookup Table

`Naqel_HS_code_mapping_lookup.xlsx` contains ~500 pre-resolved mappings (4 columns):

| Column | Description |
|---|---|
| `ClientHSCode` | The code as provided by the client (may have dots, short digits, etc.) |
| `HSCode` | The resolved 12-digit ZATCA tariff code |
| `UnitPerPrice` | Flag (1/0) — if 1, the `unitInvoiceCost` field is populated in the XML |
| `ArbName` | Arabic description used as `goodsDescription` in the XML |

Example entries from the lookup:
- `61082100` → `620442000000` "ـ من قطن" (UnitPerPrice = 0)
- `8471301000` → `847130000003` "كمبيوتر لوحي" (UnitPerPrice = 0)
- `6403999610` → `640399100000` "للرجال والصبية" (UnitPerPrice = 1)
- `9018.12.0000` → `901812000000` "ـ ـ أجهزة مسح بالموجات فوق الصوتية" (UnitPerPrice = 0)

### 3.3 Missing HS Code (Fewer Than 4 Digits)

When a client provides a code with fewer than 4 digits, the algorithm cannot produce a reliable match. In this case:

- The Naqel team identifies the closest HS code based on the shipment's goods description.
- In rare cases, a physical inspection of the item is performed.

### 3.4 Discrepancy Between HS Code and Description

The ZATCA system does not automatically reject declarations where the HS code and description do not match. However, customs staff may manually reject the shipment in rare instances. This is a known operational risk.

---

## 4. ZATCA Submission XML Structure

All submissions use the SaudiEDI SOAP schema (`http://www.saudiedi.com/schema/decsub`). The root element is `<decsub:saudiEDI>` with `docType="DEC"` and `msgType="H2HDECSUB"`. The `decsub:id` attribute carries the Naqel waybill number.

### 4.1 Reference Section

| Field | Value / Source |
|---|---|
| `userid` | Fixed broker user ID (e.g. `uwqfr002`) |
| `acctId` | Fixed broker account (e.g. `uwqf`) |
| `docRefNo` | Naqel waybill number (e.g. `NQD26033110789`) |
| `regPort` | Port code — type 4, value `23` (air cargo) |

### 4.2 Sender Information

| Field | Value |
|---|---|
| `brokerLicenseType` | `5` (fixed) |
| `brokerLicenseNo` | `1` (fixed) |
| `brokerRepresentativeNo` | `1732` (fixed) |

### 4.3 Declaration Header

| Field | Value |
|---|---|
| `declarationType` | `2` (import) |
| `finalCountry` | `SA` (Saudi Arabia) |
| `inspectionGroupID` | `10` (fixed) |
| `paymentMethod` | `1` (fixed) |
| `totalNoOfInvoice` | Count of invoices (typically `1` for express parcels) |

### 4.4 Invoice Section

| Field | Source |
|---|---|
| `invoiceSeqNo` | Always `1` for single-invoice shipments |
| `invoiceType` | `5` (fixed) |
| `invoiceNo` | Air waybill number (from `airBLNo`) |
| `totalNoItems` | Count of line items |
| `invoiceCost` | `DeclaredValue` from client input |
| `invoiceCurrency` | Mapped via `CurrencyMapping` sheet (e.g. SAR=100, AED=120, USD=410) |
| `totalGrossWeight` | Waybill weight |
| `totalNetWeight` | Waybill weight |
| `sourceCompanyName / No` | Looked up from `SourceCompanyPortMaping` by `ClientID` or `CustRegPortCode`; default for port 23 is `{ناقل, 340476}` |
| `deal` | `1` (fixed) |
| `invoicePayment` | `1` (fixed) |
| `paymentDocumentsStatus` | `0` (fixed) |
| `documentAmount` | Same as `invoiceCost` |

### 4.5 Invoice Item Section

| Field | Source / Logic |
|---|---|
| `itemSeqNo` | Incremental from 1 |
| `countryOfOrigin` | International code (e.g. `US`, `GB`) mapped from `Tabadul CountryCode` by `INTLCODE`; also overridden per `ClientID` via `CountryOfOriginClientMapping` |
| `tariffCode` | 12-digit resolved HS code (from mapping logic) |
| `goodsDescription` | Arabic name from HS code master — non-Arabic characters stripped |
| `invoiceMeasurementUnit` | `7` (fixed — pieces) |
| `quantityInvoiceUnit` | Quantity from client invoice |
| `internationalMeasurementUnit` | `7` (fixed) |
| `quantityInternationalUnit` | Quantity from client invoice |
| `grossWeight` | Waybill weight ÷ item count |
| `netWeight` | Waybill weight ÷ item count |
| `unitPerPackages` | `1` (fixed) |
| `itemCost` | Item amount from invoice |
| `unitInvoiceCost` | Only populated if `HSCode.UnitPerPrice = 1` (i.e. priced per unit) |
| `itemDutyType` | `1` (fixed) |

### 4.6 Air Waybill Section

| Field | Source |
|---|---|
| `carrierPrefix` | First 3 digits of the Air BL number |
| `airBLNo` | Air waybill number |
| `airBLDate` | Invoice/shipment date |

### 4.7 Express Mail Information

| Field | Source / Logic |
|---|---|
| `transportType` | `4` (air express) |
| `transportIDType` | `5` if consignee national ID starts with `1`; `3` if starts with `2` |
| `transportID` | Consignee national ID |
| `name` | Consignee name |
| `addCtryCd` | `100` (Saudi Arabia, fixed) |
| `country` | `100` (Saudi Arabia, fixed) |
| `city` | `CITY_CD` from Tabadul City table based on `DestinationStationID`; default `131` |
| `zipCode` | `1111` (placeholder — not validated) |
| `poBox` | `11` (placeholder) |
| `address` | `CITY_ARB_NAME` from Tabadul City based on `DestinationStationID` |
| `telephone` | Consignee mobile or phone number (with `966` country prefix) |

---

## 5. Incomplete HS Code Sample Analysis

### 5.1 NQD26033110789 — Samsung Galaxy S25 Ultra (Complete but Dot-Formatted Code)

**Pre-processed client input:**
- WaybillNo: `279274301`
- ClientID: `9019628` (AMAZON AE)
- `CustomsCommodityCode`: `8517.13.000000` — full code but contains dots
- Description: Samsung Galaxy S25 Ultra (English, long product description)
- DeclaredValue: `3426.35 AED`
- ConsigneeNationalID: `2591527102` (starts with 2 → `transportIDType = 3`)
- DestinationStation: 501 → Riyadh → city `131`, address `الريـاض`

**Resolution applied:**
Step 1 removes dots: `8517.13.000000` → `851713000000` (already 12 digits, no further lookup needed).

**Post-processed ZATCA XML:**
- `tariffCode`: `851713000000`
- `goodsDescription`: `أجهزة هاتف ذكية سمارت فون` (Arabic — smart smartphones)
- `invoiceCurrency`: `120` (AED)
- `unitInvoiceCost`: `3426.35` — present, meaning `UnitPerPrice = 1` for this HS code
- `sourceCompany`: AMAZON AE (509769) — matched from SourceCompanyPortMaping

**Note:** The goods description in the XML is Arabic and does not match the English description in the client invoice ("Samsung Galaxy S25 Ultra..."). The Arabic description is sourced from the HS code master, not from client input.

### 5.2 NQD26033110790 — Women's Trousers (Incomplete 8-Digit Code)

**Pre-processed client input:**
- WaybillNo: `394613346`
- ClientID: `9022381` (Vogacloset)
- `CustomsCommodityCode`: `62046200` — only 8 digits (incomplete)
- Description: "Dresses" (English)
- DeclaredValue: `1080 SAR`
- ConsigneeNationalID: `1069595681` (starts with 1 → `transportIDType = 5`)
- DestinationStation: 503 → Dammam → city `111`, address `الدمام`

**Resolution applied:**
The 8-digit code `62046200` is stripped progressively: `62046200` → `6204620` → `620462` → `62046` → `6204`. The algorithm queries all candidates, sorts by longest match descending and shortest HS code ascending, and selects `620462000001` (بنطلونات — Women's trousers).

**Post-processed ZATCA XML:**
- `tariffCode`: `620462000001`
- `goodsDescription`: `بنطلونات` (Trousers/Pants)
- `invoiceCurrency`: `100` (SAR)
- `unitInvoiceCost`: **absent** — `UnitPerPrice = 0` for this HS code (clothing, no per-unit price required)

**Notable discrepancy:** The client described the items as "Dresses" but the resolved HS code `620462000001` maps to Women's Trousers (بنطلونات). This is a description vs. HS code mismatch — ZATCA will not auto-reject this but customs staff may flag it. This is the exact scenario described in the context note about discrepancies.

### 5.3 Key Differences Between the Two Samples

| Aspect | NQD26033110789 (Phone) | NQD26033110790 (Clothing) |
|---|---|---|
| Client HS code format | `8517.13.000000` — full, with dots | `62046200` — 8 digits, no dots |
| Resolution needed | Dot removal only | Full prefix-traversal algorithm |
| Final tariff code | `851713000000` | `620462000001` |
| `unitInvoiceCost` present | Yes (UnitPerPrice = 1) | No (UnitPerPrice = 0) |
| Currency | AED (120) | SAR (100) |
| TransportIDType | 3 (national ID starts with 2) | 5 (national ID starts with 1) |
| Description mismatch | None | Yes — "Dresses" vs. بنطلونات (Trousers) |
| Source company | AMAZON AE (509769) | VOGACLOSET (383668) |

---

## 6. Client Input Formats

### 6.1 API Request Template (SOAP/XML)

Clients submit via a SOAP envelope (`CreateWaybill` operation). The commercial invoice data is nested inside `<_CommercialInvoice>` within `<_ManifestShipmentDetails>`. Key fields the client must provide:

**Shipment-level:**
- `ClientID` + `Password` (authentication)
- `ConsigneeName`, `Mobile`, `PhoneNumber`, `Address`, `CountryCode`, `CityCode`
- `Weight`, `PicesCount`, `BillingType`, `CurrenyID`
- `DeclareValue`, `CODCharge`, `InsuredValue`, `GoodsVATAmount`
- `IsCustomDutyPayByConsignee` (boolean)
- `LoadTypeID` (e.g. `34` for express air)

**Per-item (inside `CommercialInvoiceDetailList`):**
- `Quantity`, `UnitType`
- `CountryofManufacture`
- `Description` (English)
- `UnitCost`, `Currency`
- `CustomsCommodityCode` — this is the raw HS code (may be incomplete/formatted with dots)

**Invoice-level:**
- `RefNo`, `InvoiceNo`, `InvoiceDate`
- `Consignee`, `ConsigneeAddress`, `ConsigneeEmail`
- `TotalCost`, `CurrencyCode`

### 6.2 Web Portal Template (XLSX)

The web portal template has a main `CommercialInvoice` sheet with 11 columns:

| Column | Notes |
|---|---|
| `WaybillNo` | Required |
| `Quantity` | Required |
| `UnitType` | Must match values from `UnitType` sheet (Box, Bag, Crate, Pallet, Carton, Barrel, Bundle, Roll, Case, Drum, Package, Tube, Container, Bin, Jar, Piece) |
| `CountryofManufacture` | ISO 2-letter country code |
| `Description` | English item description |
| `UnitCost` | Per-unit price |
| `CustomsCommodityCode` | Client HS code (may be incomplete) |
| `CurrencyCode` | Must match values from `Currency` sheet |
| `DeclaredValue` | Total declared value |
| `SKU` | Optional — client SKU reference |
| `CPC` | Optional — customs procedure code |

Supported currencies (23 total): SAR, AED, USD, GBP, OMR, JOD, LBP, BHD, EGP, KWD, CNY, TRY, HKD, EUR, IQD, MAD, KRW, DZD, TND, AUD, ILS, QAR, SEK.

---

## 7. Reference Data Summary

### 7.1 Currency Mapping

The internal Tabadul currency IDs differ from ISO codes. Key mappings:

| ISO Code | Tabadul ID | Currency |
|---|---|---|
| SAR | 100 | Saudi Riyal |
| AED | 120 | UAE Dirham |
| USD | 410 | US Dollar |
| GBP | 521 | British Pound |
| EUR | 950 | Euro |
| OMR | 119 | Omani Riyal |
| CNY | 142 | Chinese Yuan |
| KWD | 113 | Kuwaiti Dinar |
| QAR | 117 | Qatari Rial |

### 7.2 City Mapping

The `CityMaping` sheet maps `InfoCityId` (internal system) to `TabdulCityId` (ZATCA system). There are ~328 mappings. The `Tabdul City` sheet (~2,169 rows) provides the full city reference including `CITY_CD`, `CITY_ARB_NAME`, `CITY_ENG_NAME`, `CITY_INTL_CD`, and `CTRY_CD`. City code `131` = Riyadh, `111` = Dammam are default fallbacks.

### 7.3 Source Company Port Mapping

The `SourceCompanyPortMaping` sheet (~206 rows) maps `ClientID` + `CustRegPortCode` to the shipper name and number used in the ZATCA XML. Notable entries:

- Default for port 23 (DXB air): `ناقل` / `340476`
- AMAZON AE: `509769`, ClientID `9019628`
- VOGACLOSET: `383668`, ClientID `9019276`
- MUMZWORLD: `194486`, ClientID `9018772`
- SHEIN (ZOETOP): `496151`, ClientID `9017968`

### 7.4 Country of Origin Override

The `CountryOfOriginClientMapping` sheet provides per-client default countries of origin (105 entries). If a client's item has no `CountryofManufacture`, the system falls back to the mapped country for that `ClientID`. For example, ClientID `9019628` (Amazon AE) defaults to country code `410` (USA).

---

## 8. Larger Dataset Observations (client_commercial_invoices_sample2.xlsx)

The sample2 file contains 353,623 rows — a substantial volume of real commercial invoice data. Observed patterns:

- **Dominant origin country:** China (`145`) appears on the vast majority of rows, reflecting the profile of cross-border e-commerce shipments from Chinese merchants.
- **Most common HS codes:** Women's apparel codes (`620442000000`, `620462000001`, `611020000001`) appear with high frequency, consistent with Naqel's e-commerce customer base.
- **Currency:** Most shipments are denominated in SAR, with a subset in AED.
- **HS code quality:** Several rows carry short or numeric-only codes (e.g. `6109100000`, `6204320000`) confirming that incomplete HS codes are a regular occurrence in real traffic, not just edge cases.
- **Missing fields:** `Mobile`, `Phone`, `ConsigneeEmail` are often null — only `MobileNo` or address is consistently present.

---

## 9. Known Issues & Edge Cases

### Issue 1 — Incomplete HS Code (fewer than 4 digits)
**Trigger:** Client provides a code with fewer than 4 digits.
**Current handling:** Manual review by the Naqel team; physical inspection in rare cases.
**Risk:** Processing delay and potential SLA breach.

### Issue 2 — Incorrect or Dot-Formatted HS Code
**Trigger:** Code contains dots, spaces, or characters (e.g. `8517.13.000000`).
**Current handling:** Step 1 of the algorithm strips non-numeric characters.
**Risk:** Low — handled automatically. However, if the cleaned code is still malformed or maps to a wrong category, the error propagates silently.

### Issue 3 — Description vs. HS Code Mismatch
**Trigger:** Client description (e.g. "Dresses") does not match the resolved HS code (e.g. Trousers).
**Current handling:** ZATCA does not auto-reject; customs staff may manually reject in rare cases.
**Risk:** Shipment held/rejected at customs. No automated validation exists today.

### Issue 4 — UnitPerPrice Flag Determines `unitInvoiceCost`
**Trigger:** Some HS codes require a per-unit cost (`UnitPerPrice = 1`), others do not.
**Current handling:** Looked up from `Naqel_HS_code_mapping_lookup.xlsx`. If the HS code is not in the lookup, the behavior depends on the general HSCodeMaster.
**Risk:** Missing `unitInvoiceCost` for a code that requires it, or populating it when it shouldn't be — both could cause ZATCA rejection.

### Issue 5 — transportIDType Determination
**Trigger:** Driven by the first digit of the consignee's national ID (`1` → type 5, `2` → type 3).
**Risk:** If the national ID is missing or malformed, the type defaults incorrectly, which may cause submission failure.

### Issue 6 — ZIP Code and PO Box Placeholders
**Current state:** `zipCode = 1111` and `poBox = 11` are hardcoded placeholders.
**Risk:** If ZATCA moves to stricter validation of these fields, all submissions will fail until real values are populated.

---

## 10. Summary of Field Flows (End-to-End)

```
Client Input (API XML / Web Portal XLSX)
        │
        ▼
  Naqel Pre-Processing
  ├─ Normalize HS Code (remove dots)
  ├─ Resolve to 12-digit ZATCA tariff code (lookup table → algorithm)
  ├─ Derive Arabic goods description from HS code master
  ├─ Map currency ISO → Tabadul ID
  ├─ Map destination station → city code + Arabic city name
  ├─ Determine transportIDType from consignee national ID prefix
  └─ Look up source company from ClientID / port code
        │
        ▼
  ZATCA SaudiEDI XML (decsub schema)
  ├─ Reference (waybill no, port, broker)
  ├─ Declaration Header (import, payment method)
  ├─ Invoice (amounts, currency, source company)
  │   └─ Items (tariff code, Arabic description, weights, costs)
  ├─ Air Waybill (carrier prefix, AWB no, date)
  ├─ Declaration Documents
  └─ Express Mail Info (consignee identity, city, address, phone)
        │
        ▼
  ZATCA / Bayan System
  (Auto-accept or flag for manual customs review)
```
