/**
 * PR F: runProcessing tags the run-level error string with phase + code so
 * the SPA banner can render an actionable failure reason. Tests pin the
 * exact prefix shape because the SPA grep-parses it.
 *
 * Shape: `[phase=<phase> code=<code>] <message>` where the code attribute
 * is omitted when the error has no code field.
 */
import { describe, it, expect } from 'vitest';
import { __test__ } from '../../src/modules/batches/batch.use-case.js';
import { ZatcaRenderError } from '../../src/integrations/zatca/declaration/declaration.template.js';

const { formatRunError } = __test__;

describe('formatRunError — run-level error tagging', () => {
  it('prefixes a typed ZatcaRenderError with phase + code', () => {
    const err = new ZatcaRenderError(
      "invoice currency: no tabadul_codes / operator_lookups row for operator='naqel' type='currency_code' source='SAR'",
      'missing_lookup',
    );
    const out = formatRunError('declaration', err);
    expect(out).toMatch(/^\[phase=declaration code=missing_lookup\] /);
    expect(out).toContain('SAR');
  });

  it('drops the code attribute when the error has no code field', () => {
    const err = new Error('plain error from somewhere');
    const out = formatRunError('classification', err);
    expect(out).toMatch(/^\[phase=classification\] /);
    expect(out).toContain('plain error from somewhere');
    expect(out).not.toContain('code=');
  });

  it('handles a thrown non-Error value (e.g. a bare string)', () => {
    const out = formatRunError('declaration', 'something went sideways');
    expect(out).toMatch(/^\[phase=declaration\] /);
    expect(out).toContain('something went sideways');
  });

  it('truncates very long messages to <= 1000 chars + ellipsis', () => {
    const huge = 'x'.repeat(2000);
    const err = new Error(huge);
    const out = formatRunError('declaration', err);
    expect(out.length).toBeLessThanOrEqual(1001);
    expect(out.endsWith('…')).toBe(true);
  });

  it('preserves the message verbatim after the prefix when short', () => {
    const err = new ZatcaRenderError('cannot render declaration with zero items', 'empty_bundle');
    const out = formatRunError('declaration', err);
    expect(out).toBe('[phase=declaration code=empty_bundle] cannot render declaration with zero items');
  });

  it('uses unknown phase when called before either phase has started', () => {
    const out = formatRunError('unknown', new Error('boot-time crash'));
    expect(out).toMatch(/^\[phase=unknown\] /);
  });
});
