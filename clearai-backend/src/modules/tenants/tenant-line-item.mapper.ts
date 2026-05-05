/**
 * Generic tenant-line-item mapper. THE single function that takes a raw row
 * (Record<string,string> from a CSV/XLSX parser) plus tenant metadata and
 * produces a CanonicalLineItem.
 *
 * Zero per-tenant code — Naqel-specific behaviour is rows in
 * tenant_field_mappings + tenant_constants + tenant_lookups, not branches here.
 */
import { newId } from '../../common/utils/uuid.js';
import {
  CANONICAL_NUMERIC_FIELDS,
  CANONICAL_REQUIRED_FIELDS,
  type CanonicalField,
  type CanonicalLineItem,
  type ColumnMappingRule,
  type TenantConfig,
} from './tenant-config.types.js';
import { RequiredFieldMissingError } from './tenant.errors.js';

export interface MapperLookups {
  /** lookup_type -> source_value -> canonical_value. */
  byType: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

/** Cell value after transform + default substitution. Empty string means "absent". */
function readCell(row: Record<string, string>, rule: ColumnMappingRule): string {
  const raw = row[rule.sourceColumn];
  let v: string = raw === undefined || raw === null ? '' : String(raw);

  // Trim is implicit on every cell; explicit transforms are applied on top.
  v = v.trim();

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
 *   tenant     — already-resolved TenantConfig
 *   rowIndex   — 1-based source-file row number for error context
 *   lookups    — preserved in the signature for backward-compat. The mapper
 *                does NOT pre-translate via tenant_lookups; translations
 *                are the renderer's concern (currency code → carrier code,
 *                country ISO → carrier code, etc.). Passing null is fine.
 */
export function mapRowToCanonical(
  row: Record<string, string>,
  tenant: TenantConfig,
  rowIndex: number,
  _lookups: MapperLookups | null,
): CanonicalLineItem {
  // Index mappings by canonicalField for fast lookup.
  const byField = new Map<CanonicalField, ColumnMappingRule>();
  for (const m of tenant.mappings) byField.set(m.canonicalField, m);

  // Resolve every canonical field; whether it's required and what to do on miss
  // depends on CANONICAL_REQUIRED_FIELDS.
  const get = (field: CanonicalField): string | null => {
    const rule = byField.get(field);
    if (!rule) return null;
    const cell = readCell(row, rule);
    if (cell === '') {
      if (rule.required || CANONICAL_REQUIRED_FIELDS.includes(field)) {
        throw new RequiredFieldMissingError(tenant.slug, rowIndex, field);
      }
      return null;
    }
    return cell;
  };

  const num = (field: CanonicalField): number => {
    const s = get(field);
    if (s === null) {
      throw new RequiredFieldMissingError(tenant.slug, rowIndex, field);
    }
    return toNumber(field, s);
  };

  const requireString = (field: CanonicalField): string => {
    const s = get(field);
    if (s === null || s === '') {
      throw new RequiredFieldMissingError(tenant.slug, rowIndex, field);
    }
    return s;
  };

  const item: CanonicalLineItem = {
    itemId: newId(),
    rowIndex,
    tenantId: tenant.id,
    tenantSlug: tenant.slug,

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
  };

  // Sanity: numeric fields must be finite.
  for (const f of CANONICAL_NUMERIC_FIELDS) {
    const v = (item as unknown as Record<string, unknown>)[f];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new RequiredFieldMissingError(tenant.slug, rowIndex, f);
    }
  }

  return item;
}
