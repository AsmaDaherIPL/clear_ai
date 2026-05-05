/**
 * Tests for the generic tenant-line-item mapper.
 *
 * Pure unit tests — no DB. Builds an in-memory TenantConfig keyed on the
 * REAL Naqel commercial-invoice columns (`WaybillNo`, `weight`, `Amount`,
 * etc.) and feeds raw rows; verifies transforms, defaults, lookup
 * translation, and required-field errors.
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
      { sourceColumn: 'WaybillNo', canonicalField: 'waybillNo', required: true, transform: 'trim', defaultValue: null },
      { sourceColumn: 'CustomsCommodityCode', canonicalField: 'merchantHsCode', required: false, transform: 'trim', defaultValue: null },
      { sourceColumn: 'SKU', canonicalField: 'merchantSku', required: false, transform: 'trim', defaultValue: null },
      { sourceColumn: 'Amount', canonicalField: 'valueAmount', required: true, transform: null, defaultValue: null },
      { sourceColumn: 'Currency', canonicalField: 'currencyCode', required: true, transform: 'uppercase', defaultValue: null },
      { sourceColumn: 'Quantity', canonicalField: 'quantity', required: true, transform: null, defaultValue: null },
      { sourceColumn: 'UnitType', canonicalField: 'uom', required: true, transform: 'uppercase', defaultValue: 'PIECE' },
      { sourceColumn: 'weight', canonicalField: 'netWeightKg', required: true, transform: null, defaultValue: null },
      { sourceColumn: 'ClientID', canonicalField: 'clientId', required: true, transform: 'trim', defaultValue: null },
      { sourceColumn: 'CountryofManufacture', canonicalField: 'countryOfOrigin', required: true, transform: 'uppercase', defaultValue: null },
      { sourceColumn: 'DestinationStationID', canonicalField: 'destinationStationId', required: true, transform: 'trim', defaultValue: null },
      { sourceColumn: 'ConsigneeName', canonicalField: 'consigneeName', required: true, transform: 'trim', defaultValue: null },
      { sourceColumn: 'ConsigneeNationalID', canonicalField: 'consigneeNationalId', required: true, transform: 'trim', defaultValue: null },
      { sourceColumn: 'Mobile', canonicalField: 'consigneePhone', required: true, transform: 'trim', defaultValue: null },
    ] as const),
    constants: Object.freeze({}),
  });
}

function happyRow(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    WaybillNo: '394613346',
    weight: '1.2',
    ClientID: '9022381',
    CurrencyID: '1',
    declaredValue: '1080',
    DestinationStationID: '503',
    Mobile: '966500026683',
    PhoneNumber: '966500026683',
    ConsigneeName: 'رحمة العيسى',
    ConsigneeNationalID: '1069595681',
    Quantity: '1',
    UnitType: 'piece',
    CountryofManufacture: 'gb',
    Description: '  Dresses  ',
    CustomsCommodityCode: '62046200',
    UnitCost: '1080',
    Amount: '1080',
    Currency: 'sar',
    ChineseDescription: 'NULL',
    SKU: 'NULL',
    CPC: 'NULL',
    ItemWeightValue: 'NULL',
    ItemWeightUnit: 'NULL',
    ...overrides,
  };
}

const lookups: MapperLookups = {
  byType: new Map<string, ReadonlyMap<string, string>>([
    ['currency_code', new Map([['SAR', '100'], ['AED', '120']])],
  ]),
};

describe('mapRowToCanonical — happy path', () => {
  it('produces a fully populated CanonicalLineItem with transforms applied', () => {
    const item = mapRowToCanonical(happyRow(), tenantConfig(), 1, lookups);

    expect(item.rowIndex).toBe(1);
    expect(item.tenantSlug).toBe('naqel');
    expect(item.description).toBe('Dresses');
    expect(item.waybillNo).toBe('394613346');
    expect(item.merchantHsCode).toBe('62046200');
    expect(item.valueAmount).toBe(1080);
    expect(item.currencyCode).toBe('100'); // uppercase 'sar' -> SAR -> lookup -> '100'
    expect(item.quantity).toBe(1);
    expect(item.uom).toBe('PIECE');
    expect(item.netWeightKg).toBe(1.2);
    expect(item.clientId).toBe('9022381');
    expect(item.countryOfOrigin).toBe('GB');
    expect(item.destinationStationId).toBe('503');
    expect(item.consigneeName).toBe('رحمة العيسى');
    expect(item.consigneeNationalId).toBe('1069595681');
    expect(item.consigneePhone).toBe('966500026683');
    expect(typeof item.itemId).toBe('string');
    expect(item.itemId).toMatch(/^[0-9a-f]{8}-/i);
  });

  it('returns null for nullable absent cells', () => {
    const item = mapRowToCanonical(
      happyRow({ CustomsCommodityCode: '', SKU: '' }),
      tenantConfig(),
      2,
      lookups,
    );
    expect(item.merchantHsCode).toBeNull();
    expect(item.merchantSku).toBeNull();
  });

  it('substitutes default_value when present and source cell is empty', () => {
    const item = mapRowToCanonical(happyRow({ UnitType: '' }), tenantConfig(), 3, lookups);
    // default 'PIECE' is uppercased by the transform.
    expect(item.uom).toBe('PIECE');
  });

  it('passes value through when no lookup mapping exists for a currency', () => {
    const item = mapRowToCanonical(happyRow({ Currency: 'gbp' }), tenantConfig(), 4, lookups);
    // 'gbp' uppercases to 'GBP'; no lookup hit -> verbatim.
    expect(item.currencyCode).toBe('GBP');
  });
});

describe('mapRowToCanonical — required fields', () => {
  it('throws RequiredFieldMissingError when description is empty', () => {
    expect(() => mapRowToCanonical(happyRow({ Description: '' }), tenantConfig(), 5, lookups))
      .toThrowError(RequiredFieldMissingError);
  });

  it('throws RequiredFieldMissingError when waybillNo is empty', () => {
    expect(() => mapRowToCanonical(happyRow({ WaybillNo: '' }), tenantConfig(), 6, lookups))
      .toThrowError(RequiredFieldMissingError);
  });

  it('throws RequiredFieldMissingError when valueAmount is empty', () => {
    expect(() => mapRowToCanonical(happyRow({ Amount: '' }), tenantConfig(), 7, lookups))
      .toThrowError(RequiredFieldMissingError);
  });

  it('throws when valueAmount is non-numeric', () => {
    expect(() => mapRowToCanonical(happyRow({ Amount: 'abc' }), tenantConfig(), 8, lookups))
      .toThrow();
  });

  it('throws RequiredFieldMissingError when clientId missing', () => {
    expect(() => mapRowToCanonical(happyRow({ ClientID: '' }), tenantConfig(), 9, lookups))
      .toThrowError(RequiredFieldMissingError);
  });

  it('throws RequiredFieldMissingError when destinationStationId missing', () => {
    expect(() => mapRowToCanonical(happyRow({ DestinationStationID: '' }), tenantConfig(), 10, lookups))
      .toThrowError(RequiredFieldMissingError);
  });

  it('throws RequiredFieldMissingError when consigneeNationalId missing', () => {
    expect(() => mapRowToCanonical(happyRow({ ConsigneeNationalID: '' }), tenantConfig(), 11, lookups))
      .toThrowError(RequiredFieldMissingError);
  });
});

describe('mapRowToCanonical — numeric coercion', () => {
  it('strips thousand separators', () => {
    const item = mapRowToCanonical(happyRow({ Amount: '12,345.67' }), tenantConfig(), 12, lookups);
    expect(item.valueAmount).toBe(12345.67);
  });
});
