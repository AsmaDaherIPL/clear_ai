import { describe, expect, it } from 'vitest';
import { expandBody, boostBody, describeBody } from '../../src/routes/schemas.js';

describe('expandBody.code regex', () => {
  it.each([
    '1234', // 4 digits — heading level (e.g. 1509 = olive oil)
    '12345',
    '123456',
    '1234567',
    '12345678',
    '123456789',
    '1234567890',
  ])('accepts %s (4–10 digit prefix)', (code) => {
    const r = expandBody.safeParse({ code, description: 'shirt' });
    expect(r.success).toBe(true);
  });

  it.each([
    '123', // 3 digits — chapter is too coarse to be useful as a parent
    'abc123456def', // junk surrounding digits
    '12345678901', // 11 digits — too long
    '123456789012', // 12 digits — must use /boost, not /expand
    'foo', // no digits
    '', // empty
    '12 34', // whitespace
    '1234567.', // trailing punctuation
  ])('rejects %s (must be 4–10 digits, no surrounding junk)', (code) => {
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
