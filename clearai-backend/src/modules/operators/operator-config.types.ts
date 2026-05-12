/**
 * Tenant configuration types.
 *
 * `CanonicalLineItem` is the single contract between BatchPlumber (mapper
 * output) and dispatch (input). Add fields here only when both sides agree.
 *
 * `TransformKind` mirrors the closed enum in operator_field_mappings.transform.
 * `ColumnMappingRule` mirrors a row of operator_field_mappings.
 *
 * ZATCA tunables (HV threshold, bundle size) live in setup_meta — see
 * setup-meta.repository — and are NOT on OperatorConfig (they're spec-wide,
 * not per-operator).
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
  // Client / origin (drives operator_lookups for sourceCompany, regPort, etc.)
  | 'clientId'
  | 'countryOfOrigin'
  // Destination
  | 'destinationStationId'
  // Consignee (for the ZATCA expressMailInfomation block)
  | 'consigneeName'
  | 'consigneeNationalId'
  | 'consigneePhone'
  // Consignee address — per-row, fall back to operator default per field
  | 'consigneeCityCode'
  | 'consigneeZipCode'
  | 'consigneePoBox'
  | 'consigneeStreetAr'
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

/**
 * Tabadul identity values for an operator. Loaded from typed columns on the
 * operators row (post-migration 0054). Required at request time — every
 * operator MUST have these populated to file a Declaration.
 */
export interface OperatorIdentity {
  tabadulUserid: string;
  tabadulAcctId: string;
  brokerLicenseType: string;
  brokerLicenseNo: string;
  brokerRepresentativeNo: string;
  defaultSourceCompanyName: string;
  defaultSourceCompanyNo: string;
}

export interface OperatorConfig {
  id: string;
  slug: string;
  displayName: string;
  active: boolean;
  mappings: ReadonlyArray<ColumnMappingRule>;
  identity: Readonly<OperatorIdentity>;
}

/**
 * Verbatim parsed source row. Persisted in `declaration_run_items.raw_row`
 * (a sibling column of canonical, NOT inside the canonical jsonb) so
 * column-level GRANT/REVOKE can gate PII access.
 *
 * Values arrive as strings from CSV/XLSX parsers; an API ingest path may
 * supply non-string scalars, so the alias is widened to `unknown`.
 */
export type RawRow = Record<string, unknown>;

/**
 * Per-row consignee address. Mirrors operators.default_consignee_address
 * (jsonb on the operators table) — same field names, all optional.
 *
 * The mapper builds this object from up to 4 source columns; the
 * canonical jsonb stores it nested. Fields default to null individually,
 * letting the renderer fall back per-field to the operator default.
 */
export interface ConsigneeAddress {
  cityCode: string | null;
  zipCode: string | null;
  poBox: string | null;
  /** Free-text Arabic street address. */
  streetAr: string | null;
}

/**
 * The normalised line-item shape that flows from the parser into dispatch().
 * Stable contract — never duplicate this type elsewhere.
 *
 * Field set follows Naqel's commercial-invoice spec
 * (`naqel-shared-data/Naqel (Fields details + Mapping data).xlsx`):
 *   - `description` is the dispatch input (English or Arabic — language
 *     detected downstream).
 *   - `merchantHsCode` is the operator-supplied HS guess that drives Stage 1
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
  /** Stable per-batch identifier; matches declaration_run_items.id once persisted. */
  itemId: string;
  /**
   * Parent batch id when the item is being processed under a batch
   * (declaration_runs.id). Undefined for single-shot dispatches called via
   * /classifications/dispatch. Used downstream to populate
   * hitl_queue.batch_id so review rows can be grouped by their
   * originating batch.
   */
  declarationRunId?: string | undefined;
  /** 1-based row position from the source file (post-header). */
  rowIndex: number;

  /** Operator context — uuid is the FK target on declaration_runs; slug is for log context. */
  operatorId: string;
  operatorSlug: string;

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
  /**
   * Consignee delivery address — feeds the `<decsub:expressMailInfomation>`
   * block. When NULL, the renderer falls back entirely to the operator's
   * default_consignee_address. When set with partial fields, missing
   * fields fall back individually. The renderer throws on any field that
   * is null on both sides.
   */
  consigneeAddress: ConsigneeAddress | null;

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
  'consigneeCityCode',
  'consigneeZipCode',
  'consigneePoBox',
  'consigneeStreetAr',
  'invoiceDate',
]);
