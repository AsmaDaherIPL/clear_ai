# ADR — `declaration_set_items.canonical jsonb` (why + how)

Status: accepted, 2026-05-05
Scope: `clearai-backend/src/db/schema/declaration-set-items.ts`, migration `0043_declaration_set_items.sql`
Audience: database engineer reviewing the schema cold

## TL;DR

`declaration_set_items.canonical` is a **`jsonb NOT NULL`** column that stores the
mapped, normalised line-item shape — the single payload every downstream
consumer reads. The verbatim parsed source row lives in a **sibling
`raw_row jsonb NOT NULL`** column (not nested inside canonical) so
column-level GRANTs can suppress PII access without breaking canonical reads.
We deliberately chose `jsonb` over a wide flat-column table because the
field set is **tenant-driven, not ours**, and we can't afford a migration
every time a new carrier is onboarded. This ADR explains the tradeoffs we
accepted and the constraints we imposed in return.

## What lives in `canonical` and `raw_row`

Two sibling jsonb columns. `canonical` holds a serialised `CanonicalLineItem`
object — mapper-output fields only, no PII-shaped source cells. `raw_row`
holds the verbatim parsed source row alongside it.

For one row of Naqel's commercial-invoice xlsx:

```jsonc
// declaration_set_items.canonical
{
  "itemId": "019df51f-...",
  "rowIndex": 2,
  "tenantId": "97cf6d80-...",
  "tenantSlug": "naqel",
  "description": "Dresses",
  "descriptionAr": null,
  "merchantHsCode": "62046200",
  "valueAmount": 1080,
  "currencyCode": "SAR",
  "quantity": 1,
  "uom": "PIECE",
  "netWeightKg": 1.2,
  "countryOfOrigin": "GB",
  "consigneeName": null,
  "invoiceNumber": "394613346"
  // ... the rest of CanonicalLineItem
}

// declaration_set_items.raw_row  (PII-bearing; column-level GRANT excludes the
// analytics role — see migration 0043)
{
  "WaybillNo": "394613346",
  "weight": "1.2",
  "ClientID": "9022381",
  "ConsigneeName": "رحمة العيسى",
  "ConsigneeNationalID": "1069595681",
  "Mobile": "966500026683",
  "Currency": "SAR",
  "Description": "Dresses"
  // ... every cell from the source row
}
```

The TypeScript shapes are defined in
[`src/modules/tenants/tenant-config.types.ts`](../clearai-backend/src/modules/tenants/tenant-config.types.ts):
`CanonicalLineItem` for the mapper output, `RawRow = Record<string, unknown>`
for the verbatim row. Every reader (the dispatch use-case, the ZATCA
declaration renderer, the trace-debug routes) imports those types — there
is no re-derivation.

Trace consumers that need both columns get them with one row read:
`SELECT canonical, raw_row FROM declaration_set_items WHERE id = $1`. The
"raw row sits next to canonical" property survived the split — just at the
row level, not inside the same jsonb.

## Why `jsonb` and not a wide table

We considered three alternatives. Each was rejected for a specific reason.

### Alternative 1: one column per canonical field

A flat table with `description text`, `value_amount numeric`, `quantity int`,
`uom text`, `country_of_origin char(2)`, `consignee_name text`, etc.

Rejected because:

- **Tenant onboarding becomes a migration.** ClearAI's design treats
  tenants as data, not code (see ADR `folder-structure.md` and the
  `tenants/` ownership notes). Adding Aramex tomorrow shouldn't require
  `ALTER TABLE declaration_set_items ADD COLUMN ...`. Their xlsx might have a
  `consigneeNationalID` field Naqel doesn't have, or vice versa.
- **The canonical shape is a moving target during the build-out.** Reading
  the two real Naqel ZATCA reference XMLs surfaced ~10 fields the v0
  `CanonicalLineItem` was missing (`waybillNo`, `clientId`,
  `destinationStationId`, `consigneeNationalId`, `chineseDescription`,
  `sku`, `cpc`, `itemWeightValue`, `itemWeightUnit`). Each field-set
  refinement during this sprint would have been a migration.
- **`raw_row` would need its own jsonb anyway.** Auditability requires
  preserving the verbatim source row for every line item; that's exactly
  what the `raw_row` sibling column does. A flat-column canonical table
  *plus* a `raw_row` jsonb gives no benefit over two jsonbs (`canonical`
  + `raw_row`) and triggers a migration on every tenant onboarding.

### Alternative 2: `tenant_field_mappings` table joined at read time

Rejected because the mapper has already done the canonicalisation work
(applied transforms, run tenant_lookups translations, type-coerced numerics)
*before* the row is persisted. Re-deriving on every read would force every
consumer to re-run the mapper, which fans out per-row tenant-config lookups
on what is supposed to be a hot read path.

### Alternative 3: `canonical text` (JSON as TEXT)

Rejected: `jsonb` gives us GIN indexability if a query path emerges, plus
binary storage (faster than parsing TEXT on every read), plus
`jsonb_typeof` for shape CHECKs. The convention `jsonb` over `json` is
already enforced project-wide by rule 5 of the schema-rules contract.

## What we lose, and how we mitigate it

| Loss | Mitigation |
|---|---|
| **Per-field constraints** (e.g. `value_amount >= 0`, `currency_code ~ '^[A-Z]{3}$'`) | The mapper enforces these in TypeScript before insert. `RequiredFieldMissingError` is thrown for missing required fields. The DB enforces shape via `declaration_set_items_canonical_object_chk` (`jsonb_typeof = 'object'`). |
| **Per-field FKs** (e.g. couldn't FK `currencyCode` → `iso_4217_codes`) | Currency translation happens via `tenant_lookups` (lookup_type='currency_code') at mapping time. The output value is whatever ZATCA expects (numeric carrier codes like `100` or `120`); a hard FK would be wrong. |
| **Schema documentation lives in TS, not the DB** | The TypeScript type `CanonicalLineItem` is the source of truth. It's exported from one file, used everywhere, and changes go through code review. The DB is intentionally the dumb persistence layer for this column. |
| **`SELECT description FROM declaration_set_items WHERE …`** doesn't work | Use `canonical->>'description'` for ad-hoc reads. Where ergonomics matter (admin UI, CSV export of classifications), the route layer projects fields by name. Phase 1 of the pipeline never queries jsonb keys — it operates on the deserialised TS object. |

## What we did NOT compromise on

The four invariants below are enforced **at the database level**, not in
the application:

1. **Shape lock on both jsonb columns** —
   `CHECK (jsonb_typeof(canonical) = 'object')` and
   `CHECK (jsonb_typeof(raw_row)   = 'object')`. Stops a misbehaving caller
   from inserting a JSON array, scalar, or `null` body into either column.
2. **Lifecycle** — `declaration_set_items.status` is a CHECK-locked text column
   (NOT inside the jsonb). Closed enum:
   `'pending' | 'classifying' | 'succeeded' | 'flagged' | 'blocked' | 'failed'`.
3. **Final HS code is promoted** — `final_code char(12)` is a top-level
   column on `declaration_set_items` with a real `FOREIGN KEY` to
   `zatca_hs_codes(code) ON DELETE RESTRICT` and a format CHECK
   (`^[0-9]{12}$`). FKs and format checks can't bind to jsonb paths, so
   the data we genuinely need referential integrity on lives outside the
   jsonb. This was an explicit decision documented in the schema rules
   pre-implementation review.
4. **Ordering invariant** — `declaration_set_items_final_code_status_consistency_chk`
   ensures `final_code IS NOT NULL` iff `status ∈ {'succeeded', 'flagged'}`.
   You cannot have a "pending" item with a final code, or a "succeeded"
   item without one. This invariant straddles two top-level columns; jsonb
   would never have caught it.

## Read patterns

For the DB engineer planning indexes or queries:

| Pattern | How to query | Indexed? |
|---|---|---|
| List items in a batch in row order | `SELECT * FROM declaration_set_items WHERE declaration_set_id = $1 ORDER BY row_index` | yes — `declaration_set_items_set_row_idx` (composite `(declaration_set_id, row_index)`); the ORDER BY is satisfied by the index without a sort step |
| Lookup all items in a batch (no ordering needed) | `SELECT * FROM declaration_set_items WHERE declaration_set_id = $1` | yes — same composite index via leftmost-prefix |
| Phase 1 worker claims pending items | `SELECT * FROM declaration_set_items WHERE declaration_set_id = $1 AND status = 'pending'` | yes — `declaration_set_items_pending_idx` (partial, `WHERE status = 'pending'`) |
| All items resolved to a particular HS code | `SELECT * FROM declaration_set_items WHERE final_code = $1` | yes — `declaration_set_items_final_code_idx` (partial, `WHERE final_code IS NOT NULL`) |
| Count items per status for a batch | `SELECT status, count(*) FROM declaration_set_items WHERE declaration_set_id = $1 GROUP BY status` | covered by `declaration_set_items_set_row_idx` + grouping over the in-batch result |
| Search canonical text (e.g. all items where description contains 'Dresses') | `SELECT * FROM declaration_set_items WHERE canonical->>'description' ILIKE '%Dresses%'` | **not indexed today** — see "Future indexing" below |
| Reach into raw row (e.g. all items with WaybillNo `394613346`) | `SELECT * FROM declaration_set_items WHERE raw_row->>'WaybillNo' = '394613346'` | **not indexed today** — see "Future indexing" below |

## Future indexing (only when we measure a need)

Per the schema-rules contract, we don't add indexes "just in case." If a
real query path emerges, candidates are:

- **GIN on `canonical`** for ad-hoc key/value lookups:
  `CREATE INDEX declaration_set_items_canonical_gin ON declaration_set_items USING gin (canonical jsonb_path_ops);`
  Pays for itself if we run "find all items with merchant_hs_code = X"
  across many batches.
- **Expression indexes for high-traffic single keys**:
  `CREATE INDEX ... ON declaration_set_items ((canonical->>'merchantHsCode'));`
  Cheaper than full GIN if we only care about one or two keys.
- **Promotion of a hot key to a top-level column** (like we already did
  with `final_code`). Worth it when (a) we want an FK or NOT NULL
  invariant or (b) the read path is on the per-request hot loop. Naqel
  `WaybillNo` is a candidate for promotion if customer-facing URL design
  ever wants `/shipments/by-waybill/:no`.

## Audit + retention

PII lives exclusively in `declaration_set_items.raw_row` (consignee names, national
IDs, phone numbers from the source upload). The split of `raw_row` into
its own column is what makes operational PII handling tractable:

- **Column-level GRANTs do the heavy lifting.** Migration 0043 grants the
  application role full access on `declaration_set_items` but excludes `raw_row`
  from the analytics role (`clearai_readonly`) — mirrors the column-level
  grants in `0019_role_separation.sql`. Analytics queries that select
  `canonical, status, final_code, ...` work; any query that touches
  `raw_row` from the analytics role fails at the planner.
- **Future redaction operates on the `raw_row` column directly via
  column-level GRANTs and an in-place UPDATE, with no parsing of nested
  jsonb required.** A retention sweep can run `UPDATE declaration_set_items SET
  raw_row = '{}'::jsonb WHERE created_at < now() - interval '90 days'`
  without touching `canonical`, and Phase 1 / Phase 2 keep working
  unchanged because they read the canonicalised fields, not raw cells.
- **The redaction pipeline that scrubs `classification_events.request`
  (see `0020_pii_redaction.sql` + `src/common/logging/redact.ts`) is
  separate.** That pipeline targets free-text classification descriptions
  flowing through the API; `declaration_set_items.raw_row` carries structured row
  cells from a tenant's commercial-invoice file. Different shape, different
  redaction strategy — currently a column-level access gate, not a
  pre-write redactor.

`canonical` itself is the operational source of truth for re-running a
batch's classifications and re-rendering a declaration. It contains zero
PII by design: every field is mapper-output, validated against the closed
`CanonicalLineItem` shape.

## Summary for review

- The choice is `jsonb` because tenant onboarding is data, not code.
- The data we need referential integrity on (`final_code`, `status`) is
  promoted out of jsonb and constrained at the DB.
- The data we need shape integrity on is constrained via
  `jsonb_typeof = 'object'`.
- Read patterns are served by top-level column indexes today; jsonb
  indexes are deferred until a real query justifies them.
- The TypeScript `CanonicalLineItem` type is the schema for this column
  and is owned by `src/modules/tenants/tenant-config.types.ts`.
