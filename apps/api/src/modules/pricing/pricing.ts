/**
 * Pricing — PURE functions. All amounts are INTEGER piasters; rates are basis points (1400 = 14%).
 * The server is the only source of truth for prices: clients never send amounts.
 */
import { percentOf } from '../../common/utils/money.js';

export interface PricedLine {
  productId: string;
  variantId: string;
  quantity: number;
  unitPrice: number;
  collectionIds: string[];
}

export function lineUnitPrice(basePrice: number, variantDelta: number, customizationDelta: number): number {
  return Math.max(0, basePrice + variantDelta + customizationDelta);
}

export function lineTotal(line: Pick<PricedLine, 'unitPrice' | 'quantity'>): number {
  return line.unitPrice * line.quantity;
}

export function subtotalOf(lines: Array<Pick<PricedLine, 'unitPrice' | 'quantity'>>): number {
  return lines.reduce((sum, l) => sum + lineTotal(l), 0);
}

// ------------------------------------------------------------------------------------------ coupons

export interface CouponDef {
  id: string;
  code: string;
  type: 'PERCENTAGE' | 'FIXED';
  /** PERCENTAGE: basis points. FIXED: piasters. */
  value: number;
  minSubtotal: number | null;
  maxDiscount: number | null;
  startsAt: Date | null;
  endsAt: Date | null;
  usageLimit: number | null;
  usedCount: number;
  perUserLimit: number | null;
  active: boolean;
  appliesToAll: boolean;
  productIds: string[];
  collectionIds: string[];
}

export interface CouponContext {
  now: Date;
  /** How many times this customer (user id or guest email) already used the coupon. */
  priorUsesByCustomer: number;
}

export type CouponResult =
  | { ok: true; discount: number; eligibleSubtotal: number }
  | { ok: false; code: string; params?: Record<string, unknown> };

export function evaluateCoupon(coupon: CouponDef, lines: PricedLine[], ctx: CouponContext): CouponResult {
  if (!coupon.active) return { ok: false, code: 'COUPON_INVALID' };
  if ((coupon.startsAt && ctx.now < coupon.startsAt) || (coupon.endsAt && ctx.now > coupon.endsAt)) {
    return { ok: false, code: 'COUPON_EXPIRED' };
  }
  if (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit) return { ok: false, code: 'COUPON_LIMIT_REACHED' };
  if (coupon.perUserLimit !== null && ctx.priorUsesByCustomer >= coupon.perUserLimit) return { ok: false, code: 'COUPON_LIMIT_REACHED' };

  const subtotal = subtotalOf(lines);
  if (coupon.minSubtotal !== null && subtotal < coupon.minSubtotal) {
    return { ok: false, code: 'COUPON_MIN_SUBTOTAL', params: { min: (coupon.minSubtotal / 100).toFixed(2) } };
  }

  const eligible = coupon.appliesToAll
    ? lines
    : lines.filter((l) => coupon.productIds.includes(l.productId) || l.collectionIds.some((c) => coupon.collectionIds.includes(c)));
  const eligibleSubtotal = subtotalOf(eligible);
  if (eligibleSubtotal <= 0) return { ok: false, code: 'COUPON_NOT_APPLICABLE' };

  let discount = coupon.type === 'PERCENTAGE' ? percentOf(eligibleSubtotal, coupon.value) : Math.min(coupon.value, eligibleSubtotal);
  if (coupon.maxDiscount !== null) discount = Math.min(discount, coupon.maxDiscount);
  discount = Math.max(0, Math.min(discount, eligibleSubtotal));
  return { ok: true, discount, eligibleSubtotal };
}

// ------------------------------------------------------------------------------------------ shipping

export interface ShippingRateDef {
  baseFee: number;
  freeOverSubtotal: number | null;
}

/** `amount` is the subtotal after discounts. */
export function shippingFeeFor(rate: ShippingRateDef, amount: number): number {
  if (rate.freeOverSubtotal !== null && amount >= rate.freeOverSubtotal) return 0;
  return rate.baseFee;
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/** Production lead time + the zone's maximum transit days. */
export function estimateDelivery(now: Date, leadTimeDays: number, zoneDaysMax: number): Date {
  return addDays(now, Math.max(0, leadTimeDays) + Math.max(0, zoneDaysMax));
}

// ------------------------------------------------------------------------------------------ totals

export interface TaxConfig {
  enabled: boolean;
  rateBps: number;
  /** true: prices already include tax (it is only itemised). */
  inclusive: boolean;
}

export interface TotalsInput {
  subtotal: number;
  discount: number;
  shippingFee: number;
  codFee: number;
  tax: TaxConfig;
}

export interface Totals {
  subtotal: number;
  discount: number;
  shippingFee: number;
  codFee: number;
  tax: number;
  taxIncluded: boolean;
  total: number;
}

export function computeTotals(input: TotalsInput): Totals {
  const discount = Math.min(Math.max(0, input.discount), input.subtotal);
  const base = input.subtotal - discount + input.shippingFee + input.codFee;

  let tax = 0;
  let total = base;
  if (input.tax.enabled && input.tax.rateBps > 0) {
    if (input.tax.inclusive) {
      tax = base - Math.round((base * 10_000) / (10_000 + input.tax.rateBps));
    } else {
      tax = percentOf(base, input.tax.rateBps);
      total = base + tax;
    }
  }
  return {
    subtotal: input.subtotal,
    discount,
    shippingFee: input.shippingFee,
    codFee: input.codFee,
    tax,
    taxIncluded: input.tax.enabled && input.tax.inclusive,
    total,
  };
}
