import { describe, expect, it } from 'vitest';
import { expandBody, classifyBody } from '../../src/routes/schemas.js';

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
    '123456789012', // 12 digits — leaves are not valid expand parents
    'foo', // no digits
    '', // empty
    '12 34', // whitespace
    '1234567.', // trailing punctuation
  ])('rejects %s (must be 4–10 digits, no surrounding junk)', (code) => {
    const r = expandBody.safeParse({ code, description: 'shirt' });
    expect(r.success).toBe(false);
  });
});

describe('classifyBody', () => {
  it('requires non-empty description', () => {
    expect(classifyBody.safeParse({ description: '' }).success).toBe(false);
    expect(classifyBody.safeParse({ description: 'cotton t-shirt' }).success).toBe(true);
  });
});
