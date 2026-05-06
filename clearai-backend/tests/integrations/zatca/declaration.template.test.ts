/**
 * Renderer tests.
 *
 * Strategy:
 *   1. structural assertions on the envelope (every section present + ordered)
 *   2. value-level assertions for sample 2 (Vogacloset / Dresses):
 *      currency_code 'SAR' -> '100', country 'GB' -> '521', source company
 *      '9022381:23' -> '383668' / "Vogacloset", transportIDType '5' (national
 *      id starts with '1'), city + Arabic city name composed via the two-hop
 *      destination_station -> tabdul_city lookup.
 *   3. byte-comparable spot-checks against the post-processed sample.
 *
 * We DON'T do a full byte-equal comparison against the reference XML for
 * v0 because:
 *   • The reference id (NQD26033110790) is from Naqel's per-day counter,
 *     not our deterministic generator.
 *   • The reference dates (airBLDate=2026-03-30) come from the source
 *     row's InvoiceDate, which the light-example xlsx doesn't carry.
 *   • The reference carrierPrefix=346 happens to match our last-3-of-waybill
 *     default for this row; for sample 1 it doesn't (141 vs 301). This
 *     test pins the cases where we already match.
 */
import { describe, expect, it } from 'vitest';
import { renderDeclarationXml, ZatcaRenderError } from '../../../src/integrations/zatca/declaration/declaration.template.js';
import type { DeclarationRunItemRow } from '../../../src/db/schema.js';
import type { LookupValue } from '../../../src/modules/operators/operator-lookups.repository.js';

function row(overrides: Partial<{
  description: string;
  goodsDescriptionAr: string;
  finalCode: string;
  waybillNo: string;
  valueAmount: number;
  currencyCode: string;
  quantity: number;
  netWeightKg: number;
  countryOfOrigin: string;
  clientId: string;
  destinationStationId: string;
  consigneeName: string;
  consigneeNationalId: string;
  consigneePhone: string;
  invoiceDate: string | null;
}> = {}): DeclarationRunItemRow {
  return {
    id: 'item-1',
    declarationRunId: 'set-1',
    rowIndex: 1,
    canonical: {
      itemId: 'item-1',
      rowIndex: 1,
      operatorId: '00000000-0000-0000-0000-000000000000',
      operatorSlug: 'naqel',
      description: 'Dresses',
      waybillNo: '394613346',
      merchantHsCode: '62046200',
      merchantSku: null,
      valueAmount: 1080,
      currencyCode: 'SAR',
      quantity: 1,
      uom: 'PIECE',
      netWeightKg: 0.38,
      clientId: '9022381',
      countryOfOrigin: 'GB',
      destinationStationId: '503',
      consigneeName: 'رحمة العيسى',
      consigneeNationalId: '1069595681',
      consigneePhone: '966500026683',
      consigneeAddress: null,
      invoiceDate: null,
      ...(overrides as Record<string, unknown>),
    },
    rawRow: {},
    status: 'succeeded',
    finalCode: '620462000001',
    classificationResult: null,
    trace: null,
    error: null,
    goodsDescriptionAr: 'بنطلونات',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as DeclarationRunItemRow;
}

function lookups(): Map<string, Map<string, LookupValue>> {
  const m = new Map<string, Map<string, LookupValue>>();
  m.set('currency_code', new Map([
    ['SAR', { canonical: '100', metadata: {} }],
    ['AED', { canonical: '120', metadata: {} }],
  ]));
  m.set('country_of_origin', new Map([
    ['GB', { canonical: '521', metadata: { name: 'المملكة المتحدة', fname: 'UNITED KINGDOM' } }],
    ['US', { canonical: '410', metadata: {} }],
    ['IN', { canonical: '131', metadata: {} }],
  ]));
  m.set('client_source_company', new Map([
    ['9022381:23', { canonical: '383668', metadata: { sourceCompanyName: 'Vogacloset', custRegPortCode: '23', clientId: '9022381' } }],
    ['9019628:23', { canonical: '509769', metadata: { sourceCompanyName: 'AMAZON AE', custRegPortCode: '23', clientId: '9019628' } }],
  ]));
  m.set('destination_station', new Map([
    ['503', { canonical: '111', metadata: {} }],
  ]));
  m.set('tabdul_city', new Map([
    ['111', { canonical: 'الدمام', metadata: { engName: 'Dammam', intlCode: 'SA', countryCode: '100' } }],
  ]));
  m.set('uom', new Map([
    ['PIECE', { canonical: '7', metadata: { label: 'piece' } }],
    ['KG',    { canonical: '1', metadata: { label: 'kilogram' } }],
  ]));
  return m;
}

function constants(): Record<string, string> {
  // Only `default_reg_port_code` left in operator_constants after 0056.
  return {
    default_reg_port_code: '23',
  };
}

function identity() {
  return {
    tabadulUserid: 'uwqfr002',
    tabadulAcctId: 'uwqf',
    brokerLicenseType: '5',
    brokerLicenseNo: '1',
    brokerRepresentativeNo: '1732',
    defaultSourceCompanyName: 'ناقل',
    defaultSourceCompanyNo: '340476',
  };
}

function defaultConsigneeAddress() {
  return {
    cityCode: '131',
    zipCode: '1111',
    poBox: '11',
  };
}

function zatcaDefaults(): Record<string, string> {
  return {
    declaration_type: '2',
    final_country: 'SA',
    inspection_group_id: '10',
    payment_method: '1',
    invoice_seq_no: '1',
    invoice_type_id: '5',
    invoice_payment_method_id: '1',
    payment_document_status_id: '0',
    deal_value: '1',
    item_unit_per_packages: '1',
    item_duty_type_id: '1',
    express_transport_type: '4',
    express_add_country_code: '100',
    express_country: '100',
  };
}

function baseInput(items: DeclarationRunItemRow[], strategy: 'HV_STANDALONE' | 'LV_BUNDLED' = 'HV_STANDALONE') {
  return {
    operator: {
      slug: 'naqel',
      displayName: 'Naqel',
      constants: constants(),
      identity: identity(),
      defaultConsigneeAddress: defaultConsigneeAddress(),
    },
    zatcaDefaults: zatcaDefaults(),
    bundleStrategy: strategy,
    items,
    submitter: { carrierId: 'NAQ-CARRIER-1', name: 'Naqel' },
    namespaces: { decsub: 'http://www.saudiedi.com/schema/decsub' },
    lookups: lookups(),
    now: new Date(Date.UTC(2026, 2, 30)), // 2026-03-30
  };
}

describe('renderDeclarationXml — structural', () => {
  it('emits the full envelope in spec-defined order', () => {
    const out = renderDeclarationXml(baseInput([row()]));
    // section presence + ordering
    expect(out).toMatch(
      /<decsub:saudiEDI[\s\S]+<decsub:record>[\s\S]+<sau:payload[\s\S]+<decsub:reference>[\s\S]+<decsub:senderInformation>[\s\S]+<decsub:declarationHeader>[\s\S]+<decsub:invoices>[\s\S]+<decsub:exportAirBL>[\s\S]+<decsub:declarationDocuments>[\s\S]+<decsub:expressMailInfomation>[\s\S]+<\/decsub:saudiEDI>/,
    );
    // root attrs
    expect(out).toContain('decsub:docType="DEC"');
    expect(out).toContain('decsub:msgType="H2HDECSUB"');
  });

  it('reference block uses operator constants + default reg port', () => {
    const out = renderDeclarationXml(baseInput([row()]));
    expect(out).toContain('<decsub:userid>uwqfr002</decsub:userid>');
    expect(out).toContain('<decsub:acctId>uwqf</decsub:acctId>');
    expect(out).toContain('<decsub:regPort cm:type="4">23</decsub:regPort>');
  });

  it('senderInformation block uses operator constants', () => {
    const out = renderDeclarationXml(baseInput([row()]));
    expect(out).toContain('<deccm:brokerLicenseType>5</deccm:brokerLicenseType>');
    expect(out).toContain('<deccm:brokerLicenseNo>1</deccm:brokerLicenseNo>');
    expect(out).toContain('<deccm:brokerRepresentativeNo>1732</deccm:brokerRepresentativeNo>');
  });
});

describe('renderDeclarationXml — sample 2 (Vogacloset / Dresses) lookup-driven values', () => {
  it('translates currency_code SAR -> "100"', () => {
    const out = renderDeclarationXml(baseInput([row()]));
    expect(out).toContain('<deccm:invoiceCurrency>100</deccm:invoiceCurrency>');
  });

  it('translates country_of_origin GB -> "521"', () => {
    const out = renderDeclarationXml(baseInput([row()]));
    expect(out).toContain('<deccm:countryOfOrigin>521</deccm:countryOfOrigin>');
  });

  it('looks up sourceCompany via clientId:regPort composite', () => {
    const out = renderDeclarationXml(baseInput([row()]));
    expect(out).toContain('<deccm:sourceCompanyName>Vogacloset</deccm:sourceCompanyName>');
    expect(out).toContain('<decsub:sourceCompanyNo>383668</decsub:sourceCompanyNo>');
  });

  it('emits invoice + payment totals from canonical', () => {
    const out = renderDeclarationXml(baseInput([row()]));
    expect(out).toContain('<deccm:invoiceCost>1080</deccm:invoiceCost>');
    expect(out).toContain('<deccm:documentAmount>1080</deccm:documentAmount>');
    expect(out).toContain('<deccm:totalGrossWeight>0.38</deccm:totalGrossWeight>');
    expect(out).toContain('<deccm:totalNetWeight>0.38</deccm:totalNetWeight>');
  });

  it('emits item block with dispatch outputs (tariffCode + Arabic description)', () => {
    const out = renderDeclarationXml(baseInput([row()]));
    expect(out).toContain('<deccm:tariffCode>620462000001</deccm:tariffCode>');
    expect(out).toContain('<deccm:goodsDescription>بنطلونات</deccm:goodsDescription>');
  });

  it('expressMail: transportIDType=5 (national id starts with 1) + composed city/address', () => {
    const out = renderDeclarationXml(baseInput([row()]));
    expect(out).toContain('<deccm:transportIDType>5</deccm:transportIDType>');
    expect(out).toContain('<deccm:transportID>1069595681</deccm:transportID>');
    expect(out).toContain('<deccm:name>رحمة العيسى</deccm:name>');
    expect(out).toContain('<deccm:city>111</deccm:city>');
    expect(out).toContain('<deccm:address>الدمام</deccm:address>');
    expect(out).toContain('<deccm:telephone>966500026683</deccm:telephone>');
  });

  it('exportAirBL: airBLNo=waybill, airBLDate from invoiceDate or render-time, carrierPrefix is the literal placeholder', () => {
    const out = renderDeclarationXml(baseInput([row()]));
    // carrierPrefix is a Naqel-internal lookup we don't have; emit a
    // literal placeholder for Naqel's post-processing layer to substitute.
    expect(out).toContain('<deccm:carrierPrefix>{carrier_prefix}</deccm:carrierPrefix>');
    expect(out).toContain('<deccm:airBLNo>394613346</deccm:airBLNo>');
    // No invoiceDate on canonical -> fall back to baseInput.now (2026-03-30).
    expect(out).toContain('<deccm:airBLDate>2026-03-30</deccm:airBLDate>');
  });

  it('uses canonical.invoiceDate when present (for both airBLDate and documentDate)', () => {
    const item = row({ invoiceDate: '2026-03-09' });
    const out = renderDeclarationXml(baseInput([item]));
    expect(out).toContain('<deccm:airBLDate>2026-03-09</deccm:airBLDate>');
    expect(out).toContain('<deccm:documentDate>2026-03-09</deccm:documentDate>');
  });

  it('static default_carrier_prefix operator-constant overrides the placeholder', () => {
    const base = baseInput([row()]);
    const overrideInput = {
      ...base,
      operator: {
        ...base.operator,
        constants: { ...base.operator.constants, default_carrier_prefix: '141' },
      },
    };
    const out = renderDeclarationXml(overrideInput);
    expect(out).toContain('<deccm:carrierPrefix>141</deccm:carrierPrefix>');
  });
});

describe('renderDeclarationXml — sample 1 (Amazon / Samsung) transportIDType branch', () => {
  it('transportIDType=3 when consignee national id starts with "2"', () => {
    const item = row({
      consigneeNationalId: '2591527102',
      consigneeName: 'Roshan',
      consigneePhone: '966565397861',
      clientId: '9019628',
      destinationStationId: '501', // not in lookups; falls back to express_default_city
      countryOfOrigin: 'US',
      currencyCode: 'AED',
      valueAmount: 3426.35,
      waybillNo: '279274301',
    });
    const out = renderDeclarationXml(baseInput([item]));
    expect(out).toContain('<deccm:transportIDType>3</deccm:transportIDType>');
    expect(out).toContain('<deccm:countryOfOrigin>410</deccm:countryOfOrigin>');
    expect(out).toContain('<deccm:invoiceCurrency>120</deccm:invoiceCurrency>');
    expect(out).toContain('<deccm:sourceCompanyName>AMAZON AE</deccm:sourceCompanyName>');
    expect(out).toContain('<decsub:sourceCompanyNo>509769</decsub:sourceCompanyNo>');
    // destination_station 501 not in lookups -> default city 131, no Arabic name
    expect(out).toContain('<deccm:city>131</deccm:city>');
  });
});

describe('renderDeclarationXml — escaping + errors', () => {
  it('escapes XML-significant characters in user-controlled text', () => {
    const item = row({ consigneeName: '<bad> & "stuff"' });
    const out = renderDeclarationXml(baseInput([item]));
    expect(out).toContain('&lt;bad&gt; &amp; &quot;stuff&quot;');
    expect(out).not.toContain('<bad>');
  });

  it('rejects empty bundles', () => {
    expect(() => renderDeclarationXml(baseInput([]))).toThrowError(ZatcaRenderError);
  });

  it('rejects HV_STANDALONE bundles with multiple items', () => {
    expect(() => renderDeclarationXml(baseInput([row(), row()], 'HV_STANDALONE'))).toThrowError(
      ZatcaRenderError,
    );
  });

  it('throws when both canonical.consigneeAddress and operator.defaultConsigneeAddress are missing', () => {
    // Strip the operator default; the row also has consigneeAddress=null.
    // Renderer should fail loud rather than emit empty XML.
    const input = baseInput([row()]);
    const broken = { ...input, operator: { ...input.operator, defaultConsigneeAddress: null } };
    expect(() => renderDeclarationXml(broken)).toThrowError(/zipCode|poBox/);
  });

  it('uses canonical.consigneeAddress when present, falling back per-field to operator default', () => {
    // Provide zipCode + poBox per-row; cityCode and streetAr come from operator default.
    const item = row({});
    (item.canonical as { consigneeAddress: unknown }).consigneeAddress = {
      cityCode: null,
      zipCode: '32433',
      poBox: '8472',
      streetAr: null,
    };
    const out = renderDeclarationXml(baseInput([item]));
    expect(out).toContain('<deccm:zipCode>32433</deccm:zipCode>');
    expect(out).toContain('<deccm:poBox>8472</deccm:poBox>');
    // city: destination_station=503 -> 111, address: tabdul_city Arabic name
    expect(out).toContain('<deccm:city>111</deccm:city>');
    expect(out).toContain('<deccm:address>الدمام</deccm:address>');
  });

  it('throws when a required zatca_declaration_default is missing', () => {
    const input = baseInput([row()]);
    const broken = { ...input, zatcaDefaults: {} };
    expect(() => renderDeclarationXml(broken)).toThrowError(/zatca_declaration_defaults/);
  });

  it('throws when uom lookup is missing', () => {
    // Need a row whose canonical.uom is not in the lookup table.
    const item = row();
    (item.canonical as { uom: string }).uom = 'UNOBTAINIUM';
    expect(() => renderDeclarationXml(baseInput([item]))).toThrowError(/uom/);
  });

  it('throws when country_of_origin lookup is missing', () => {
    const item = row({ countryOfOrigin: 'XX' }); // not in lookup table
    expect(() => renderDeclarationXml(baseInput([item]))).toThrowError(/country_of_origin/);
  });
});

describe('document-id format', () => {
  it('emits NQD followed by 11 random digits (root id + docRefNo match)', () => {
    const out = renderDeclarationXml(baseInput([row()]));
    expect(out).toMatch(/decsub:id="NQD\d{11}"/);
    expect(out).toMatch(/<decsub:docRefNo>NQD\d{11}<\/decsub:docRefNo>/);

    // Pull both ids and confirm they match (same docRefNo populates both).
    const idMatch = out.match(/decsub:id="(NQD\d{11})"/);
    const refMatch = out.match(/<decsub:docRefNo>(NQD\d{11})<\/decsub:docRefNo>/);
    expect(idMatch?.[1]).toBe(refMatch?.[1]);
  });
});
