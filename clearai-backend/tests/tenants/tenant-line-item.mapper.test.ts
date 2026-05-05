/**
 * Tests for the generic tenant-line-item mapper.
 *
 * Pure unit tests — no DB. Builds an in-memory TenantConfig and feeds raw
 * rows; verifies transforms, defaults, lookup translation, and required-field
 * errors.
 */
import { describe, expect, it } from 'vitest';
import { mapRowToCanonical, type MapperLookups } from '../../src/modules/tenants/tenant-line-item.mapper.js';
import { RequiredFieldMissingError } from '../../src/modules/tenants/tenant.errors.js';
import type { TenantConfig } from '../../src/modules/tenants/tenant-config.types.js';

function tenantConfig(): TenantConfig {
  return Object.freeze({
    id: '00000000-0000-0000-0000-000000000001',
    slug: 'naqel',
    displayName: 'Naqel',
    bundleSize: 99,
    hvThresholdSar: 1000,
    active: true,
    mappings: Object.freeze([
      { sourceColumn: 'Description', canonicalField: 'description', required: true, transform: 'trim', defaultValue: null },
      { sourceColumn: 'Description Ar', canonicalField: 'descriptionAr', required: false, transform: 'trim', defaultValue: null },
      { sourceColumn: 'HS Code', canonicalField: 'merchantHsCode', required: false, transform: 'trim', defaultValue: null },
      { sourceColumn: 'SKU', canonicalField: 'merchantSku', required: false, transform: 'trim', defaultValue: null },
      { sourceColumn: 'Value', canonicalField: 'valueAmount', required: true, transform: null, defaultValue: null },
      { sourceColumn: 'Currency', canonicalField: 'currencyCode', required: true, transform: 'uppercase', defaultValue: null },
      { sourceColumn: 'Quantity', canonicalField: 'quantity', required: true, transform: null, defaultValue: null },
      { sourceColumn: 'UOM', canonicalField: 'uom', required: true, transform: 'uppercase', defaultValue: 'EA' },
      { sourceColumn: 'Net Weight', canonicalField: 'netWeightKg', required: true, transform: null, defaultValue: null },
      { sourceColumn: 'Gross Weight', canonicalField: 'grossWeightKg', required: false, transform: null, defaultValue: null },
      { sourceColumn: 'Country of Origin', canonicalField: 'countryOfOrigin', required: true, transform: 'uppercase', defaultValue: null },
      { sourceColumn: 'Source Country', canonicalField: 'sourceCountry', required: false, transform: 'uppercase', defaultValue: null },
      { sourceColumn: 'Source Port', canonicalField: 'sourcePortCode', required: false, transform: 'uppercase', defaultValue: null },
      { sourceColumn: 'Reg Port', canonicalField: 'regPortCode', required: false, transform: 'uppercase', defaultValue: null },
      { sourceColumn: 'Shipper Name', canonicalField: 'shipperName', required: false, transform: 'trim', defaultValue: null },
      { sourceColumn: 'Shipper Address', canonicalField: 'shipperAddress', required: false, transform: 'trim', defaultValue: null },
      { sourceColumn: 'Consignee Name', canonicalField: 'consigneeName', required: false, transform: 'trim', defaultValue: null },
      { sourceColumn: 'Consignee Address', canonicalField: 'consigneeAddress', required: false, transform: 'trim', defaultValue: null },
      { sourceColumn: 'Consignee City', canonicalField: 'consigneeCity', required: false, transform: 'trim', defaultValue: null },
      { sourceColumn: 'Invoice No', canonicalField: 'invoiceNumber', required: false, transform: 'trim', defaultValue: null },
      { sourceColumn: 'Invoice Date', canonicalField: 'invoiceDate', required: false, transform: 'trim', defaultValue: null },
    ] as const),
    constants: Object.freeze({}),
  });
}

function happyRow(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    Description: '  Cotton t-shirt  ',
    'Description Ar': 'تيشيرت قطني',
    'HS Code': '610910',
    SKU: 'TS-001',
    Value: '125.50',
    Currency: 'usd',
    Quantity: '10',
    UOM: 'pcs',
    'Net Weight': '2.5',
    'Gross Weight': '2.7',
    'Country of Origin': 'in',
    'Source Country': 'sa',
    'Source Port': 'jed',
    'Reg Port': 'ruh',
    'Shipper Name': 'ACME LTD',
    'Shipper Address': '1 Main St',
    'Consignee Name': 'Buyer Inc',
    'Consignee Address': 'Riyadh',
    'Consignee City': 'Riyadh',
    'Invoice No': 'INV-1',
    'Invoice Date': '2026-04-01',
    ...overrides,
  };
}

const lookups: MapperLookups = {
  byType: new Map<string, ReadonlyMap<string, string>>([
    ['currency_code', new Map([['USD', 'USD'], ['SAR', 'SAR']])],
    ['country_of_origin', new Map([['IN', 'IN'], ['SA', 'SA']])],
    ['source_port_code', new Map([['JED', 'SAJED']])],
  ]),
};

describe('mapRowToCanonical — happy path', () => {
  it('produces a fully populated CanonicalLineItem with transforms applied', () => {
    const item = mapRowToCanonical(happyRow(), tenantConfig(), 1, lookups);

    expect(item.rowIndex).toBe(1);
    expect(item.tenantSlug).toBe('naqel');
    expect(item.description).toBe('Cotton t-shirt'); // trim
    expect(item.descriptionAr).toBe('تيشيرت قطني');
    expect(item.merchantHsCode).toBe('610910');
    expect(item.valueAmount).toBe(125.5);
    expect(item.currencyCode).toBe('USD'); // uppercase + lookup pass-through
    expect(item.quantity).toBe(10);
    expect(item.uom).toBe('PCS'); // uppercase
    expect(item.netWeightKg).toBe(2.5);
    expect(item.grossWeightKg).toBe(2.7);
    expect(item.countryOfOrigin).toBe('IN');
    expect(item.sourcePortCode).toBe('SAJED'); // lookup translation
    expect(item.invoiceDate).toBe('2026-04-01');
    expect(typeof item.itemId).toBe('string');
    expect(item.itemId).toMatch(/^[0-9a-f]{8}-/i);
  });

  it('returns null for nullable absent cells', () => {
    const row = happyRow({ 'Description Ar': '', SKU: '', 'Gross Weight': '' });
    const item = mapRowToCanonical(row, tenantConfig(), 2, lookups);
    expect(item.descriptionAr).toBeNull();
    expect(item.merchantSku).toBeNull();
    expect(item.grossWeightKg).toBeNull();
  });

  it('substitutes default_value when present and source cell is empty', () => {
    const row = happyRow({ UOM: '' });
    const item = mapRowToCanonical(row, tenantConfig(), 3, lookups);
    // default 'EA' is uppercased by the transform.
    expect(item.uom).toBe('EA');
  });
});

describe('mapRowToCanonical — required fields', () => {
  it('throws RequiredFieldMissingError when description is empty', () => {
    const row = happyRow({ Description: '' });
    expect(() => mapRowToCanonical(row, tenantConfig(), 5, lookups)).toThrowError(
      RequiredFieldMissingError,
    );
  });

  it('throws RequiredFieldMissingError when valueAmount is empty', () => {
    const row = happyRow({ Value: '' });
    expect(() => mapRowToCanonical(row, tenantConfig(), 6, lookups)).toThrowError(
      RequiredFieldMissingError,
    );
  });

  it('throws RequiredFieldMissingError when valueAmount is non-numeric', () => {
    const row = happyRow({ Value: 'abc' });
    expect(() => mapRowToCanonical(row, tenantConfig(), 7, lookups)).toThrow();
  });

  it('throws RequiredFieldMissingError when countryOfOrigin missing', () => {
    const row = happyRow({ 'Country of Origin': '' });
    expect(() => mapRowToCanonical(row, tenantConfig(), 8, lookups)).toThrowError(
      RequiredFieldMissingError,
    );
  });
});

describe('mapRowToCanonical — lookup translation', () => {
  it('passes through values not present in the lookup', () => {
    const item = mapRowToCanonical(happyRow({ 'Reg Port': 'unknown' }), tenantConfig(), 9, lookups);
    expect(item.regPortCode).toBe('UNKNOWN'); // uppercase, no lookup match -> verbatim
  });

  it('does no translation when lookups arg is null', () => {
    const item = mapRowToCanonical(happyRow(), tenantConfig(), 10, null);
    expect(item.sourcePortCode).toBe('JED'); // no lookup applied
  });
});

describe('mapRowToCanonical — numeric coercion', () => {
  it('strips thousand separators', () => {
    const row = happyRow({ Value: '12,345.67' });
    const item = mapRowToCanonical(row, tenantConfig(), 11, lookups);
    expect(item.valueAmount).toBe(12345.67);
  });
});
