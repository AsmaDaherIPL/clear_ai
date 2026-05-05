import { describe, expect, it } from 'vitest';
import {
  redactString,
  redactJsonValue,
  redactRequestBody,
} from '../../src/common/logging/redact.js';

describe('redactString', () => {
  it('passes clean text through', () => {
    expect(redactString('men white cotton shirt')).toBe('men white cotton shirt');
    expect(redactString('olive oil 500ml glass bottle')).toBe('olive oil 500ml glass bottle');
  });

  it('redacts emails', () => {
    expect(redactString('contact buyer at jane.doe@example.com today')).toBe(
      'contact buyer at [REDACTED:email] today',
    );
  });

  it('redacts international phones', () => {
    expect(redactString('phone +966 50 123 4567')).toMatch(/\[REDACTED:phone\]/);
    expect(redactString('contact 00966501234567')).toMatch(/\[REDACTED:phone\]/);
  });

  it('redacts Saudi-style local phones', () => {
    expect(redactString('mobile 0501234567')).toMatch(/\[REDACTED:phone\]/);
  });

  it('redacts URLs', () => {
    expect(redactString('see https://attacker.example/path?x=1 for details')).toBe(
      'see [REDACTED:url] for details',
    );
  });

  it('redacts long all-digit IDs', () => {
    expect(redactString('national id 1234567890123 attached')).toMatch(/\[REDACTED:id\]/);
  });

  it('does NOT redact 12-digit HS codes when in HS context', () => {
    // The negative lookbehind on "code:" / "hs" / etc. should keep HS codes intact.
    expect(redactString('hs code: 610910001000')).toContain('610910001000');
  });

  it('does NOT redact short numbers (likely prices, quantities)', () => {
    expect(redactString('price 250 SAR, qty 12 boxes')).toBe('price 250 SAR, qty 12 boxes');
  });

  it('handles Arabic text', () => {
    expect(redactString('رقم الهاتف 0501234567')).toMatch(/\[REDACTED:phone\]/);
  });
});

describe('redactJsonValue', () => {
  it('preserves object shape and redacts string leaves', () => {
    const input = {
      description: 'shirt from supplier@example.com',
      quantity: 100,
      buyer_phone: '+966501234567',
      shipping: {
        url: 'https://tracking.example/123',
        notes: null,
      },
    };
    const out = redactJsonValue(input) as typeof input;
    expect(out.description).toBe('shirt from [REDACTED:email]');
    expect(out.quantity).toBe(100);
    expect(out.buyer_phone).toMatch(/\[REDACTED:phone\]/);
    expect(out.shipping.url).toBe('[REDACTED:url]');
    expect(out.shipping.notes).toBeNull();
  });

  it('preserves array shape', () => {
    const input = ['clean', 'contact me at me@x.com'];
    const out = redactJsonValue(input) as string[];
    expect(out[0]).toBe('clean');
    expect(out[1]).toBe('contact me at [REDACTED:email]');
  });

  it('handles null and undefined', () => {
    expect(redactJsonValue(null)).toBeNull();
    expect(redactJsonValue(undefined)).toBeUndefined();
  });

  it('passes numbers, booleans through', () => {
    expect(redactJsonValue(42)).toBe(42);
    expect(redactJsonValue(true)).toBe(true);
  });

  it('handles cycles without crashing', () => {
    const a: { name: string; self?: unknown } = { name: 'jane@x.com' };
    a.self = a;
    const out = redactJsonValue(a) as { name: string; self: unknown };
    expect(out.name).toBe('[REDACTED:email]');
    expect(out.self).toBe('[REDACTED:cycle]');
  });
});

describe('redactRequestBody', () => {
  it('returns null for null input', () => {
    expect(redactRequestBody(null)).toBeNull();
    expect(redactRequestBody(undefined)).toBeNull();
  });

  it('redacts a typical classify request body', () => {
    const body = { description: 'cotton shirt for buyer +966501234567' };
    const out = redactRequestBody(body) as typeof body;
    expect(out.description).toMatch(/\[REDACTED:phone\]/);
  });
});
