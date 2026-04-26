import { describe, it, expect } from 'vitest';
import { digitNormalize, type KnownPrefixes } from './digit-normalize.js';

const known: KnownPrefixes = {
  chapters: new Set(['01', '61']),
  headings: new Set(['0101', '6109']),
  hs6: new Set(['010121', '610910']),
  hs8: new Set(['01012110', '61091000']),
  hs10: new Set(['0101211000', '6109100000']),
};

describe('digitNormalize', () => {
  it('keeps <4-digit runs as text noise', () => {
    const r = digitNormalize('shirt 89', known);
    expect(r.cleanedText).toBe('shirt 89');
    expect(r.prefixBias).toBeNull();
    expect(r.detected[0]?.action).toBe('kept_as_text');
  });

  it('strips 5-digit run with no prefix match', () => {
    const r = digitNormalize('cotton tshirt 89123', known);
    expect(r.cleanedText).toBe('cotton tshirt');
    expect(r.prefixBias).toBeNull();
    expect(r.detected[0]?.action).toBe('stripped');
  });

  it('biases on 4-digit heading match', () => {
    const r = digitNormalize('cotton tshirt 6109', known);
    expect(r.cleanedText).toBe('cotton tshirt 6109');
    expect(r.prefixBias).toBe('6109');
    expect(r.detected[0]?.action).toBe('biased');
  });

  it('defers exactly-12-digit runs', () => {
    const r = digitNormalize('shirt 010121100000', known);
    expect(r.detected[0]?.action).toBe('deferred_12');
    expect(r.cleanedText).toContain('010121100000');
  });

  it('treats >12-digit runs as text noise', () => {
    const r = digitNormalize('code 1234567890123', known);
    expect(r.detected[0]?.action).toBe('kept_as_text');
  });

  it('takes the longest matching prefix as bias', () => {
    const r = digitNormalize('item 01012110 here', known);
    expect(r.prefixBias).toBe('01012110');
  });
});
