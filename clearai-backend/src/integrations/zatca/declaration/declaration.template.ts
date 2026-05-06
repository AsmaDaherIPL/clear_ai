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
 *   constants  → operator_constants (seed-operators.ts)
 *   row        → canonical (mapper output)
 *   lookup     → tabadul_codes (universal) + operator_lookups (per-operator);
 *                merged into a single map by the runner
 *   computed   → derived in this file (transportIDType, carrierPrefix, dates)
 *   dispatch   → final_code, goods_description_ar (Phase 1 outputs)
 *
 * v0 deviations from spec (flagged for future PRs):
 *   • carrierPrefix: defaulted to last-3-of-WaybillNo. Sample 2 matches;
 *     sample 1 (`141` from waybill `279274301`) does not — likely a
 *     Naqel-internal carrier table we don't have. Override via
 *     operator_constants.default_carrier_prefix if all submissions use one.
 *   • airBLDate / documentDate: defaulted to render-time UTC date. Real
 *     value should come from the source row (a future xlsx will have an
 *     `InvoiceDate` column we'll map to canonical).
 *   • docRefNo: deterministic from declaration_run_id + bundle_index, NOT
 *     Naqel's per-day counter. See doc-id.ts.
 *   • UnitInvoiceCost: always emitted = ItemCost. Sample 2 omits it, sample
 *     1 includes it. Spec says "If HSCode.UnitPerPrice =true => Amount" —
 *     we don't track UnitPerPrice today; emitting always matches sample 1's
 *     shape and is invariant to the unknown.
 */
import type { RenderInput } from './declaration.types.js';
import type { DeclarationRunItemRow } from '../../../db/schema.js';
import type { LookupValue } from '../../../modules/operators/operator-lookups.repository.js';
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
  const v = input.operator.constants[key];
  if (v !== undefined && v !== '') return v;
  if (fallback !== undefined) return fallback;
  throw new ZatcaRenderError(`operator_constants['${key}'] is required for operator '${input.operator.slug}'`);
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
      `${ctx}: no tabadul_codes / operator_lookups row for operator='${input.operator.slug}' type='${type}' source='${sourceValue}'`,
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

/**
 * carrierPrefix is a per-shipment lookup keyed on something Naqel hasn't
 * shared with us yet (looks like an internal carrier table; samples show
 * unrelated values 141, 346, 65). Until they ship the rule, emit a literal
 * placeholder string `{carrier_prefix}` for Naqel's post-processing layer
 * to find-and-replace. Tenant-level static override available via
 * `default_carrier_prefix` constant.
 */
function deriveCarrierPrefix(_waybillNo: string, operatorConstants: Readonly<Record<string, string>>): string {
  const override = operatorConstants['default_carrier_prefix'];
  if (override) return override;
  return '{carrier_prefix}';
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

function renderInvoiceItems(items: ReadonlyArray<DeclarationRunItemRow>, input: RenderInput): string {
  return items
    .map((item, idx) => renderInvoiceItem(item, idx, input))
    .join('\n');
}

function renderInvoiceItem(item: DeclarationRunItemRow, idx: number, input: RenderInput): string {
  const c = item.canonical;
  const seq = idx + 1;

  // Country of origin: ISO alpha-2 -> Tabadul code via lookup.
  const country = lookupOrThrow(input, 'country_of_origin', c.countryOfOrigin, `item ${seq} country_of_origin`);

  // tariffCode: dispatch's final_code; goodsDescription: dispatch's
  // goodsDescriptionAr (with non-Arabic characters preserved here — the
  // dispatch agent strips them per the spec before returning).
  const tariffCode = item.finalCode ?? '';
  const goodsDescription = item.goodsDescriptionAr ?? c.description;

  const qty = c.quantity;
  const weight = c.netWeightKg;
  // unitInvoiceCost = the per-line price as Naqel's spec describes
  // (`UnitInvoiceCost = Amount` in their InvoiceItem - Fields sheet).
  // Always emitted: per-HS-code UnitPerPrice flag isn't available in v0
  // (over-emission is forward-compatible; under-emission risks rejection).
  const unitInvoiceCost = c.valueAmount;
  // itemCost = unitInvoiceCost × quantity. For HV bundles (qty typically 1)
  // this resolves to unitInvoiceCost; for LV bundles with qty > 1 the math
  // matters (samples show item 1 in NQD60: qty=3, unit=37.08, cost=111.24).
  const itemCost = unitInvoiceCost * qty;

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
    `          <deccm:grossWeight>${xml(formatNumeric(weight))}</deccm:grossWeight>`,
    `          <deccm:netWeight>${xml(formatNumeric(weight))}</deccm:netWeight>`,
    `          <deccm:unitPerPackages>${xml(constant(input, 'item_unit_per_packages'))}</deccm:unitPerPackages>`,
    `          <deccm:unitInvoiceCost>${xml(formatNumeric(unitInvoiceCost))}</deccm:unitInvoiceCost>`,
    `          <deccm:itemCost>${xml(formatNumeric(itemCost))}</deccm:itemCost>`,
    `          <deccm:itemDutyType>${xml(constant(input, 'item_duty_type_id'))}</deccm:itemDutyType>`,
    `        </decsub:items>`,
  ].join('\n');
}

function renderInvoice(input: RenderInput): string {
  // Sample envelope is "one invoice block per declaration"; HV = 1 item,
  // LV = N items, both carry summed totals.
  const items = input.items;
  // totalNoItems = sum of quantities, NOT items.length. Verified against
  // sample NQD60 (29 item blocks, totalNoItems=51 = sum of quantities).
  const totalNoItems = items.reduce((s, it) => s + Number(it.canonical.quantity || 0), 0);
  // invoiceCost = sum of itemCost = sum of valueAmount × quantity per item.
  const totalCost = items.reduce(
    (s, it) => s + Number(it.canonical.valueAmount || 0) * Number(it.canonical.quantity || 0),
    0,
  );
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
  // Falls back to operator default (e.g. "ناقل" / 340476) when not found.
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
    `        <deccm:totalNoItems>${totalNoItems}</deccm:totalNoItems>`,
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
  const carrierPrefix = deriveCarrierPrefix(first.canonical.waybillNo, input.operator.constants);
  // Prefer the source-row InvoiceDate when present (matches Naqel's
  // post-processed XMLs); fall back to render-time UTC for sources that
  // don't carry the column.
  const blDate = first.canonical.invoiceDate ?? isoDate(input.now);
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
  // Same fallback as airBLDate: prefer source-row InvoiceDate; fall back
  // to render-time UTC. Naqel's samples show airBLDate and documentDate
  // can differ — when their xlsx ships separate columns we'll add a
  // second canonical field; for now both fall back to the same date.
  const docDate = first.canonical.invoiceDate ?? isoDate(input.now);
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
    prefix: input.operator.constants['doc_ref_prefix'],
    suffixOverride: input.docRefSuffixOverride,
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
