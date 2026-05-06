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
    countryOfOrigin: requireString('countryOfOrigin'),

    destinationStationId: requireString('destinationStationId'),

    consigneeName: requireString('consigneeName'),
    consigneeNationalId: requireString('consigneeNationalId'),
    consigneePhone: requireString('consigneePhone'),

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
