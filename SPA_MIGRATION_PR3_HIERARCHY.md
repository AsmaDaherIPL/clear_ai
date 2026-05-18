# SPA Migration — PR3 manifest/AWB hierarchy + new CSV format

**Backend commit/revision**: TBD (will fill in after deploy)
**Backend deploy date**: 2026-05-18 (evening)
**Status**: backend in flight; SPA must update before the pilot resumes

PR3 introduces the customs hierarchy that has been missing from the data
model: one batch contains many manifests; each manifest contains many
AWBs (house waybills); each AWB contains many items; each AWB produces
exactly one ZATCA NQD declaration (HV) or contributes to a consolidated
LV declaration shared with other AWBs in the same manifest.

This is a **backward-compatible additive** release on the wire (no
existing API field renames). The SPA can choose to ignore the new
endpoints and the new CSV format and continue working as-is — but the
pilot Naqel data assumes the new ingest path.

## What changed at a glance

### New endpoints (additive, no breaking changes)

- `GET /batches/:id/manifests` — list the manifests under a batch
- `GET /manifests/:id/awbs` — list the AWBs under a manifest (with consignee + aggregated value/count)
- `GET /awbs/:id/items` — list the items under an AWB (light projection)

### New CSV format (Naqel pilot)

The ingest auto-detects Naqel-style CSV headers. If the upload has a
`WayBillNo` column, the parser uses the new 25-column ingest path and
builds the manifest/AWB hierarchy automatically. If `WayBillNo` is
absent, the legacy flat-item path is used.

Naqel's columns (all optional except `WayBillNo`):

```
ManifestedTime, WayBillNo, InvoiceNo, ClientID, ClientName,
DeclaredValue, Weight, DestinationStationID, Dest,
ConsigneeNationalID, ConsigneeName, ConsigneeBirthDate, Mobile,
PhoneNumber, HSCode, CustomsCommodityCode, Description, Amount,
Currency, Quantity, UnitCost, UnitType, ChineseDescription,
ItemWeightUnit, ItemWeightValue
```

- **ManifestedTime absent**: all rows in the upload land in one
  synthetic manifest with id `{operator_slug}_m_{seqno}` (seqno starts at 1).
- **WayBillNo absent**: row is rejected at parse time.

### Bundler behaviour change (server-side only — no SPA-visible API change)

For Naqel-style uploads:
- HV/LV is decided at the **AWB level** (not per-item).
- Cap is **10,000 line items per LV consolidated declaration** (configurable via setup_meta `ZATCA_BUNDLE_SIZE`, currently 9999).
- LV bundles are AWB-atomic except when a single AWB has more than 10,000 items (split inside the AWB then).
- LV pooling is scoped to one manifest (configurable via setup_meta `ZATCA_LV_CROSS_MANIFEST_ALLOWED`, default off).

For non-Naqel / legacy uploads:
- Old per-item HV/LV partitioning still works as before. No SPA change needed.

### Migration 0086 housekeeping

- 69 legacy `classification_events` rows from before 2026-05-18 were dropped (product decision; they had no AWB linkage).
- `ZATCA_LV_INVOICE_CAP_SAR` setup_meta key was removed.
- `ZATCA_LV_CROSS_MANIFEST_ALLOWED` setup_meta key was added.

## New endpoint specs

### GET /batches/:id/manifests

**Request**: path param `id` must be a UUID.

**Response 200**:
```json
{
  "batch_id": "0192a8b3-cdef-7000-89ab-0123456789ab",
  "manifests": [
    {
      "id": "0192a8b3-cdef-7100-89ab-0123456789ab",
      "mawb_no": "2026-05-12T08:30:00+03:00",
      "manifested_at": "2026-05-12T05:30:00.000Z",
      "flight_no": null,
      "arrival_date": null
    },
    {
      "id": "0192a8b3-cdef-7200-89ab-0123456789ab",
      "mawb_no": "naqel_m_1",
      "manifested_at": null,
      "flight_no": null,
      "arrival_date": null
    }
  ]
}
```

- `mawb_no` is either the carrier-supplied master AWB id (sometimes an
  ISO timestamp; Naqel ships it that way) or a synthesised id of the
  form `{operator_slug}_m_{seq}` when `ManifestedTime` was absent.
- `manifested_at` is the parsed ISO 8601 timestamp; `null` when synthesised.

**Response 400**: `id` is not a UUID.
**Response 404**: batch not found.

### GET /manifests/:id/awbs

**Request**: path param `id` must be a UUID.

**Response 200**:
```json
{
  "manifest_id": "0192a8b3-cdef-7100-89ab-0123456789ab",
  "awbs": [
    {
      "id": "0192a8b3-cdef-7300-89ab-0123456789ab",
      "awb_no": "352550924",
      "consignee_national_id": "1234567890",
      "consignee_name": "Asma",
      "consignee_mobile": "+966500000001",
      "consignee_phone": null,
      "consignee_birth_date": "1990-01-01",
      "consignee_dest": "RUH",
      "consignee_dest_station": "RUH-INT",
      "invoice_value_sar": "1500.00",
      "line_item_count": 25
    }
  ]
}
```

- `invoice_value_sar` is a string (Postgres numeric). Parse client-side
  with `Number(...)` when needed for display arithmetic. `null` until
  the bundler has run (Phase 2).
- `line_item_count` is the count of `batch_items` rows under this AWB
  (excludes rows blocked via the review override). `null` until the
  bundler has run.

**Response 400**: `id` is not a UUID.
**Response 404**: manifest not found.

### GET /awbs/:id/items

**Request**: path param `id` must be a UUID.

**Response 200**:
```json
{
  "awb_id": "0192a8b3-cdef-7300-89ab-0123456789ab",
  "items": [
    {
      "id": "0192a8b3-cdef-7400-89ab-0123456789ab",
      "row_index": 1,
      "status": "succeeded",
      "final_code": "640510000000",
      "goods_description_ar": "حذاء بوجه من جلد نوبك بإبزيم سلكي — بوسطن",
      "description": "Boston Wire Buckle Nubuck",
      "value_amount": 300,
      "currency_code": "SAR"
    }
  ]
}
```

This is the **light projection** for the hierarchy navigator. For full
item detail (canonical, trace, classification result), keep using
`GET /batches/:id/items?...` or the existing single-item endpoint.

**Response 400**: `id` is not a UUID.
**Response 404**: awb not found.

## Suggested SPA changes (optional but recommended for the pilot)

### 1. Batch detail page — add a "manifests" tab next to "items"

When a batch has manifests (call `GET /batches/:id/manifests` and check `manifests.length > 0`):
- Show a navigator: Batch → Manifests → AWBs → Items.
- Each level is a single GET; build a left-tree or breadcrumb navigation.
- Surface AWB-level value + line count so reviewers can spot HV/LV at a glance.

When a batch has no manifests (legacy / non-Naqel upload), hide the navigator and keep showing the flat items list as today.

### 2. Filings table — link each filing to its AWBs

The `/batches/:id/filings` response now includes (or will include in a follow-up) a `manifest_id` field. The SPA can use it to label filings:

- HV filing → "Manifest M → AWB A"
- LV consolidated filing → "Manifest M → N AWBs (consolidated)"

The exact filing list endpoint shape is unchanged in PR3; ask the
backend agent when the filing-AWB linkage needs to surface in the wire.

### 3. Upload flow — file-format hint

If the SPA shows a "CSV format" hint in the upload modal, mention Naqel's columns there. The auto-detection means the user doesn't need to choose — but they should know that AWB grouping requires `WayBillNo`.

## Things that did NOT change

- `POST /batches` request shape — unchanged.
- `GET /batches`, `GET /batches/:id`, `GET /batches/:id/items` — unchanged.
- `PATCH /batches/:id`, `POST /batches/:id/cancel` — unchanged.
- HITL queue API — unchanged.
- Trace JSON inside item responses — unchanged.
- Field naming convention (`batch_id`, `batchId`, etc.) — unchanged from PR1.
- Blob path strings — unchanged (still `declaration-runs/...` legacy prefix per the PR1 carve-out).

## Database migration applied

`drizzle/0086_pr3_manifest_aware_bundler.sql` ran as part of the deploy. It:

- Dropped 69 legacy `classification_events` rows (created_at < 2026-05-18).
- Deleted `setup_meta.ZATCA_LV_INVOICE_CAP_SAR`.
- Inserted `setup_meta.ZATCA_LV_CROSS_MANIFEST_ALLOWED = 0`.

PR2's tables (`manifests`, `awbs`, `filing_awbs`) and the new nullable
FK columns (`batch_items.awb_id`, `batch_filings.manifest_id`) are
already live from the earlier PR2 deploy on revision 0000138.

## Rollback plan

The previous backend revision (`0000138`, sha `766199b`) ran PR2's
schema additions but NOT PR3's logic. To revert PR3 without rolling
back PR2's schema:

```bash
az containerapp update --name ca-infp-clearai-be-dev-gwc-01 \
  --resource-group rg-infp-clearai-common-dev-gwc-01 \
  --image ghcr.io/asmadaheripl/clearai-backend:sha-766199b
```

Revision 0000138's code does not know about `awb_id` on items and will
ignore it; uploads will use the legacy flat-item parser regardless of
CSV format. AWB rows persisted by PR3 ingest stay in the DB
unreferenced (no FK from `batch_items` if we revert before any PR3
upload, otherwise items still point at AWBs but the bundler ignores
the linkage).

To fully revert PR3's DB cleanup (the 69 dropped rows + setup_meta
changes), an inverse migration would need to be hand-written. That's
not shipped because the dropped rows were declared safe to delete per
the product decision; the setup_meta changes are easy to invert with
two SQL statements.

## Changelog

- 2026-05-18 (evening) — doc created at PR3 prep. Awaiting deploy.
