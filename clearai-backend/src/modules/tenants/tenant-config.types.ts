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

/** Names of fields the mapper is allowed to populate on CanonicalLineItem. */
export type CanonicalField =
  | 'description'
  | 'descriptionAr'
  | 'merchantHsCode'
  | 'merchantSku'
  | 'valueAmount'
  | 'currencyCode'
  | 'quantity'
  | 'uom'
  | 'netWeightKg'
  | 'grossWeightKg'
  | 'countryOfOrigin'
  | 'sourceCountry'
  | 'sourcePortCode'
  | 'regPortCode'
  | 'shipperName'
  | 'shipperAddress'
  | 'consigneeName'
  | 'consigneeAddress'
  | 'consigneeCity'
  | 'invoiceNumber'
  | 'invoiceDate';

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
 * Verbatim parsed source row. Persisted in `batch_items.raw_row` (a sibling
 * column of `batch_items.canonical`, NOT inside the canonical jsonb) so
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
 * Contains canonicalised, mapper-output fields ONLY. The verbatim source
 * row lives in `batch_items.raw_row` (see RawRow above).
 */
export interface CanonicalLineItem {
  /** Stable per-batch identifier; matches batch_items.id once persisted. */
  itemId: string;
  /** 1-based row position from the source file (post-header). */
  rowIndex: number;

  /** Tenant context — uuid for the synthetic key, slug for the FK / log context. */
  tenantId: string;
  tenantSlug: string;

  /* ---- Identity & description (Stage 2A inputs) ---- */
  description: string;
  descriptionAr: string | null;
  merchantHsCode: string | null;
  merchantSku: string | null;

  /* ---- Commercial values (HV/LV partitioning + ZATCA fields) ---- */
  valueAmount: number;
  currencyCode: string;
  quantity: number;
  uom: string;
  netWeightKg: number;
  grossWeightKg: number | null;

  /* ---- Origin / routing (ZATCA envelope) ---- */
  countryOfOrigin: string;
  sourceCountry: string | null;
  sourcePortCode: string | null;
  regPortCode: string | null;

  /* ---- Parties (ZATCA envelope) ---- */
  shipperName: string | null;
  shipperAddress: string | null;
  consigneeName: string | null;
  consigneeAddress: string | null;
  consigneeCity: string | null;

  /* ---- Document refs ---- */
  invoiceNumber: string | null;
  invoiceDate: string | null; // YYYY-MM-DD
}

/** Fields that must be non-null/non-empty for an item to enter dispatch. */
export const CANONICAL_REQUIRED_FIELDS: ReadonlyArray<CanonicalField> = [
  'description',
  'valueAmount',
  'currencyCode',
  'quantity',
  'uom',
  'netWeightKg',
  'countryOfOrigin',
];

/** Numeric canonical fields — used by the mapper to coerce strings. */
export const CANONICAL_NUMERIC_FIELDS: ReadonlyArray<CanonicalField> = [
  'valueAmount',
  'quantity',
  'netWeightKg',
  'grossWeightKg',
];

/** All known canonical-field names — used by the registry to validate mappings. */
export const KNOWN_CANONICAL_FIELDS: ReadonlySet<CanonicalField> = new Set([
  'description',
  'descriptionAr',
  'merchantHsCode',
  'merchantSku',
  'valueAmount',
  'currencyCode',
  'quantity',
  'uom',
  'netWeightKg',
  'grossWeightKg',
  'countryOfOrigin',
  'sourceCountry',
  'sourcePortCode',
  'regPortCode',
  'shipperName',
  'shipperAddress',
  'consigneeName',
  'consigneeAddress',
  'consigneeCity',
  'invoiceNumber',
  'invoiceDate',
]);
