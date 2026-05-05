/**
 * Tenant configuration types.
 *
 * `CanonicalLineItem` is the single contract between BatchPlumber (mapper
 * output) and dispatch (input). Add fields here only when both sides agree.
 *
 * `TransformKind` mirrors the closed enum in tenant_field_mappings.transform.
 * `ColumnMappingRule` mirrors a row of tenant_field_mappings.
 *
 * ZATCA tunables (HV threshold, bundle size) live in setup_meta — see
 * setup-meta.repository — and are NOT on TenantConfig (they're spec-wide,
 * not per-tenant).
 */

export type TransformKind = 'trim' | 'uppercase' | 'lowercase' | null;

/**
 * Names of fields the mapper is allowed to populate on CanonicalLineItem.
 * Anchored on Naqel's pre-processed commercial-invoice xlsx columns +
 * what dispatch needs + what Phase 2 needs to render the ZATCA envelope.
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
  | 'consigneePhone'
  // Document refs
  | 'invoiceDate';

export interface ColumnMappingRule {
  sourceColumn: string;
  canonicalField: CanonicalField;
  required: boolean;
  transform: TransformKind;
  defaultValue: string | null;
  /**
   * Fallback header chain. Mapper reads sourceColumn first; if empty, walks
   * fallbackColumns in order and takes the first non-empty value. Tenant
   * uploads with multiple header variants (e.g. 'ConsigneeName' vs
   * 'Consignee') hit the same canonical field through this chain.
   */
  fallbackColumns: ReadonlyArray<string>;
}

export interface TenantConfig {
  id: string;
  slug: string;
  displayName: string;
  active: boolean;
  mappings: ReadonlyArray<ColumnMappingRule>;
  /** Frozen view of tenant_constants for this tenant; key -> value. */
  constants: Readonly<Record<string, string>>;
}

/**
 * Verbatim parsed source row. Persisted in `declaration_set_items.raw_row`
 * (a sibling column of canonical, NOT inside the canonical jsonb) so
 * column-level GRANT/REVOKE can gate PII access.
 *
 * Values arrive as strings from CSV/XLSX parsers; an API ingest path may
 * supply non-string scalars, so the alias is widened to `unknown`.
 */
export type RawRow = Record<string, unknown>;

/**
 * The normalised line-item shape that flows from the parser into dispatch().
 * Stable contract — never duplicate this type elsewhere.
 *
 * Field set follows Naqel's commercial-invoice spec
 * (`naqel-shared-data/Naqel (Fields details + Mapping data).xlsx`):
 *   - `description` is the dispatch input (English or Arabic — language
 *     detected downstream).
 *   - `merchantHsCode` is the tenant-supplied HS guess that drives Stage 1
 *     of the dispatch pipeline (merchant_code_status signal).
 *   - `clientId` and `destinationStationId` are lookup keys.
 *   - `consigneeNationalId` decides `transportIDType` (5 if it starts with
 *     '1', 3 if it starts with '2' — see Naqel's ExpressMailInfomation -
 *     Fields sheet) — the rule lives in the renderer.
 *   - `invoiceDate` (YYYY-MM-DD) feeds airBLDate / documentDate; null when
 *     the source row doesn't carry a date column (renderer falls back to
 *     today's UTC date).
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
  description: string;
  waybillNo: string;
  merchantHsCode: string | null;
  merchantSku: string | null;

  /* ---- Commercial values ---- */
  valueAmount: number;
  currencyCode: string;
  quantity: number;
  uom: string;
  netWeightKg: number;

  /* ---- Client / origin ---- */
  clientId: string;
  countryOfOrigin: string;

  /* ---- Destination ---- */
  destinationStationId: string;

  /* ---- Consignee ---- */
  consigneeName: string;
  consigneeNationalId: string;
  consigneePhone: string;

  /* ---- Document refs ---- */
  /** YYYY-MM-DD if present in the source row; null otherwise. */
  invoiceDate: string | null;
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
  'invoiceDate',
]);
