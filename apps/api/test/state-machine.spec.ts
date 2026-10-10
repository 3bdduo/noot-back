import { describe, expect, it } from 'vitest';
import { ORDER_STATUSES } from '@nb/shared';
import type { OrderStatus } from '@nb/shared';
import { allowedTargets, buildTimeline, canTransition, isCancellable } from '../src/modules/orders/order.state-machine.js';

const admin = (hasCustomization = false, paymentStatus = 'PAID') => ({ actor: 'admin' as const, hasCustomization, paymentStatus });
const customer = (hasCustomization = false) => ({ actor: 'customer' as const, hasCustomization, paymentStatus: 'PAID' });

describe('order state machine', () => {
  it('online happy path without customization', () => {
    const path: OrderStatus[] = ['PENDING_PAYMENT', 'PAYMENT_CONFIRMED', 'IN_PRODUCTION', 'QUALITY_CHECK', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED'];
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i], path[i + 1], admin())).toBe(true);
  });

  it('personalised orders must pass customization review', () => {
    expect(canTransition('PAYMENT_CONFIRMED', 'IN_PRODUCTION', admin(true))).toBe(false);
    expect(canTransition('PAYMENT_CONFIRMED', 'CUSTOMIZATION_REVIEW', admin(true))).toBe(true);
    expect(canTransition('CUSTOMIZATION_REVIEW', 'CUSTOMIZATION_APPROVED', admin(true))).toBe(true);
    expect(canTransition('CUSTOMIZATION_APPROVED', 'IN_PRODUCTION', admin(true))).toBe(true);
    expect(canTransition('PAYMENT_CONFIRMED', 'CUSTOMIZATION_REVIEW', admin(false))).toBe(false);
  });

  it('COD orders are confirmed by an admin', () => {
    expect(canTransition('COD_PENDING', 'PAYMENT_CONFIRMED', admin())).toBe(true);
    expect(canTransition('COD_PENDING', 'IN_PRODUCTION', admin())).toBe(false);
  });

  it('no skipping or going backwards', () => {
    expect(canTransition('PENDING_PAYMENT', 'SHIPPED', admin())).toBe(false);
    expect(canTransition('DELIVERED', 'PACKED', admin())).toBe(false);
    expect(canTransition('SHIPPED', 'IN_PRODUCTION', admin())).toBe(false);
  });

  it('customer can cancel only before production', () => {
    for (const s of ['PENDING_PAYMENT', 'COD_PENDING', 'PAYMENT_CONFIRMED', 'CUSTOMIZATION_REVIEW', 'CUSTOMIZATION_APPROVED'] as OrderStatus[]) {
      expect(canTransition(s, 'CANCELLED', customer(true))).toBe(true);
    }
    for (const s of ['IN_PRODUCTION', 'QUALITY_CHECK', 'PACKED', 'SHIPPED', 'DELIVERED'] as OrderStatus[]) {
      expect(canTransition(s, 'CANCELLED', customer(true))).toBe(false);
    }
    expect(isCancellable('IN_PRODUCTION', 'customer')).toBe(false);
    expect(isCancellable('IN_PRODUCTION', 'admin')).toBe(true);
  });

  it('customers cannot push orders forward', () => {
    expect(allowedTargets('PAYMENT_CONFIRMED', customer())).toEqual(['CANCELLED']);
    expect(canTransition('PACKED', 'SHIPPED', customer())).toBe(false);
  });

  it('cancelled orders only enter the refund flow when money was paid', () => {
    expect(canTransition('CANCELLED', 'REFUND_REQUESTED', admin(false, 'PAID'))).toBe(true);
    expect(canTransition('CANCELLED', 'REFUND_REQUESTED', admin(false, 'CANCELLED'))).toBe(false);
  });

  it('REFUNDED is terminal and every status has a defined entry', () => {
    expect(allowedTargets('REFUNDED', admin())).toEqual([]);
    for (const s of ORDER_STATUSES) expect(Array.isArray(allowedTargets(s, admin()))).toBe(true);
  });

  it('timeline: personalization stage is skipped when there is none', () => {
    const placedAt = new Date('2026-01-01T10:00:00Z');
    const tl = buildTimeline({ status: 'IN_PRODUCTION', hasCustomization: false, placedAt, history: [{ toStatus: 'PAYMENT_CONFIRMED', createdAt: new Date('2026-01-01T10:05:00Z') }] });
    expect(tl.find((s) => s.stage === 'CUSTOMIZATION_REVIEW')?.state).toBe('skipped');
    expect(tl.find((s) => s.stage === 'IN_PRODUCTION')?.state).toBe('current');
    expect(tl.find((s) => s.stage === 'PAYMENT_CONFIRMED')?.state).toBe('done');
    expect(tl.find((s) => s.stage === 'SHIPPED')?.state).toBe('upcoming');
  });

  it('timeline: delivered is fully done; cancelled freezes at the last reached stage', () => {
    const t0 = new Date('2026-01-01T10:00:00Z');
    const delivered = buildTimeline({ status: 'DELIVERED', hasCustomization: false, placedAt: t0, history: [{ toStatus: 'DELIVERED', createdAt: t0 }] });
    expect(delivered.at(-1)?.state).toBe('done');
    const cancelled = buildTimeline({ status: 'CANCELLED', hasCustomization: false, placedAt: t0, history: [{ toStatus: 'PAYMENT_CONFIRMED', createdAt: t0 }, { toStatus: 'CANCELLED', createdAt: t0 }] });
    expect(cancelled.filter((s) => s.state === 'current')).toHaveLength(0);
    expect(cancelled.find((s) => s.stage === 'IN_PRODUCTION')?.state).toBe('upcoming');
  });
});
