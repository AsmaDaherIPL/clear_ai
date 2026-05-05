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

/**
 * Apply tenant_lookups translation to specific fields by canonical name.
 * The lookup_type for each field is the field's snake_case form — e.g.
 *   currencyCode  -> tenant_lookups.lookup_type = 'currency_code'
 * If a lookup_type exists for the field AND a mapping for source_value
 * exists, the canonical_value is substituted. Otherwise the value passes
 * through unchanged.
 *
 * (This convention keeps tenant_lookups data-driven — no per-field branch
 * here; ops just inserts rows under the right lookup_type to enable
 * translation for that field.)
 */
function applyLookup(
  field: CanonicalField,
  value: string,
  lookups: MapperLookups | null,
): string {
  if (!lookups || value === '') return value;
  const type = camelToSnake(field);
  const bucket = lookups.byType.get(type);
  if (!bucket) return value;
  return bucket.get(value) ?? value;
}

function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
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
 *   lookups    — preloaded tenant_lookups; pass null to skip translation
 */
export function mapRowToCanonical(
  row: Record<string, string>,
  tenant: TenantConfig,
  rowIndex: number,
  lookups: MapperLookups | null,
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
    return applyLookup(field, cell, lookups);
  };

  const num = (field: CanonicalField): number => {
    const s = get(field);
    if (s === null) {
      // CANONICAL_REQUIRED_FIELDS contains every numeric "must-have"; this is
      // defence-in-depth for non-required numerics handled below.
      throw new RequiredFieldMissingError(tenant.slug, rowIndex, field);
    }
    return toNumber(field, s);
  };
  const numNullable = (field: CanonicalField): number | null => {
    const s = get(field);
    if (s === null) return null;
    return toNumber(field, s);
  };

  const item: CanonicalLineItem = {
    itemId: newId(),
    rowIndex,
    tenantId: tenant.id,
    tenantSlug: tenant.slug,

    description: get('description') ?? '',
    merchantHsCode: get('merchantHsCode'),
    merchantSku: get('merchantSku'),

    valueAmount: num('valueAmount'),
    currencyCode: get('currencyCode') ?? '',
    quantity: num('quantity'),
    uom: get('uom') ?? '',
    netWeightKg: num('netWeightKg'),
    grossWeightKg: numNullable('grossWeightKg'),

    countryOfOrigin: get('countryOfOrigin') ?? '',
    sourceCountry: get('sourceCountry'),
    sourcePortCode: get('sourcePortCode'),
    regPortCode: get('regPortCode'),

    shipperName: get('shipperName'),
    shipperAddress: get('shipperAddress'),
    consigneeName: get('consigneeName'),
    consigneeAddress: get('consigneeAddress'),
    consigneeCity: get('consigneeCity'),

    invoiceNumber: get('invoiceNumber'),
    invoiceDate: get('invoiceDate'),
  };

  // Final defence-in-depth: required string fields must not be empty.
  if (item.description === '') {
    throw new RequiredFieldMissingError(tenant.slug, rowIndex, 'description');
  }
  if (item.currencyCode === '') {
    throw new RequiredFieldMissingError(tenant.slug, rowIndex, 'currencyCode');
  }
  if (item.uom === '') {
    throw new RequiredFieldMissingError(tenant.slug, rowIndex, 'uom');
  }
  if (item.countryOfOrigin === '') {
    throw new RequiredFieldMissingError(tenant.slug, rowIndex, 'countryOfOrigin');
  }
  // Sanity: numeric fields must be finite.
  for (const f of CANONICAL_NUMERIC_FIELDS) {
    if (f === 'grossWeightKg') continue; // nullable
    const v = (item as unknown as Record<string, unknown>)[f];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new RequiredFieldMissingError(tenant.slug, rowIndex, f);
    }
  }

  return item;
}
