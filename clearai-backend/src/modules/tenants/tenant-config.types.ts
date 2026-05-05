/**
 * Tenant configuration types.
 *
 * The `CanonicalLineItem` shape is the single contract between BatchPlumber
 * (which produces it via the generic mapper) and the dispatch agent (which
 * consumes it). Add fields here only when both sides agree.
 *
 * `TransformKind` mirrors the closed enum in tenant_field_mappings.transform.
 * `ColumnMappingRule` mirrors a row of tenant_field_mappings.
 */

export type TransformKind = 'trim' | 'uppercase' | 'lowercase' | null;

/**
 * Names of fields the mapper is allowed to populate on CanonicalLineItem.
 * Anchored on Naqel's pre-processed commercial-invoice xlsx columns +
 * what dispatch needs to make a classification decision +
 * what Phase 2 needs to render the ZATCA Declaration envelope.
 */
export type CanonicalField =
  // Description (dispatch input)
  | 'description'
  // Merchant-supplied identity
  | 'waybillNo'
  | 'merchantHsCode'
  | 'merchantSku'
  // Commercial values
  | 'valueAmount'
  | 'currencyCode'
  | 'quantity'
  | 'uom'
  | 'netWeightKg'
  // Client / origin (drives tenant_lookups for sourceCompany, regPort, etc.)
  | 'clientId'
  | 'countryOfOrigin'
  // Destination
  | 'destinationStationId'
  // Consignee (for the ZATCA expressMailInfomation block)
  | 'consigneeName'
  | 'consigneeNationalId'
  | 'consigneePhone';

export interface ColumnMappingRule {
  sourceColumn: string;
  canonicalField: CanonicalField;
  required: boolean;
  transform: TransformKind;
  defaultValue: string | null;
}

export interface TenantConfig {
  id: string;
  slug: string;
  displayName: string;
  bundleSize: number;
  /** SAR threshold for HV/LV partitioning. */
  hvThresholdSar: number;
  active: boolean;
  mappings: ReadonlyArray<ColumnMappingRule>;
  /** Frozen view of tenant_constants for this tenant; key -> value. */
  constants: Readonly<Record<string, string>>;
}

/**
 * Verbatim parsed source row. Persisted in `declaration_set_items.raw_row`
 * (a sibling column of `declaration_set_items.canonical`, NOT inside the
 * canonical jsonb) so column-level GRANT/REVOKE can gate PII access.
 *
 * Values arrive as strings from CSV/XLSX parsers; an API ingest path may
 * supply non-string scalars, so the alias is widened to `unknown`.
 */
export type RawRow = Record<string, unknown>;

/**
 * The normalised line-item shape that flows from the parser into dispatch().
 * Stable contract — never duplicate this type elsewhere.
 *
 * Contains canonicalised, mapper-output fields ONLY. The verbatim source
 * row lives in `declaration_set_items.raw_row` (see RawRow above).
 *
 * Field set follows Naqel's commercial-invoice spec
 * (`naqel-shared-data/Naqel (Fields details + Mapping data).xlsx`):
 *   - `description` is the dispatch input (English or Arabic — language
 *     detected downstream).
 *   - `merchantHsCode` is the tenant-supplied HS guess that drives Stage 1
 *     of the dispatch pipeline (merchant_code_status signal).
 *   - `clientId` and `destinationStationId` are lookup keys that drive
 *     tenant_lookups translations (sourceCompanyName/No, regPort, city,
 *     address) consumed by the renderer.
 *   - `consigneeNationalId` decides `transportIDType` (5 if it starts with
 *     '1', 3 if it starts with '2' — see Naqel's ExpressMailInfomation -
 *     Fields sheet) — the rule lives in the renderer, not here.
 */
export interface CanonicalLineItem {
  /** Stable per-batch identifier; matches declaration_set_items.id once persisted. */
  itemId: string;
  /** 1-based row position from the source file (post-header). */
  rowIndex: number;

  /** Tenant context — uuid for the synthetic key, slug for the FK / log context. */
  tenantId: string;
  tenantSlug: string;

  /* ---- Identity ---- */
  /** Free-text description (English OR Arabic; language detected downstream). */
  description: string;
  /** Naqel `WaybillNo`. Drives ZATCA invoiceNo / docRefNo / airBLNo. */
  waybillNo: string;
  /** Tenant-supplied HS code candidate (drives merchant_code_status in dispatch). */
  merchantHsCode: string | null;
  /** Tenant-supplied product / SKU code, if any. */
  merchantSku: string | null;

  /* ---- Commercial values (HV/LV partitioning + ZATCA fields) ---- */
  valueAmount: number;
  /** ISO-4217 (e.g. 'AED', 'SAR'). Translated to numeric ZATCA code via tenant_lookups.currency_code at render time. */
  currencyCode: string;
  quantity: number;
  /** Unit of measure (e.g. 'KILOGRAMS', 'Piece'). Translated to numeric ZATCA code via tenant_lookups.uom at render time. */
  uom: string;
  netWeightKg: number;

  /* ---- Client / origin ---- */
  /** Tenant client identifier; lookup key for sourceCompany + regPort + countryOfOrigin fallback. */
  clientId: string;
  /** ISO-3166 alpha-2 (post-mapping via tenant_lookups.country_of_origin). */
  countryOfOrigin: string;

  /* ---- Destination ---- */
  /** Naqel `DestinationStationID`; lookup key for regPort + city + address. */
  destinationStationId: string;

  /* ---- Consignee (ZATCA expressMailInfomation block) ---- */
  consigneeName: string;
  /** Drives ZATCA transportIDType per Naqel's spec. */
  consigneeNationalId: string;
  consigneePhone: string;
}

/** Fields that must be non-null/non-empty for an item to enter dispatch. */
export const CANONICAL_REQUIRED_FIELDS: ReadonlyArray<CanonicalField> = [
  'description',
  'waybillNo',
  'valueAmount',
  'currencyCode',
  'quantity',
  'uom',
  'netWeightKg',
  'clientId',
  'countryOfOrigin',
  'destinationStationId',
  'consigneeName',
  'consigneeNationalId',
  'consigneePhone',
];

/** Numeric canonical fields — used by the mapper to coerce strings. */
export const CANONICAL_NUMERIC_FIELDS: ReadonlyArray<CanonicalField> = [
  'valueAmount',
  'quantity',
  'netWeightKg',
];

/** All known canonical-field names — used by the registry to validate mappings. */
export const KNOWN_CANONICAL_FIELDS: ReadonlySet<CanonicalField> = new Set<CanonicalField>([
  'description',
  'waybillNo',
  'merchantHsCode',
  'merchantSku',
  'valueAmount',
  'currencyCode',
  'quantity',
  'uom',
  'netWeightKg',
  'clientId',
  'countryOfOrigin',
  'destinationStationId',
  'consigneeName',
  'consigneeNationalId',
  'consigneePhone',
]);
