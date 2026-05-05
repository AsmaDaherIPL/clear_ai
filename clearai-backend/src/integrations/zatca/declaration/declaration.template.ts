/**
 * String-template renderer for the decsub:saudiEDI envelope.
 *
 * Hand-written — XSD ordering matters; we use string templates with explicit
 * element order so byte-by-byte verification against the sample
 * post-processed XMLs is feasible.
 *
 * Source-of-truth for the envelope shape:
 *   • naqel-shared-data/samples_naqel_output_zatca_submissions/
 *       post-processed item 1 (NQD26033110789).XML
 *       post-processed item 2 (NQD26033110790).XML
 *   • naqel-shared-data/Naqel (Fields details + Mapping data).xlsx
 *       - "Invoice - Fields"
 *       - "InvoiceItem - Fields"
 *       - "ExpressMailInfomation - Fields"
 *
 * Where each field comes from:
 *   constants  → tenant_constants (seed-tenants.ts)
 *   row        → canonical (mapper output)
 *   lookup     → tenant_lookups via the LookupContext passed in
 *   computed   → derived in this file (transportIDType, carrierPrefix, dates)
 *   dispatch   → final_code, goods_description_ar (Phase 1 outputs)
 *
 * v0 deviations from spec (flagged for future PRs):
 *   • carrierPrefix: defaulted to last-3-of-WaybillNo. Sample 2 matches;
 *     sample 1 (`141` from waybill `279274301`) does not — likely a
 *     Naqel-internal carrier table we don't have. Override via
 *     tenant_constants.default_carrier_prefix if all submissions use one.
 *   • airBLDate / documentDate: defaulted to render-time UTC date. Real
 *     value should come from the source row (a future xlsx will have an
 *     `InvoiceDate` column we'll map to canonical).
 *   • docRefNo: deterministic from declaration_set_id + bundle_index, NOT
 *     Naqel's per-day counter. See doc-id.ts.
 *   • UnitInvoiceCost: always emitted = ItemCost. Sample 2 omits it, sample
 *     1 includes it. Spec says "If HSCode.UnitPerPrice =true => Amount" —
 *     we don't track UnitPerPrice today; emitting always matches sample 1's
 *     shape and is invariant to the unknown.
 */
import type { RenderInput } from './declaration.types.js';
import type { DeclarationSetItemRow } from '../../../db/schema.js';
import type { LookupValue } from '../../../modules/tenants/tenant-lookups.repository.js';
import { buildDocRefNo } from './doc-id.js';

export class ZatcaRenderError extends Error {
  readonly code = 'zatca_render_error';
  constructor(message: string) {
    super(message);
    this.name = 'ZatcaRenderError';
  }
}

/** Escape XML-significant characters in a string. */
function xml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function constant(input: RenderInput, key: string, fallback?: string): string {
  const v = input.tenant.constants[key];
  if (v !== undefined && v !== '') return v;
  if (fallback !== undefined) return fallback;
  throw new ZatcaRenderError(`tenant_constants['${key}'] is required for tenant '${input.tenant.slug}'`);
}

function lookup(
  input: RenderInput,
  type: string,
  sourceValue: string,
): LookupValue | undefined {
  return input.lookups.get(type)?.get(sourceValue);
}

function lookupOrThrow(input: RenderInput, type: string, sourceValue: string, ctx: string): LookupValue {
  const hit = lookup(input, type, sourceValue);
  if (!hit) {
    throw new ZatcaRenderError(
      `${ctx}: no tenant_lookups row for tenant='${input.tenant.slug}' lookup_type='${type}' source='${sourceValue}'`,
    );
  }
  return hit;
}

/** YYYY-MM-DD in UTC. */
function isoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Naqel spec: TransportIDType=5 if consigneeNationalId starts with '1',
 * 3 if starts with '2'. Anything else falls back to '5' (more permissive
 * default; flagged for future spec confirmation).
 */
function deriveTransportIdType(consigneeNationalId: string): string {
  const first = consigneeNationalId.trim().charAt(0);
  if (first === '2') return '3';
  return '5';
}

/** Last 3 digits of waybill, fallback to '000'. */
function deriveCarrierPrefix(waybillNo: string, tenantConstants: Readonly<Record<string, string>>): string {
  const override = tenantConstants['default_carrier_prefix'];
  if (override) return override;
  const digits = waybillNo.replace(/\D/g, '');
  if (digits.length >= 3) return digits.slice(-3);
  return digits.padStart(3, '0');
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  envelope sub-renderers                                                  */
/* ──────────────────────────────────────────────────────────────────────── */

function renderRootOpen(input: RenderInput, docRefNo: string): string {
  const ns = xml(input.namespaces.decsub);
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    `<decsub:saudiEDI xmlns:deccm="http://www.saudiedi.com/schema/deccm" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:sau="http://www.saudiedi.com/schema/sau" xmlns:cm="http://www.saudiedi.com/schema/common" xmlns:schemaLocation="http://www.saudiedi.com/schema/decsub.xsd" xmlns:deckey="http://www.saudiedi.com/schema/deckey" decsub:docType="DEC" decsub:id="${xml(docRefNo)}" decsub:msgType="H2HDECSUB" xmlns:decsub="${ns}">`
  );
}

function renderReference(input: RenderInput, docRefNo: string): string {
  const userid = xml(constant(input, 'reference_userid'));
  const acctId = xml(constant(input, 'reference_acct_id'));
  const regPort = xml(constant(input, 'default_reg_port_code', '23'));
  return [
    '      <decsub:reference>',
    `        <decsub:userid>${userid}</decsub:userid>`,
    `        <decsub:acctId>${acctId}</decsub:acctId>`,
    `        <decsub:docRefNo>${xml(docRefNo)}</decsub:docRefNo>`,
    `        <decsub:regPort cm:type="4">${regPort}</decsub:regPort>`,
    '      </decsub:reference>',
  ].join('\n');
}

function renderSenderInformation(input: RenderInput): string {
  return [
    '      <decsub:senderInformation>',
    `        <deccm:brokerLicenseType>${xml(constant(input, 'sender_broker_license_type'))}</deccm:brokerLicenseType>`,
    `        <deccm:brokerLicenseNo>${xml(constant(input, 'sender_broker_license_no'))}</deccm:brokerLicenseNo>`,
    `        <deccm:brokerRepresentativeNo>${xml(constant(input, 'sender_broker_representative_no'))}</deccm:brokerRepresentativeNo>`,
    '      </decsub:senderInformation>',
  ].join('\n');
}

function renderDeclarationHeader(input: RenderInput): string {
  return [
    '      <decsub:declarationHeader>',
    `        <decsub:declarationType>${xml(constant(input, 'declaration_type'))}</decsub:declarationType>`,
    `        <decsub:finalCountry>${xml(constant(input, 'final_country'))}</decsub:finalCountry>`,
    `        <decsub:inspectionGroupID>${xml(constant(input, 'inspection_group_id'))}</decsub:inspectionGroupID>`,
    `        <decsub:paymentMethod>${xml(constant(input, 'payment_method'))}</decsub:paymentMethod>`,
    `        <decsub:totalNoOfInvoice>1</decsub:totalNoOfInvoice>`,
    '      </decsub:declarationHeader>',
  ].join('\n');
}

function renderInvoiceItems(items: ReadonlyArray<DeclarationSetItemRow>, input: RenderInput): string {
  return items
    .map((item, idx) => renderInvoiceItem(item, idx, input))
    .join('\n');
}

function renderInvoiceItem(item: DeclarationSetItemRow, idx: number, input: RenderInput): string {
  const c = item.canonical;
  const seq = idx + 1;

  // Country of origin: ISO alpha-2 -> Tabadul code via lookup.
  const country = lookupOrThrow(input, 'country_of_origin', c.countryOfOrigin, `item ${seq} country_of_origin`);

  // tariffCode: dispatch's final_code; goodsDescription: dispatch's
  // goodsDescriptionAr (with non-Arabic characters preserved here — the
  // dispatch agent strips them per the spec before returning).
  const tariffCode = item.finalCode ?? '';
  const goodsDescription = item.goodsDescriptionAr ?? c.description;

  // Quantity is an integer in the sample. Use canonical.quantity; coerce
  // numeric to string so trailing-zero behaviour matches input.
  const qty = String(c.quantity);

  // Per-item weight (sample emits the same value as the invoice total).
  const weight = String(c.netWeightKg);

  // ItemCost = canonical.valueAmount.
  const itemCost = String(c.valueAmount);

  return [
    `        <decsub:items>`,
    `          <deccm:itemSeqNo>${seq}</deccm:itemSeqNo>`,
    `          <deccm:countryOfOrigin>${xml(country.canonical)}</deccm:countryOfOrigin>`,
    `          <deccm:tariffCode>${xml(tariffCode)}</deccm:tariffCode>`,
    `          <deccm:goodsDescription>${xml(goodsDescription)}</deccm:goodsDescription>`,
    `          <deccm:invoiceMeasurementUnit>${xml(constant(input, 'item_invoice_measurement_unit'))}</deccm:invoiceMeasurementUnit>`,
    `          <deccm:quantityInvoiceUnit>${xml(qty)}</deccm:quantityInvoiceUnit>`,
    `          <deccm:internationalMeasurementUnit>${xml(constant(input, 'item_international_measurement_unit'))}</deccm:internationalMeasurementUnit>`,
    `          <deccm:quantityInternationalUnit>${xml(qty)}</deccm:quantityInternationalUnit>`,
    `          <deccm:grossWeight>${xml(weight)}</deccm:grossWeight>`,
    `          <deccm:netWeight>${xml(weight)}</deccm:netWeight>`,
    `          <deccm:unitPerPackages>${xml(constant(input, 'item_unit_per_packages'))}</deccm:unitPerPackages>`,
    `          <deccm:unitInvoiceCost>${xml(itemCost)}</deccm:unitInvoiceCost>`,
    `          <deccm:itemCost>${xml(itemCost)}</deccm:itemCost>`,
    `          <deccm:itemDutyType>${xml(constant(input, 'item_duty_type_id'))}</deccm:itemDutyType>`,
    `        </decsub:items>`,
  ].join('\n');
}

function renderInvoice(input: RenderInput): string {
  // Sample envelope is "one invoice block per declaration"; for HV bundles
  // that's the single item, for LV it's the chunk. Either way the invoice
  // block carries summed totals.
  const items = input.items;
  const totalCost = items.reduce((s, it) => s + Number(it.canonical.valueAmount || 0), 0);
  const totalWeight = items.reduce((s, it) => s + Number(it.canonical.netWeightKg || 0), 0);

  // Currency / source-company are taken from the FIRST item (HV: only one;
  // LV: bundles share carrier + currency by Naqel convention).
  const first = items[0]!;
  const currency = lookupOrThrow(
    input,
    'currency_code',
    first.canonical.currencyCode,
    `invoice currency`,
  );

  // Source company: client_source_company keyed on `${clientId}:${regPort}`.
  // Falls back to tenant default (e.g. "ناقل" / 340476) when not found.
  const regPort = constant(input, 'default_reg_port_code', '23');
  const sourceCompanyKey = `${first.canonical.clientId}:${regPort}`;
  const sourceCompany = lookup(input, 'client_source_company', sourceCompanyKey);
  const sourceCompanyName = sourceCompany
    ? String(sourceCompany.metadata['sourceCompanyName'] ?? '')
    : constant(input, 'default_source_company_name');
  const sourceCompanyNo = sourceCompany
    ? sourceCompany.canonical
    : constant(input, 'default_source_company_no');

  return [
    '      <decsub:invoices>',
    `        <decsub:invoiceSeqNo>${xml(constant(input, 'invoice_seq_no'))}</decsub:invoiceSeqNo>`,
    `        <deccm:invoiceType>${xml(constant(input, 'invoice_type_id'))}</deccm:invoiceType>`,
    `        <deccm:invoiceNo>${xml(first.canonical.waybillNo)}</deccm:invoiceNo>`,
    `        <deccm:totalNoItems>${items.length}</deccm:totalNoItems>`,
    `        <deccm:invoiceCost>${xml(formatNumeric(totalCost))}</deccm:invoiceCost>`,
    `        <deccm:invoiceCurrency>${xml(currency.canonical)}</deccm:invoiceCurrency>`,
    `        <deccm:totalGrossWeight>${xml(formatNumeric(totalWeight))}</deccm:totalGrossWeight>`,
    `        <deccm:totalNetWeight>${xml(formatNumeric(totalWeight))}</deccm:totalNetWeight>`,
    '        <decsub:sourceCompany>',
    `          <deccm:sourceCompanyName>${xml(sourceCompanyName)}</deccm:sourceCompanyName>`,
    `          <decsub:sourceCompanyNo>${xml(sourceCompanyNo)}</decsub:sourceCompanyNo>`,
    '        </decsub:sourceCompany>',
    `        <deccm:deal>${xml(constant(input, 'deal_value'))}</deccm:deal>`,
    '        <decsub:paymentInfo>',
    `          <deccm:paymentInfoSeqNo>1</deccm:paymentInfoSeqNo>`,
    `          <deccm:invoicePayment>${xml(constant(input, 'invoice_payment_method_id'))}</deccm:invoicePayment>`,
    `          <deccm:paymentDocumentsStatus>${xml(constant(input, 'payment_document_status_id'))}</deccm:paymentDocumentsStatus>`,
    `          <deccm:documentAmount>${xml(formatNumeric(totalCost))}</deccm:documentAmount>`,
    '        </decsub:paymentInfo>',
    renderInvoiceItems(items, input),
    '      </decsub:invoices>',
  ].join('\n');
}

/** Drop trailing ".0" on integers (sample 2 emits "1080" not "1080.0"). */
function formatNumeric(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return String(n);
  // Strip trailing zeros but keep at least one decimal digit.
  return n.toString();
}

function renderExportAirBL(input: RenderInput): string {
  const first = input.items[0]!;
  const carrierPrefix = deriveCarrierPrefix(first.canonical.waybillNo, input.tenant.constants);
  const blDate = isoDate(input.now);
  return [
    '      <decsub:exportAirBL>',
    `        <deccm:carrierPrefix>${xml(carrierPrefix)}</deccm:carrierPrefix>`,
    `        <deccm:airBLNo>${xml(first.canonical.waybillNo)}</deccm:airBLNo>`,
    `        <deccm:airBLDate>${xml(blDate)}</deccm:airBLDate>`,
    '      </decsub:exportAirBL>',
  ].join('\n');
}

function renderDeclarationDocuments(input: RenderInput): string {
  const first = input.items[0]!;
  const docDate = isoDate(input.now);
  return [
    '      <decsub:declarationDocuments>',
    '        <deccm:documentSeqNo>1</deccm:documentSeqNo>',
    '        <deccm:documentType>3</deccm:documentType>',
    `        <deccm:documentNo>${xml(first.canonical.waybillNo)}</deccm:documentNo>`,
    `        <deccm:documentDate>${xml(docDate)}</deccm:documentDate>`,
    '      </decsub:declarationDocuments>',
  ].join('\n');
}

function renderExpressMail(input: RenderInput): string {
  const first = input.items[0]!;
  const c = first.canonical;
  const transportIdType = deriveTransportIdType(c.consigneeNationalId);

  // Destination station -> Tabdul city -> Arabic name (composite lookup).
  const destStation = lookup(input, 'destination_station', c.destinationStationId);
  const cityCode = destStation?.canonical ?? constant(input, 'express_default_city');
  const tabdulCity = lookup(input, 'tabdul_city', cityCode);
  const cityArName = tabdulCity?.canonical ?? '';

  return [
    '      <decsub:expressMailInfomation>',
    `        <deccm:transportType>${xml(constant(input, 'express_transport_type'))}</deccm:transportType>`,
    `        <deccm:transportIDType>${xml(transportIdType)}</deccm:transportIDType>`,
    `        <deccm:transportID>${xml(c.consigneeNationalId)}</deccm:transportID>`,
    `        <deccm:name>${xml(c.consigneeName)}</deccm:name>`,
    `        <deccm:addCtryCd>${xml(constant(input, 'express_add_country_code'))}</deccm:addCtryCd>`,
    `        <deccm:country>${xml(constant(input, 'express_country'))}</deccm:country>`,
    `        <deccm:city>${xml(cityCode)}</deccm:city>`,
    `        <deccm:zipCode>${xml(constant(input, 'express_zip_code'))}</deccm:zipCode>`,
    `        <deccm:poBox>${xml(constant(input, 'express_po_box'))}</deccm:poBox>`,
    `        <deccm:address>${xml(cityArName)}</deccm:address>`,
    `        <deccm:telephone>${xml(c.consigneePhone)}</deccm:telephone>`,
    '      </decsub:expressMailInfomation>',
  ].join('\n');
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  public entry point                                                       */
/* ──────────────────────────────────────────────────────────────────────── */

export function renderDeclarationXml(input: RenderInput): string {
  if (input.items.length === 0) {
    throw new ZatcaRenderError('cannot render declaration with zero items');
  }
  if (input.bundleStrategy === 'HV_STANDALONE' && input.items.length !== 1) {
    throw new ZatcaRenderError('HV_STANDALONE bundles must contain exactly one item');
  }

  const docRefNo = buildDocRefNo({
    date: input.now,
    prefix: input.tenant.constants['doc_ref_prefix'],
    declarationSetId: input.declarationSetId,
    bundleIndex: input.bundleIndex,
  });

  const parts: string[] = [
    renderRootOpen(input, docRefNo),
    '  <decsub:record>',
    '    <sau:payload xsi:type="decsub:declarationSubInfoType">',
    renderReference(input, docRefNo),
    renderSenderInformation(input),
    renderDeclarationHeader(input),
    renderInvoice(input),
    renderExportAirBL(input),
    renderDeclarationDocuments(input),
    renderExpressMail(input),
    '    </sau:payload>',
    '  </decsub:record>',
    '</decsub:saudiEDI>',
  ];

  return parts.join('\n');
}
