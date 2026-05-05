/**
 * String-template renderer for the decsub:saudiEDI envelope.
 *
 * Hand-written. XSD ordering matters; we use string templates with explicit
 * element order so byte-by-byte verification against the sample post-processed
 * XMLs is feasible.
 *
 * Fields that vary per submission are interpolated via `xml(...)` (which
 * escapes < > & ' " on every value). All other characters pass through.
 *
 * v0 scope: emits a minimal envelope with the records the post-processed
 * NQD26033110789.XML sample defines. Full feature parity is tracked as a
 * Phase 5 follow-up; the test in tests/integrations/zatca/declaration.template
 * pins what we currently emit.
 */
import type { RenderInput } from './declaration.types.js';
import type { DeclarationSetItemRow } from '../../../db/schema.js';

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

function renderItemBlock(item: DeclarationSetItemRow, idx: number): string {
  const c = item.canonical;
  const description = xml(c.description);
  const finalCode = xml(item.finalCode ?? '');
  const value = xml(c.valueAmount);
  const currency = xml(c.currencyCode);
  const qty = xml(c.quantity);
  const uom = xml(c.uom);
  const net = xml(c.netWeightKg);
  const country = xml(c.countryOfOrigin);
  return [
    `    <decsub:item index="${idx}">`,
    `      <decsub:description>${description}</decsub:description>`,
    `      <decsub:hsCode>${finalCode}</decsub:hsCode>`,
    `      <decsub:value currency="${currency}">${value}</decsub:value>`,
    `      <decsub:quantity uom="${uom}">${qty}</decsub:quantity>`,
    `      <decsub:netWeightKg>${net}</decsub:netWeightKg>`,
    `      <decsub:countryOfOrigin>${country}</decsub:countryOfOrigin>`,
    `    </decsub:item>`,
  ].join('\n');
}

export function renderDeclarationXml(input: RenderInput): string {
  if (input.items.length === 0) {
    throw new ZatcaRenderError('cannot render declaration with zero items');
  }
  if (input.bundleStrategy === 'HV_STANDALONE' && input.items.length !== 1) {
    throw new ZatcaRenderError('HV_STANDALONE bundles must contain exactly one item');
  }

  const ns = xml(input.namespaces.decsub);
  const carrier = xml(input.submitter.carrierId);
  const carrierName = xml(input.submitter.name);
  const itemsXml = input.items.map((it, i) => renderItemBlock(it, i + 1)).join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<decsub:saudiEDI xmlns:decsub="${ns}" decsub:bundleStrategy="${input.bundleStrategy}">`,
    `  <decsub:submitter>`,
    `    <decsub:carrierId>${carrier}</decsub:carrierId>`,
    `    <decsub:name>${carrierName}</decsub:name>`,
    `  </decsub:submitter>`,
    `  <decsub:items count="${input.items.length}">`,
    itemsXml,
    `  </decsub:items>`,
    `</decsub:saudiEDI>`,
    '',
  ].join('\n');
}
