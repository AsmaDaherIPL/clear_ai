# Data Directory

Source data files live here. **Never commit these files** — they contain sensitive
customer/merchant data and must stay local.

## Required files

| File | Purpose | Loads into |
|------|---------|------------|
| `Naqel_HS_code_mapping_lookup.xlsx` | 500 historical HS decisions (ledger seed) | `hs_decision_ledger` |
| `Zatca Tariff codes.xlsx` | 19,138 ZATCA tariff codes | `hs_code_master` |
| `Naqel (Fields details + Mapping data).xlsx` | Multi-sheet: currency, city, source co., origin, field specs | Multiple tables |
| `HS Code Mapping - Logic.xlsx` | Reference only — longest-prefix-wins algorithm | Not loaded |

## Optional (for testing)

| File | Purpose |
|------|---------|
| `client_commercial_invoices_sample2.xlsx` | Real merchant invoice sample (E2E test input) |
| `client_commercial_invoices_API_Request_template.xml` | SOAP API request shape (reference) |
| `Baseline XML output/` | 5 reference ZATCA XMLs for comparator validation |

## Setup steps

1. Drop all xlsx + baseline XML files into this folder
2. From project root: `python db/setup.py`
3. Verify: `sqlite3 clear_ai.db "SELECT COUNT(*) FROM hs_code_master;"`
   → expect ~19,138 rows

See `clearai-app/tracker/INSTRUCTIONS.md` for the full data inventory with
column-level mapping details.
