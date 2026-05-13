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
 *   identity         → operators row columns (tabadulUserid, brokerLicenseType, ...)
 *   zatcaDefault     → zatca_declaration_defaults table (declaration_type, payment_method, ...)
 *   constants        → operator_constants (today: only default_reg_port_code)
 *   row              → canonical (mapper output, including consigneeAddress)
 *   operator default → operators.default_consignee_address jsonb (per-field fallback for consigneeAddress)
 *   lookup           → tabadul_codes (universal) + operator_lookups (per-operator);
 *                      merged into a single map by the runner
 *   computed         → derived in this file (transportIDType, carrierPrefix, dates)
 *   dispatch         → final_code, goods_description_ar (Phase 1 outputs)
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
import type { BatchItemRow } from '../../../db/schema.js';
import type { LookupValue } from '../../../modules/operators/operator-lookups.repository.js';
import { buildDocRefNo } from './doc-id.js';

/**
 * Render-time error from the ZATCA declaration template. Carries a typed
 * `code` and optional `details` so the run-summary error banner can show
 * actionable text ("Phase 2 — declaration build: missing currency lookup
 * for SAR") instead of a generic stack-trace fragment.
 *
 * Codes used today:
 *   missing_lookup          — tabadul_codes / operator_lookups row absent
 *   missing_consignee_address — neither canonical row nor operator default
 *   empty_bundle            — render called with zero items
 *   bad_bundle_strategy     — HV_STANDALONE bundle with !=1 items
 *   render_error            — any other render-time invariant violation
 */
export type ZatcaRenderErrorCode =
  | 'missing_lookup'
  | 'missing_consignee_address'
  | 'empty_bundle'
  | 'bad_bundle_strategy'
  | 'render_error';

export class ZatcaRenderError extends Error {
  readonly code: ZatcaRenderErrorCode;
  readonly details: Record<string, string>;
  constructor(
    message: string,
    code: ZatcaRenderErrorCode = 'render_error',
    details: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'ZatcaRenderError';
    this.code = code;
    this.details = details;
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

/** Stringify a config value (envelope constants are smallint columns). */
function cfg(value: number | string): string {
  return String(value);
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
      'missing_lookup',
      { operator: input.operator.slug, type, source: sourceValue, ctx },
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

// Per-shipment lookup keyed on something Naqel hasn't shared yet
// (samples show unrelated values 141, 346, 65). Until that rule lands,
// emit `{carrier_prefix}` for Naqel's post-processing layer to
// find-and-replace. Operator-level static override:
// operator_declaration_config.default_carrier_prefix.
function deriveCarrierPrefix(_waybillNo: string, override: string | null): string {
  if (override) return override;
  return '{carrier_prefix}';
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  envelope sub-renderers                                                  */
/* ──────────────────────────────────────────────────────────────────────── */

function renderRootOpen(input: RenderInput, docRefNo: string): string {
  const ns = xml(input.config.zatcaDeclarationNamespace ?? 'http://www.saudiedi.com/schema/decsub');
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    `<decsub:saudiEDI xmlns:deccm="http://www.saudiedi.com/schema/deccm" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:sau="http://www.saudiedi.com/schema/sau" xmlns:cm="http://www.saudiedi.com/schema/common" xmlns:schemaLocation="http://www.saudiedi.com/schema/decsub.xsd" xmlns:deckey="http://www.saudiedi.com/schema/deckey" decsub:docType="DEC" decsub:id="${xml(docRefNo)}" decsub:msgType="H2HDECSUB" xmlns:decsub="${ns}">`
  );
}

function renderReference(input: RenderInput, docRefNo: string): string {
  const userid = xml(input.operator.identity.tabadulUserid);
  const acctId = xml(input.operator.identity.tabadulAcctId);
  const regPort = xml(input.config.defaultRegPortCode ?? '23');
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
  const id = input.operator.identity;
  return [
    '      <decsub:senderInformation>',
    `        <deccm:brokerLicenseType>${xml(id.brokerLicenseType)}</deccm:brokerLicenseType>`,
    `        <deccm:brokerLicenseNo>${xml(id.brokerLicenseNo)}</deccm:brokerLicenseNo>`,
    `        <deccm:brokerRepresentativeNo>${xml(id.brokerRepresentativeNo)}</deccm:brokerRepresentativeNo>`,
    '      </decsub:senderInformation>',
  ].join('\n');
}

function renderDeclarationHeader(input: RenderInput): string {
  return [
    '      <decsub:declarationHeader>',
    `        <decsub:declarationType>${xml(cfg(input.config.declarationType))}</decsub:declarationType>`,
    `        <decsub:finalCountry>${xml(input.config.finalCountry)}</decsub:finalCountry>`,
    `        <decsub:inspectionGroupID>${xml(cfg(input.config.inspectionGroupId))}</decsub:inspectionGroupID>`,
    `        <decsub:paymentMethod>${xml(cfg(input.config.paymentMethod))}</decsub:paymentMethod>`,
    `        <decsub:totalNoOfInvoice>1</decsub:totalNoOfInvoice>`,
    '      </decsub:declarationHeader>',
  ].join('\n');
}

function renderInvoiceItems(items: ReadonlyArray<BatchItemRow>, input: RenderInput): string {
  return items
    .map((item, idx) => renderInvoiceItem(item, idx, input))
    .join('\n');
}

function renderInvoiceItem(item: BatchItemRow, idx: number, input: RenderInput): string {
  const c = item.canonical;
  const seq = idx + 1;

  // Country of origin: ISO alpha-2 -> Tabadul code via lookup.
  const country = lookupOrThrow(input, 'country_of_origin', c.countryOfOrigin, `item ${seq} country_of_origin`);

  // UOM: per-row from c.uom -> Tabadul code via lookup.
  // Replaces the previous hardcoded item_invoice_measurement_unit constant.
  const uom = lookupOrThrow(input, 'uom', c.uom, `item ${seq} uom`);

  // tariffCode: dispatch's final_code; goodsDescription: dispatch's
  // goodsDescriptionAr (with non-Arabic characters preserved here — the
  // dispatch agent strips them per the spec before returning).
  const tariffCode = item.finalCode ?? '';
  const goodsDescription = item.goodsDescriptionAr ?? c.description;

  const qty = c.quantity;
  const weight = c.netWeightKg;
  // ZATCA accepts only SAR-denominated invoices. We use valueAmountSar
  // stamped at parse time; fall back to valueAmount only for legacy rows
  // (pre 2026-05-13) that predate the FX migration.
  const unitInvoiceCost =
    typeof c.valueAmountSar === 'number' && Number.isFinite(c.valueAmountSar)
      ? c.valueAmountSar
      : c.valueAmount;
  const itemCost = unitInvoiceCost * qty;

  return [
    `        <decsub:items>`,
    `          <deccm:itemSeqNo>${seq}</deccm:itemSeqNo>`,
    `          <deccm:countryOfOrigin>${xml(country.canonical)}</deccm:countryOfOrigin>`,
    `          <deccm:tariffCode>${xml(tariffCode)}</deccm:tariffCode>`,
    `          <deccm:goodsDescription>${xml(goodsDescription)}</deccm:goodsDescription>`,
    `          <deccm:invoiceMeasurementUnit>${xml(uom.canonical)}</deccm:invoiceMeasurementUnit>`,
    `          <deccm:quantityInvoiceUnit>${xml(qty)}</deccm:quantityInvoiceUnit>`,
    `          <deccm:internationalMeasurementUnit>${xml(uom.canonical)}</deccm:internationalMeasurementUnit>`,
    `          <deccm:quantityInternationalUnit>${xml(qty)}</deccm:quantityInternationalUnit>`,
    `          <deccm:grossWeight>${xml(formatNumeric(weight))}</deccm:grossWeight>`,
    `          <deccm:netWeight>${xml(formatNumeric(weight))}</deccm:netWeight>`,
    `          <deccm:unitPerPackages>${xml(cfg(input.config.itemUnitPerPackages))}</deccm:unitPerPackages>`,
    `          <deccm:unitInvoiceCost>${xml(formatNumeric(unitInvoiceCost))}</deccm:unitInvoiceCost>`,
    `          <deccm:itemCost>${xml(formatNumeric(itemCost))}</deccm:itemCost>`,
    `          <deccm:itemDutyType>${xml(cfg(input.config.itemDutyTypeId))}</deccm:itemDutyType>`,
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
  // invoiceCost = sum of itemCost in SAR. ZATCA accepts only SAR.
  // valueAmountSar is stamped at parse time; legacy fallback to valueAmount.
  const totalCost = items.reduce((s, it) => {
    const c = it.canonical;
    const sarUnit =
      typeof c.valueAmountSar === 'number' && Number.isFinite(c.valueAmountSar)
        ? c.valueAmountSar
        : Number(c.valueAmount || 0);
    return s + sarUnit * Number(c.quantity || 0);
  }, 0);
  const totalWeight = items.reduce((s, it) => s + Number(it.canonical.netWeightKg || 0), 0);

  // ZATCA invoice currency is always SAR (Tabadul currency_code = "100").
  // Don't look up the merchant's currency — the source values have already
  // been converted to SAR at parse time.
  const first = items[0]!;
  const currency = lookupOrThrow(
    input,
    'currency_code',
    'SAR',
    `invoice currency`,
  );

  // Source company: client_source_company keyed on `${clientId}:${regPort}`.
  // Falls back to operator identity (e.g. "ناقل" / 340476) when not found.
  const regPort = input.config.defaultRegPortCode ?? '23';
  const sourceCompanyKey = `${first.canonical.clientId}:${regPort}`;
  const sourceCompany = lookup(input, 'client_source_company', sourceCompanyKey);
  const sourceCompanyName = sourceCompany
    ? String(sourceCompany.metadata['sourceCompanyName'] ?? '')
    : input.operator.identity.defaultSourceCompanyName;
  const sourceCompanyNo = sourceCompany
    ? sourceCompany.canonical
    : input.operator.identity.defaultSourceCompanyNo;

  return [
    '      <decsub:invoices>',
    `        <decsub:invoiceSeqNo>${xml(cfg(input.config.invoiceSeqNo))}</decsub:invoiceSeqNo>`,
    `        <deccm:invoiceType>${xml(cfg(input.config.invoiceTypeId))}</deccm:invoiceType>`,
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
    `        <deccm:deal>${xml(cfg(input.config.dealValue))}</deccm:deal>`,
    '        <decsub:paymentInfo>',
    `          <deccm:paymentInfoSeqNo>1</deccm:paymentInfoSeqNo>`,
    `          <deccm:invoicePayment>${xml(cfg(input.config.invoicePaymentMethodId))}</deccm:invoicePayment>`,
    `          <deccm:paymentDocumentsStatus>${xml(cfg(input.config.paymentDocumentStatusId))}</deccm:paymentDocumentsStatus>`,
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
  return n.toString();
}

function renderExportAirBL(input: RenderInput): string {
  const first = input.items[0]!;
  const carrierPrefix = deriveCarrierPrefix(first.canonical.waybillNo, input.config.defaultCarrierPrefix);
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

/**
 * Read a consignee-address field with the fallback chain:
 *   1. canonical.consigneeAddress.<field>  (per-row from request)
 *   2. operator_declaration_config.consignee_default_*  (operator-level default)
 *   3. tabdulCityFallback (streetAr only — Arabic city name from tabdul_city lookup)
 *   4. for streetAr: empty string; for the others: throw.
 */
function consigneeField(
  input: RenderInput,
  field: 'cityCode' | 'zipCode' | 'poBox' | 'streetAr',
  tabdulCityFallback?: string,
): string {
  const first = input.items[0]!;
  const fromRow = first.canonical.consigneeAddress?.[field] ?? null;
  if (fromRow !== null && fromRow !== '') return fromRow;
  const cfg = input.config;
  const fromOperator =
    field === 'cityCode' ? cfg.consigneeDefaultCityCode
    : field === 'zipCode' ? cfg.consigneeDefaultZipCode
    : field === 'poBox' ? cfg.consigneeDefaultPoBox
    : cfg.consigneeDefaultStreetAr;
  if (fromOperator !== null && fromOperator !== undefined && fromOperator !== '') return fromOperator;
  if (field === 'streetAr') {
    if (tabdulCityFallback !== undefined && tabdulCityFallback !== '') return tabdulCityFallback;
    return '';
  }
  throw new ZatcaRenderError(
    `consigneeAddress.${field} is null on canonical row and operator '${input.operator.slug}' has no consignee_default_${field} fallback in operator_declaration_config`,
    'missing_consignee_address',
    { operator: input.operator.slug, field },
  );
}

function renderExpressMail(input: RenderInput): string {
  const first = input.items[0]!;
  const c = first.canonical;
  const transportIdType = deriveTransportIdType(c.consigneeNationalId);

  // City: per-row consigneeAddress.cityCode wins. Otherwise fall back to
  // destination_station lookup -> operator default. The destination_station
  // path stays so the existing test xlsxs render unchanged until Naqel ships
  // a sample with consigneeCityCode columns.
  let cityCode: string;
  const rowCity = c.consigneeAddress?.cityCode ?? null;
  if (rowCity !== null && rowCity !== '') {
    cityCode = rowCity;
  } else {
    const destStation = lookup(input, 'destination_station', c.destinationStationId);
    if (destStation) {
      cityCode = destStation.canonical;
    } else {
      cityCode = consigneeField(input, 'cityCode');
    }
  }

  // Arabic address: per-row streetAr wins; otherwise operator default;
  // otherwise fall back to the Arabic city name (today's behaviour).
  const tabdulCity = lookup(input, 'tabdul_city', cityCode);
  const cityArName = tabdulCity?.canonical ?? '';
  const streetAr = consigneeField(input, 'streetAr', cityArName);

  const zipCode = consigneeField(input, 'zipCode');
  const poBox = consigneeField(input, 'poBox');

  return [
    '      <decsub:expressMailInfomation>',
    `        <deccm:transportType>${xml(cfg(input.config.expressTransportType))}</deccm:transportType>`,
    `        <deccm:transportIDType>${xml(transportIdType)}</deccm:transportIDType>`,
    `        <deccm:transportID>${xml(c.consigneeNationalId)}</deccm:transportID>`,
    `        <deccm:name>${xml(c.consigneeName)}</deccm:name>`,
    `        <deccm:addCtryCd>${xml(cfg(input.config.expressAddCountryCode))}</deccm:addCtryCd>`,
    `        <deccm:country>${xml(cfg(input.config.expressCountry))}</deccm:country>`,
    `        <deccm:city>${xml(cityCode)}</deccm:city>`,
    `        <deccm:zipCode>${xml(zipCode)}</deccm:zipCode>`,
    `        <deccm:poBox>${xml(poBox)}</deccm:poBox>`,
    `        <deccm:address>${xml(streetAr)}</deccm:address>`,
    `        <deccm:telephone>${xml(c.consigneePhone)}</deccm:telephone>`,
    '      </decsub:expressMailInfomation>',
  ].join('\n');
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  public entry point                                                       */
/* ──────────────────────────────────────────────────────────────────────── */

export function renderDeclarationXml(input: RenderInput): string {
  if (input.items.length === 0) {
    throw new ZatcaRenderError('cannot render declaration with zero items', 'empty_bundle');
  }
  if (input.bundleStrategy === 'HV_STANDALONE' && input.items.length !== 1) {
    throw new ZatcaRenderError(
      'HV_STANDALONE bundles must contain exactly one item',
      'bad_bundle_strategy',
      { strategy: 'HV_STANDALONE', actualItemCount: String(input.items.length) },
    );
  }

  const docRefNo = buildDocRefNo({
    prefix: input.config.docRefPrefix ?? undefined,
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
