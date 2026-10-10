import { describe, expect, it } from 'vitest';
import { normalizeSearch, slugify } from '../src/common/utils/normalize.js';
import { availableOf, isLowStock, isPurchasable, publicRemaining } from '../src/modules/inventory/inventory.logic.js';
import { egyptianPhoneSchema, checkoutRequestSchema } from '@nb/shared';
import { MemoryRateLimiter } from '../src/common/guards/memory-rate-limiter.js';

describe('arabic search normalisation', () => {
  it('folds hamza, taa marbuta, alef maqsura, diacritics and digits', () => {
    expect(normalizeSearch('دفتر أنيق')).toBe(normalizeSearch('دفتر انيق'));
    expect(normalizeSearch('مفكرة')).toBe(normalizeSearch('مفكره'));
    expect(normalizeSearch('هدايَا')).toBe(normalizeSearch('هدايا'));
    expect(normalizeSearch('١٢٣')).toBe('123');
    expect(normalizeSearch('  Hello   WORLD ')).toBe('hello world');
    expect(slugify('Custom Notebook!')).toBe('custom-notebook');
  });
});

describe('inventory rules', () => {
  const inv = (q: number, r: number, over = {}) => ({ quantity: q, reserved: r, trackInventory: true, allowBackorder: false, lowStockThreshold: 5, ...over });
  it('available = quantity - reserved', () => {
    expect(availableOf(inv(10, 3))).toBe(7);
    expect(availableOf(inv(1, 5))).toBe(0);
  });
  it('purchasable rules', () => {
    expect(isPurchasable(null)).toBe(true);
    expect(isPurchasable(inv(2, 0), 2)).toBe(true);
    expect(isPurchasable(inv(2, 1), 2)).toBe(false);
    expect(isPurchasable(inv(0, 0, { allowBackorder: true }), 9)).toBe(true);
    expect(isPurchasable(inv(0, 0, { trackInventory: false }), 9)).toBe(true);
  });
  it('low stock exposes the remaining count only when low', () => {
    expect(publicRemaining(inv(100, 0))).toBeNull();
    expect(publicRemaining(inv(4, 0))).toBe(4);
    expect(isLowStock(inv(0, 0))).toBe(false);
  });
});

describe('shared validation', () => {
  it('normalises Egyptian mobile numbers', () => {
    for (const v of ['01012345678', '+201012345678', '0020 101 234 5678', '010-1234-5678']) expect(egyptianPhoneSchema.parse(v)).toBe('+201012345678');
    for (const v of ['0212345678', '12345', '01312345678', 'abc']) expect(egyptianPhoneSchema.safeParse(v).success).toBe(false);
  });
  it('checkout request requires a valid payment method', () => {
    expect(checkoutRequestSchema.safeParse({ paymentMethod: 'COD' }).success).toBe(true);
    expect(checkoutRequestSchema.safeParse({ paymentMethod: 'CASH' }).success).toBe(false);
  });
});

describe('rate limiter', () => {
  it('allows up to the limit then blocks until the window passes', () => {
    const rl = new MemoryRateLimiter();
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) expect(rl.hit('k', 3, 60, t).allowed).toBe(true);
    const blocked = rl.hit('k', 3, 60, t + 1000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(rl.hit('k', 3, 60, t + 61_000).allowed).toBe(true);
    expect(rl.hit('other', 3, 60, t).allowed).toBe(true);
  });
});
