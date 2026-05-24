/**
 * Generic operator-line-item mapper. THE single function that takes a raw row
 * (Record<string,string> from a CSV/XLSX parser) plus operator metadata and
 * produces a CanonicalLineItem.
 *
 * Zero per-operator code — Naqel-specific behaviour is rows in
 * operator_field_mappings + operator_constants + operator_lookups, not branches here.
 */
import { newId } from '../../common/utils/uuid.js';
import {
  CANONICAL_NUMERIC_FIELDS,
  CANONICAL_REQUIRED_FIELDS,
  type CanonicalField,
  type CanonicalLineItem,
  type ColumnMappingRule,
  type ConsigneeAddress,
  type OperatorConfig,
} from './operator-config.types.js';
import { RequiredFieldMissingError } from './operator.errors.js';

export interface MapperLookups {
  /** lookup_type -> source_value -> canonical_value. */
  byType: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

/**
 * Read a single cell with the fallback chain.
 *   • Try sourceColumn first.
 *   • If empty, walk fallbackColumns in order; first non-empty wins.
 *   • If still empty AND defaultValue is set, use defaultValue.
 *   • Apply transform on the resolved value.
 *
 * Returns '' to signal "absent after every fallback exhausted".
 */
function readCell(row: Record<string, string>, rule: ColumnMappingRule): string {
  const tryColumn = (col: string): string => {
    const raw = row[col];
    return raw === undefined || raw === null ? '' : String(raw).trim();
  };

  let v = tryColumn(rule.sourceColumn);
  if (v === '') {
    for (const fallback of rule.fallbackColumns) {
      v = tryColumn(fallback);
      if (v !== '') break;
    }
  }

  if (v === '' && rule.defaultValue !== null) {
    v = rule.defaultValue;
  }

  if (v === '') return '';

  switch (rule.transform) {
    case 'uppercase':
      return v.toUpperCase();
    case 'lowercase':
      return v.toLowerCase();
    case 'trim':
    case null:
      return v;
  }
}

function toNumber(field: CanonicalField, raw: string): number {
  // Strip thousand separators and currency-symbol noise; allow comma decimal.
  const cleaned = raw.replace(/[,\s]/g, '');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) {
    throw new Error(`Field '${field}' is not a finite number: ${raw}`);
  }
  return n;
}

/**
 * Country-name → ISO alpha-2 normalisation.
 *
 * Naqel's commercial-invoice feed sends a mix of ISO-2 codes (CN, AE, SA…)
 * and human country names (CHINA, USA, INDIA…). Audit of pilot day-1
 * (2026-05-17) found 95.7% of rows use names, not codes. The downstream
 * tabadul_codes lookup is keyed by ISO-2; ZATCA itself expects ISO-2 in
 * the rendered XML. Normalising at parse time gives every downstream
 * stage a clean canonical form.
 *
 * Only common name variants we've seen in pilot data are listed. Adding a
 * new alias is one line + a comment with the source row count.
 */
const COUNTRY_ALIAS_TO_ISO2: Record<string, string> = {
  // — Country names — most-frequent first (day-1 2026-05-17 row counts)
  CHINA: 'CN',          // 276,291 rows
  USA: 'US',            //       3 rows
  UK: 'GB',             //      23 rows
  RUSSIA: 'RU',         //      60 rows
  VIETNAM: 'VN',        //      30 rows
  THAILAND: 'TH',       //       6 rows
  INDIA: 'IN',          //       3 rows
  JORDAN: 'JO',         //       3 rows
  TURKEY: 'TR',         //       3 rows
  // — UAE emirates (sometimes sent in lieu of country) →  AE
  DUBAI: 'AE',          //       6 rows
  AJMAN: 'AE',          //       6 rows
  // — Compound shipped-via / made-in pairs. Day-1 has small counts of
  //   `CHINA - AE` and `AE - CHINA` (9 + 3 rows). The country-of-origin is
  //   the country of manufacture; for compounds with CHINA present, we
  //   pick CN (the manufacture side) over AE (the shipped-from side).
  'CHINA - AE': 'CN',
  'AE - CHINA': 'CN',
  // Note: `UNKNOWN` is intentionally NOT in the map. The 1 day-1 row with
  // 'UNKNOWN' as country falls through to the lookup which will fail
  // loud, routing the item to HITL for an operator decision.
};

function normaliseCountryOfOrigin(raw: string): string {
  // Already-ISO-2 codes pass through untouched.
  const v = raw.trim().toUpperCase();
  if (v.length === 2) return v;
  return COUNTRY_ALIAS_TO_ISO2[v] ?? v;
}

/**
 * Map a single row.
 *   row        — parsed CSV/XLSX row
 *   operator     — already-resolved OperatorConfig
 *   rowIndex   — 1-based source-file row number for error context
 *   lookups    — preserved in the signature for backward-compat. The mapper
 *                does NOT pre-translate via operator_lookups; translations
 *                are the renderer's concern (currency code → carrier code,
 *                country ISO → carrier code, etc.). Passing null is fine.
 */
export function mapRowToCanonical(
  row: Record<string, string>,
  operator: OperatorConfig,
  rowIndex: number,
  _lookups: MapperLookups | null,
): CanonicalLineItem {
  // Index mappings by canonicalField for fast lookup.
  const byField = new Map<CanonicalField, ColumnMappingRule>();
  for (const m of operator.mappings) byField.set(m.canonicalField, m);

  // Resolve every canonical field; whether it's required and what to do on miss
  // depends on CANONICAL_REQUIRED_FIELDS.
  const get = (field: CanonicalField): string | null => {
    const rule = byField.get(field);
    if (!rule) return null;
    const cell = readCell(row, rule);
    if (cell === '') {
      if (rule.required || CANONICAL_REQUIRED_FIELDS.includes(field)) {
        throw new RequiredFieldMissingError(operator.slug, rowIndex, field);
      }
      return null;
    }
    return cell;
  };

  const num = (field: CanonicalField): number => {
    const s = get(field);
    if (s === null) {
      throw new RequiredFieldMissingError(operator.slug, rowIndex, field);
    }
    return toNumber(field, s);
  };

  const requireString = (field: CanonicalField): string => {
    const s = get(field);
    if (s === null || s === '') {
      throw new RequiredFieldMissingError(operator.slug, rowIndex, field);
    }
    return s;
  };

  const item: CanonicalLineItem = {
    itemId: newId(),
    rowIndex,
    operatorId: operator.id,
    operatorSlug: operator.slug,

    description: requireString('description'),
    waybillNo: requireString('waybillNo'),
    merchantHsCode: get('merchantHsCode'),
    merchantSku: get('merchantSku'),

    valueAmount: num('valueAmount'),
    currencyCode: requireString('currencyCode'),
    quantity: num('quantity'),
    uom: requireString('uom'),
    netWeightKg: num('netWeightKg'),

    clientId: requireString('clientId'),
    countryOfOrigin: normaliseCountryOfOrigin(requireString('countryOfOrigin')),

    destinationStationId: requireString('destinationStationId'),

    consigneeName: requireString('consigneeName'),
    // consigneeNationalId is optional — ~3.5% of Naqel day-1 rows have null
    // values, and Naqel's own LV decls omit consignee fields entirely. When
    // null, the renderer substitutes a placeholder transportID + default
    // transportIDType=5 in the expressMailInfomation block.
    consigneeNationalId: get('consigneeNationalId'),
    consigneePhone: requireString('consigneePhone'),
    consigneeAddress: buildConsigneeAddress(get),

    invoiceDate: get('invoiceDate'),
  };

  // Sanity: numeric fields must be finite.
  for (const f of CANONICAL_NUMERIC_FIELDS) {
    const v = (item as unknown as Record<string, unknown>)[f];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new RequiredFieldMissingError(operator.slug, rowIndex, f);
    }
  }

  return item;
}

/**
 * Build the optional ConsigneeAddress object from up to 4 canonical fields.
 * Returns null when none of the 4 fields produced a value — that signals to
 * the renderer "no per-row override; use operator default for everything."
 * Returns a partially-populated object when only some fields are present;
 * the renderer falls back to the operator default per-field for the nulls.
 */
function buildConsigneeAddress(get: (field: CanonicalField) => string | null): ConsigneeAddress | null {
  const cityCode = get('consigneeCityCode');
  const zipCode = get('consigneeZipCode');
  const poBox = get('consigneePoBox');
  const streetAr = get('consigneeStreetAr');
  if (cityCode === null && zipCode === null && poBox === null && streetAr === null) {
    return null;
  }
  return { cityCode, zipCode, poBox, streetAr };
}
