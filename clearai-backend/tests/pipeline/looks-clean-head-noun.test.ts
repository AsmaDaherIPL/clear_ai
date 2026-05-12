import { describe, it, expect } from 'vitest';
import { looksClean } from '../../src/modules/pipeline/cleanup/description-cleanup.js';

describe('looksClean — ambiguous head noun guard', () => {
  it('returns false for "diaper bag"', () => expect(looksClean('diaper bag')).toBe(false));
  it('returns false for "phone case"', () => expect(looksClean('phone case')).toBe(false));
  it('returns false for "laptop sleeve"', () => expect(looksClean('laptop sleeve')).toBe(false));
  it('returns false for "tool kit"', () => expect(looksClean('tool kit')).toBe(false));
  it('returns false for "gift bag"', () => expect(looksClean('gift bag')).toBe(false));
  it('returns false for "shopping bag"', () => expect(looksClean('shopping bag')).toBe(false));
  it('returns false for "travel wallet"', () => expect(looksClean('travel wallet')).toBe(false));
  it('returns true for "cotton pantyhose" (pantyhose is not a container)', () => expect(looksClean('cotton pantyhose')).toBe(true));
  it('returns true for "water flosser" (flosser is not a container)', () => expect(looksClean('water flosser')).toBe(true));
  it('returns true for "psychology textbook"', () => expect(looksClean('psychology textbook')).toBe(true));
  it('returns false for "Giggles Floral Print Diaper Bag" (>4 tokens → fails token count first)', () => expect(looksClean('Giggles Floral Print Diaper Bag')).toBe(false));
  it('returns false for pure "bag"', () => expect(looksClean('bag')).toBe(false));
  it('returns false for pure "case"', () => expect(looksClean('case')).toBe(false));
  it('returns false for "a bag" (stop words stripped to "bag")', () => expect(looksClean('a bag')).toBe(false));
});
