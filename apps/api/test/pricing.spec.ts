import { describe, expect, it } from 'vitest';
import { computeTotals, estimateDelivery, evaluateCoupon, lineUnitPrice, shippingFeeFor, subtotalOf } from '../src/modules/pricing/pricing.js';
import type { CouponDef, PricedLine } from '../src/modules/pricing/pricing.js';

const line = (over: Partial<PricedLine> = {}): PricedLine => ({ productId: 'p1', variantId: 'v1', quantity: 1, unitPrice: 10000, collectionIds: [], ...over });
const coupon = (over: Partial<CouponDef> = {}): CouponDef => ({
  id: 'c1', code: 'X', type: 'PERCENTAGE', value: 1000, minSubtotal: null, maxDiscount: null, startsAt: null, endsAt: null,
  usageLimit: null, usedCount: 0, perUserLimit: null, active: true, appliesToAll: true, productIds: [], collectionIds: [], ...over,
});
const ctx = { now: new Date('2026-06-01T00:00:00Z'), priorUsesByCustomer: 0 };

describe('line pricing', () => {
  it('adds variant and customization deltas, never below zero', () => {
    expect(lineUnitPrice(45000, 2000, 5000)).toBe(52000);
    expect(lineUnitPrice(1000, -5000, 0)).toBe(0);
  });
  it('subtotal multiplies by quantity', () => {
    expect(subtotalOf([line({ quantity: 3 }), line({ unitPrice: 500 })])).toBe(30500);
  });
});

describe('coupons', () => {
  it('percentage (basis points) with max cap', () => {
    const r = evaluateCoupon(coupon({ value: 2000, maxDiscount: 1500 }), [line({ unitPrice: 20000 })], ctx);
    expect(r).toEqual({ ok: true, discount: 1500, eligibleSubtotal: 20000 });
  });
  it('fixed never exceeds the subtotal', () => {
    const r = evaluateCoupon(coupon({ type: 'FIXED', value: 99999 }), [line({ unitPrice: 5000 })], ctx);
    expect(r.ok && r.discount).toBe(5000);
  });
  it('rejects inactive, expired, not started, exhausted, per-user exceeded, below minimum', () => {
    const lines = [line()];
    expect(evaluateCoupon(coupon({ active: false }), lines, ctx)).toMatchObject({ ok: false, code: 'COUPON_INVALID' });
    expect(evaluateCoupon(coupon({ endsAt: new Date('2026-01-01') }), lines, ctx)).toMatchObject({ code: 'COUPON_EXPIRED' });
    expect(evaluateCoupon(coupon({ startsAt: new Date('2026-12-01') }), lines, ctx)).toMatchObject({ code: 'COUPON_EXPIRED' });
    expect(evaluateCoupon(coupon({ usageLimit: 5, usedCount: 5 }), lines, ctx)).toMatchObject({ code: 'COUPON_LIMIT_REACHED' });
    expect(evaluateCoupon(coupon({ perUserLimit: 1 }), lines, { ...ctx, priorUsesByCustomer: 1 })).toMatchObject({ code: 'COUPON_LIMIT_REACHED' });
    expect(evaluateCoupon(coupon({ minSubtotal: 50000 }), lines, ctx)).toMatchObject({ code: 'COUPON_MIN_SUBTOTAL' });
  });
  it('targets only eligible products / collections', () => {
    const lines = [line({ productId: 'a', unitPrice: 10000 }), line({ productId: 'b', unitPrice: 30000, collectionIds: ['col'] })];
    expect(evaluateCoupon(coupon({ appliesToAll: false, productIds: ['a'] }), lines, ctx)).toMatchObject({ ok: true, discount: 1000 });
    expect(evaluateCoupon(coupon({ appliesToAll: false, collectionIds: ['col'] }), lines, ctx)).toMatchObject({ ok: true, discount: 3000 });
    expect(evaluateCoupon(coupon({ appliesToAll: false, productIds: ['zzz'] }), lines, ctx)).toMatchObject({ ok: false, code: 'COUPON_NOT_APPLICABLE' });
  });
});

describe('shipping + delivery', () => {
  it('free shipping at the threshold (after discounts)', () => {
    const rate = { baseFee: 6000, freeOverSubtotal: 150000 };
    expect(shippingFeeFor(rate, 149999)).toBe(6000);
    expect(shippingFeeFor(rate, 150000)).toBe(0);
    expect(shippingFeeFor({ baseFee: 6000, freeOverSubtotal: null }, 9e9)).toBe(6000);
  });
  it('delivery = lead time + transit days', () => {
    expect(estimateDelivery(new Date('2026-01-01T00:00:00Z'), 3, 2).toISOString()).toBe('2026-01-06T00:00:00.000Z');
  });
});

describe('totals', () => {
  const off = { enabled: false, rateBps: 0, inclusive: false };
  it('no tax: subtotal - discount + shipping + cod fee', () => {
    expect(computeTotals({ subtotal: 100000, discount: 10000, shippingFee: 6000, codFee: 2000, tax: off })).toMatchObject({ total: 98000, tax: 0 });
  });
  it('exclusive VAT is added on top of everything charged', () => {
    const t = computeTotals({ subtotal: 100000, discount: 0, shippingFee: 0, codFee: 0, tax: { enabled: true, rateBps: 1400, inclusive: false } });
    expect(t).toMatchObject({ tax: 14000, total: 114000, taxIncluded: false });
  });
  it('inclusive VAT is itemised, total unchanged', () => {
    const t = computeTotals({ subtotal: 114000, discount: 0, shippingFee: 0, codFee: 0, tax: { enabled: true, rateBps: 1400, inclusive: true } });
    expect(t).toMatchObject({ tax: 14000, total: 114000, taxIncluded: true });
  });
  it('discount can never exceed the subtotal', () => {
    expect(computeTotals({ subtotal: 5000, discount: 99999, shippingFee: 0, codFee: 0, tax: off }).total).toBe(0);
  });
  it('amounts stay integers', () => {
    const t = computeTotals({ subtotal: 33333, discount: 0, shippingFee: 777, codFee: 0, tax: { enabled: true, rateBps: 1400, inclusive: false } });
    expect(Number.isInteger(t.total) && Number.isInteger(t.tax)).toBe(true);
  });
});
