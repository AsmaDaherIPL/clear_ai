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
 *   • docRefNo: deterministic from batch_id + bundle_index, NOT
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
 * 3 if starts with '2'. Anything else (including null) falls back to '5'
 * (the more permissive default). Null happens for ~3.5% of Naqel rows where
 * the source feed never carried a national ID.
 */
function deriveTransportIdType(consigneeNationalId: string | null): string {
  if (!consigneeNationalId) return '5';
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

  // Country of origin: emit ISO alpha-2 verbatim (e.g. "GB", "US", "CN").
  // Sample evidence: post-processed item 1 emits "US", item 2 emits "GB",
  // NQD26030942060 emits "CN". The lookup is still called to VALIDATE the
  // code exists; we throw on unknown rather than ship a country ZATCA
  // can't resolve. We do NOT emit the Tabadul numeric (country.canonical)
  // here even though the lookup carries one — that was the pre-fix bug.
  lookupOrThrow(input, 'country_of_origin', c.countryOfOrigin, `item ${seq} country_of_origin`);
  const countryIso = c.countryOfOrigin.trim().toUpperCase();

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
  // Amounts: emit SOURCE currency values, NOT SAR-converted. ZATCA expects
  // the invoice currency code + amount to stay in source units (see sample
  // NQD26033110789: AED-source invoice ships invoiceCurrency=120 and
  // invoiceCost=3426.35, both in AED). The pipeline's valueAmountSar is
  // for bundling decisions (HV/LV partition + LV invoice cap); the
  // renderer reads the raw valueAmount.
  const unitInvoiceCost = Number(c.valueAmount ?? 0);
  const itemCost = unitInvoiceCost * qty;

  return [
    `        <decsub:items>`,
    `          <deccm:itemSeqNo>${seq}</deccm:itemSeqNo>`,
    `          <deccm:countryOfOrigin>${xml(countryIso)}</deccm:countryOfOrigin>`,
    `          <deccm:tariffCode>${xml(tariffCode)}</deccm:tariffCode>`,
    `          <deccm:goodsDescription>${xml(goodsDescription)}</deccm:goodsDescription>`,
    `          <deccm:invoiceMeasurementUnit>${xml(uom.canonical)}</deccm:invoiceMeasurementUnit>`,
    `          <deccm:quantityInvoiceUnit>${xml(qty)}</deccm:quantityInvoiceUnit>`,
    `          <deccm:internationalMeasurementUnit>${xml(uom.canonical)}</deccm:internationalMeasurementUnit>`,
    `          <deccm:quantityInternationalUnit>${xml(qty)}</deccm:quantityInternationalUnit>`,
    `          <deccm:grossWeight>${xml(formatNumeric(weight, 3))}</deccm:grossWeight>`,
    `          <deccm:netWeight>${xml(formatNumeric(weight, 3))}</deccm:netWeight>`,
    `          <deccm:unitPerPackages>${xml(cfg(input.config.itemUnitPerPackages))}</deccm:unitPerPackages>`,
    `          <deccm:unitInvoiceCost>${xml(formatNumeric(unitInvoiceCost, 3))}</deccm:unitInvoiceCost>`,
    `          <deccm:itemCost>${xml(formatNumeric(itemCost, 2))}</deccm:itemCost>`,
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
  // invoiceCost = sum of itemCost in SOURCE currency. We do NOT FX-convert
  // here: sample NQD26033110789 ships an AED invoice with currency code
  // 120 (AED Tabadul id) and amount 3426.35 — both in AED, no SAR
  // conversion. The pipeline's valueAmountSar is used elsewhere for HV/LV
  // bundling decisions; the renderer reads the raw valueAmount.
  const totalCost = items.reduce((s, it) => {
    const c = it.canonical;
    const unit = Number(c.valueAmount ?? 0);
    return s + unit * Number(c.quantity ?? 0);
  }, 0);
  const totalWeight = items.reduce((s, it) => s + Number(it.canonical.netWeightKg || 0), 0);

  // Invoice currency: look up the ROW's currency, not a hardcoded SAR.
  // Per spec sample evidence, ZATCA accepts foreign-currency invoices
  // (NQD26033110789 = AED). The bundler guarantees one bundle = one
  // currency upstream (we don't mix currencies within a single
  // declaration), so reading the first item's currency is sound.
  const first = items[0]!;
  const firstCurrencyCode = String(first.canonical.currencyCode ?? 'SAR').toUpperCase();
  const currency = lookupOrThrow(
    input,
    'currency_code',
    firstCurrencyCode,
    `invoice currency (${firstCurrencyCode})`,
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
    `        <deccm:invoiceCost>${xml(formatNumeric(totalCost, 2))}</deccm:invoiceCost>`,
    `        <deccm:invoiceCurrency>${xml(currency.canonical)}</deccm:invoiceCurrency>`,
    `        <deccm:totalGrossWeight>${xml(formatNumeric(totalWeight, 3))}</deccm:totalGrossWeight>`,
    `        <deccm:totalNetWeight>${xml(formatNumeric(totalWeight, 3))}</deccm:totalNetWeight>`,
    '        <decsub:sourceCompany>',
    `          <deccm:sourceCompanyName>${xml(sourceCompanyName)}</deccm:sourceCompanyName>`,
    `          <decsub:sourceCompanyNo>${xml(sourceCompanyNo)}</decsub:sourceCompanyNo>`,
    '        </decsub:sourceCompany>',
    `        <deccm:deal>${xml(cfg(input.config.dealValue))}</deccm:deal>`,
    '        <decsub:paymentInfo>',
    `          <deccm:paymentInfoSeqNo>1</deccm:paymentInfoSeqNo>`,
    `          <deccm:invoicePayment>${xml(cfg(input.config.invoicePaymentMethodId))}</deccm:invoicePayment>`,
    `          <deccm:paymentDocumentsStatus>${xml(cfg(input.config.paymentDocumentStatusId))}</deccm:paymentDocumentsStatus>`,
    `          <deccm:documentAmount>${xml(formatNumeric(totalCost, 2))}</deccm:documentAmount>`,
    '        </decsub:paymentInfo>',
    renderInvoiceItems(items, input),
    '      </decsub:invoices>',
  ].join('\n');
}

/**
 * Format a number for XML emission. Rounds to `maxDecimals` precision
 * (defeating IEEE-754 noise like 5583.429999999999 -> "5583.43") then
 * drops a trailing ".0" on integers so a round amount renders as "1080"
 * not "1080.00" (matches sample NQD26033110790: <invoiceCost>1080</...>).
 *
 * Decimal budgets used by callers:
 *   - currency totals/items:    2  (invoiceCost, itemCost, documentAmount)
 *   - per-unit currency:        3  (unitInvoiceCost — sample 1 shows 29.297)
 *   - weights:                  3  (grossWeight / netWeight / totals)
 */
function formatNumeric(n: number, maxDecimals = 2): string {
  if (!Number.isFinite(n)) return '0';
  if (!Number.isInteger(maxDecimals) || maxDecimals < 0 || maxDecimals > 10) {
    throw new RangeError(`formatNumeric maxDecimals must be 0..10, got ${maxDecimals}`);
  }
  const rounded = Number(n.toFixed(maxDecimals));
  if (Number.isInteger(rounded)) return String(rounded);
  // toString on the rounded value is safe — Number(toFixed(N)) collapses
  // IEEE noise that survived parsing. Trailing-zero stripping is implicit
  // (Number("0.380") -> 0.38 -> "0.38").
  return String(rounded);
}

function renderExportAirBL(input: RenderInput): string {
  // BL-coverage fix (2026-05-24): emit one <exportAirBL> block per
  // DISTINCT source waybillNo. Previous behaviour took only items[0]
  // and emitted a single block, even when the declaration bundled
  // items from N different AWBs — that produced declarations claiming
  // to cover 1 shipment but containing line items from up to ~25
  // shipments. NQM26051745922 demonstrated the failure (1 BL listed
  // vs 39 contributing AWBs in the source xlsx).
  //
  // Iterate in first-seen order so the XML output is deterministic
  // and tracks the natural row order of the input. carrierPrefix and
  // airBLDate are derived per-waybill from the row's own canonical
  // fields, not hardcoded from items[0].
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const item of input.items) {
    const waybillNo = item.canonical.waybillNo;
    if (!waybillNo || seen.has(waybillNo)) continue;
    seen.add(waybillNo);
    const carrierPrefix = deriveCarrierPrefix(waybillNo, input.config.defaultCarrierPrefix);
    const blDate = item.canonical.invoiceDate ?? isoDate(input.now);
    blocks.push(
      [
        '      <decsub:exportAirBL>',
        `        <deccm:carrierPrefix>${xml(carrierPrefix)}</deccm:carrierPrefix>`,
        `        <deccm:airBLNo>${xml(waybillNo)}</deccm:airBLNo>`,
        `        <deccm:airBLDate>${xml(blDate)}</deccm:airBLDate>`,
        '      </decsub:exportAirBL>',
      ].join('\n'),
    );
  }
  // Defensive fallback: items array is empty (shouldn't happen under
  // normal flow — bundling drops empty bundles upstream). Emit a
  // placeholder so the XML is still schema-valid rather than throwing.
  if (blocks.length === 0) {
    const first = input.items[0];
    if (first === undefined) {
      throw new Error('renderExportAirBL invariant: items array is empty');
    }
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
  return blocks.join('\n');
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
    // transportID is '0' when consigneeNationalId is null — matches the
    // placeholder Naqel uses in some of its own samples where the field was
    // unavailable. ZATCA accepts the declaration as long as the element
    // exists, so we always emit it.
    `        <deccm:transportID>${xml(c.consigneeNationalId ?? '0')}</deccm:transportID>`,
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
