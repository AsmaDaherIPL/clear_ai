/**
 * PR F: ZatcaRenderError now carries a typed `code` and `details` so the
 * run-level error string can be tagged with phase + code, letting the SPA
 * banner render an actionable message instead of generic "Run failed".
 */
import { describe, it, expect } from 'vitest';
import { ZatcaRenderError } from '../../src/integrations/zatca/declaration/declaration.template.js';

describe('ZatcaRenderError — typed code + details', () => {
  it('defaults to render_error code with empty details when only message is supplied', () => {
    const err = new ZatcaRenderError('something exploded');
    expect(err.code).toBe('render_error');
    expect(err.details).toEqual({});
    expect(err.message).toBe('something exploded');
    expect(err.name).toBe('ZatcaRenderError');
  });

  it('accepts a typed code and structured details', () => {
    const err = new ZatcaRenderError(
      "invoice currency: no tabadul_codes / operator_lookups row for operator='naqel' type='currency_code' source='SAR'",
      'missing_lookup',
      { operator: 'naqel', type: 'currency_code', source: 'SAR', ctx: 'invoice currency' },
    );
    expect(err.code).toBe('missing_lookup');
    expect(err.details).toEqual({
      operator: 'naqel',
      type: 'currency_code',
      source: 'SAR',
      ctx: 'invoice currency',
    });
  });

  it('is still an Error subclass — instanceof + message reading work as before', () => {
    const err = new ZatcaRenderError('boom', 'empty_bundle');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ZatcaRenderError);
    expect(err.message).toBe('boom');
  });

  it('keeps the code field readable by the runProcessing catch block', () => {
    // The catch in declaration-run.use-case.runProcessing reads `err.code`
    // generically (any object with a string code). Confirm the contract.
    const err: unknown = new ZatcaRenderError('x', 'missing_consignee_address', { field: 'cityCode' });
    if (err && typeof err === 'object' && 'code' in err) {
      expect((err as { code: string }).code).toBe('missing_consignee_address');
    } else {
      throw new Error('code field unreachable');
    }
  });
});
