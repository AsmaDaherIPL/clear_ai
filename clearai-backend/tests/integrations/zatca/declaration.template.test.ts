/**
 * Renderer pinning test. We don't yet match the byte-by-byte exact post-
 * processed Naqel sample (full envelope parity is a Phase 5 follow-up — the
 * sample includes 50+ envelope fields the v0 renderer doesn't yet emit).
 *
 * This test pins what we DO emit so renderer regressions surface. The
 * snapshot includes:
 *   - the namespace declaration we got from env
 *   - the bundle-strategy attribute
 *   - one item block per row, in order
 *   - XML escaping on user-controlled fields
 */
import { describe, expect, it } from 'vitest';
import { renderDeclarationXml, ZatcaRenderError } from '../../../src/integrations/zatca/declaration/declaration.template.js';
import type { DeclarationSetItemRow } from '../../../src/db/schema.js';

function row(rowIndex: number, overrides: Partial<Record<string, unknown>> = {}): DeclarationSetItemRow {
  return {
    id: `item-${rowIndex}`,
    declarationSetId: 'set-1',
    rowIndex,
    canonical: {
      description: 'Cotton t-shirt',
      valueAmount: 125.5,
      currencyCode: 'USD',
      quantity: 10,
      uom: 'PCS',
      netWeightKg: 2.5,
      countryOfOrigin: 'IN',
      ...overrides,
    },
    status: 'succeeded',
    finalCode: '610910000099',
    classificationResult: null,
    trace: null,
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as DeclarationSetItemRow;
}

const baseInput = (items: DeclarationSetItemRow[]) => ({
  tenant: { slug: 'naqel', displayName: 'Naqel', constants: {} },
  bundleStrategy: 'LV_BUNDLED' as const,
  items,
  submitter: { carrierId: 'NAQ-CARRIER-1', name: 'Naqel' },
  namespaces: { decsub: 'http://www.saudiedi.com/schema/decsub' },
});

describe('renderDeclarationXml', () => {
  it('emits a stable envelope with namespaced elements', () => {
    const xml = renderDeclarationXml(baseInput([row(1)]));
    expect(xml).toMatchInlineSnapshot(`
      "<?xml version="1.0" encoding="UTF-8"?>
      <decsub:saudiEDI xmlns:decsub="http://www.saudiedi.com/schema/decsub" decsub:bundleStrategy="LV_BUNDLED">
        <decsub:submitter>
          <decsub:carrierId>NAQ-CARRIER-1</decsub:carrierId>
          <decsub:name>Naqel</decsub:name>
        </decsub:submitter>
        <decsub:items count="1">
          <decsub:item index="1">
            <decsub:description>Cotton t-shirt</decsub:description>
            <decsub:hsCode>610910000099</decsub:hsCode>
            <decsub:value currency="USD">125.5</decsub:value>
            <decsub:quantity uom="PCS">10</decsub:quantity>
            <decsub:netWeightKg>2.5</decsub:netWeightKg>
            <decsub:countryOfOrigin>IN</decsub:countryOfOrigin>
          </decsub:item>
        </decsub:items>
      </decsub:saudiEDI>
      "
    `);
  });

  it('escapes XML-significant characters in user-supplied text', () => {
    const xml = renderDeclarationXml(baseInput([row(1, { description: '<bad> & "stuff"' })]));
    expect(xml).toContain('&lt;bad&gt; &amp; &quot;stuff&quot;');
    expect(xml).not.toContain('<bad>');
  });

  it('emits item indices in input order', () => {
    const xml = renderDeclarationXml(baseInput([row(5), row(2), row(7)]));
    expect(xml).toMatch(/index="1"[\s\S]*index="2"[\s\S]*index="3"/);
  });

  it('rejects HV_STANDALONE bundles with multiple items', () => {
    expect(() =>
      renderDeclarationXml({
        ...baseInput([row(1), row(2)]),
        bundleStrategy: 'HV_STANDALONE',
      }),
    ).toThrowError(ZatcaRenderError);
  });

  it('rejects empty bundles', () => {
    expect(() => renderDeclarationXml(baseInput([]))).toThrowError(ZatcaRenderError);
  });
});
