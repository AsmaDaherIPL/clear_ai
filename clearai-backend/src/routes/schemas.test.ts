import { describe, expect, it } from 'vitest';
import { expandBody, boostBody, describeBody } from './schemas.js';

describe('expandBody.code regex', () => {
  it.each(['1234', '123456', '12345678', '1234567890'])('accepts %s (valid prefix length)', (code) => {
    const r = expandBody.safeParse({ code, description: 'shirt' });
    expect(r.success).toBe(true);
  });

  it.each([
    '12345', // 5 digits — earlier broken regex matched (starts with 4 digits)
    '1234567', // 7 digits — earlier matched (contains 6 digits)
    '123456789', // 9 digits — earlier matched (contains 8 digits)
    'abc123456def', // junk + 6 digits — earlier matched (contains 6 digits)
    '12345678901', // 11 digits
    '123456789012', // 12 digits — must use /boost, not /expand
    'foo', // no digits
    '', // empty
    '12 34', // whitespace
    '1234.', // trailing punctuation
  ])('rejects %s (must be exactly 4/6/8/10 digits)', (code) => {
    const r = expandBody.safeParse({ code, description: 'shirt' });
    expect(r.success).toBe(false);
  });
});

describe('boostBody.code regex', () => {
  it('accepts a 12-digit code', () => {
    expect(boostBody.safeParse({ code: '010121100000' }).success).toBe(true);
  });
  it.each(['1234567890', '0101211000000', 'abc123456789'])('rejects %s', (code) => {
    expect(boostBody.safeParse({ code }).success).toBe(false);
  });
});

describe('describeBody', () => {
  it('requires non-empty description', () => {
    expect(describeBody.safeParse({ description: '' }).success).toBe(false);
    expect(describeBody.safeParse({ description: 'cotton t-shirt' }).success).toBe(true);
  });
});
