import { describe, it, expect } from 'vitest';
import { detectLang } from '../../src/util/lang.js';

describe('detectLang', () => {
  it('detects English', () => {
    expect(detectLang('cotton t-shirt for men')).toBe('en');
  });
  it('detects Arabic', () => {
    expect(detectLang('قميص قطن للرجال')).toBe('ar');
  });
  it('detects mixed', () => {
    expect(detectLang('cotton قميص shirt')).toBe('mixed');
  });
  it('detects unk on numerics', () => {
    expect(detectLang('1234')).toBe('unk');
  });
});
