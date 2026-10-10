import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CheckoutAddress, CustomizationInput, Locale } from '@nb/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Tx } from '../../prisma/prisma.service.js';
import { AppError } from '../../common/errors/app-error.js';
import { logEvent } from '../../common/logger.js';
import type { Actor } from '../../common/types.js';
import { skipTake, toPage } from '../../common/utils/pagination.js';
import type { Pagination } from '../../common/utils/pagination.js';
import { CustomizationService } from '../customization/customization.service.js';
import { applyPersonalizationEdit, buildSnapshot, snapshotToInput } from '../customization/customization.engine.js';
import type { CustomizationSnapshot } from '../customization/customization.engine.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { ShippingService } from '../shipping/shipping.service.js';
import { computeTotals } from '../pricing/pricing.js';
import {
  CUSTOMER_CANCELLABLE,
  CUSTOMER_EDITABLE,
  InvalidTransitionError,
  assertTransition,
  buildTimeline,
  nextAdminActions,
} from './order.state-machine.js';
import type { OrderStatus } from '@nb/shared';
import type { TransitionActor } from './order.state-machine.js';

export type ActorKind = 'CUSTOMER' | 'ADMIN' | 'SYSTEM' | 'PROVIDER';
export interface Who {
  type: ActorKind;
  id?: string | null;
}
export type AfterCommit = Array<() => Promise<void>>;

/** How a caller proves it may see/act on an order. */
export type OrderAccess = { userId: string } | { email: string };

export const ORDER_VIEW_INCLUDE = {
  items: { orderBy: { createdAt: 'asc' } },
  history: { orderBy: { createdAt: 'asc' } },
  shipments: { orderBy: { createdAt: 'asc' }, include: { events: { orderBy: { occurredAt: 'desc' } } } },
  payments: { orderBy: { createdAt: 'desc' }, take: 1 },
  gift: true,
} satisfies Prisma.OrderInclude;
export type OrderViewRow = Prisma.OrderGetPayload<{ include: typeof ORDER_VIEW_INCLUDE }>;

type Bilingual = { ar?: string; en?: string } | null | undefined;
export const pickBilingual = (v: Bilingual, locale: Locale): string => (v ? (v[locale] ?? v.ar ?? v.en ?? '') : '');

const toTransitionActor = (t: ActorKind): TransitionActor => (t === 'CUSTOMER' ? 'customer' : t === 'ADMIN' ? 'admin' : 'system');

@Injectable()
export class OrdersService {
  constructor(
    readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly shipping: ShippingService,
    private readonly customization: CustomizationService,
  ) {}

  // ================================================================ views

  view(order: OrderViewRow, locale: Locale) {
    const status = order.status as OrderStatus;
    const addr = order.shippingAddress as unknown as CheckoutAddress;
    const payment = order.payments[0] ?? null;
    const reservationOpen = !order.reservationExpiresAt || order.reservationExpiresAt > new Date();
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status,
      paymentStatus: order.paymentStatus,
      paymentMethod: order.paymentMethod,
      currency: order.currency,
      placedAt: order.placedAt,
      estimatedDeliveryAt: order.estimatedDeliveryAt,
      cancelledAt: order.cancelledAt,
      cancelReason: order.cancelReason,
      totals: {
        subtotal: order.subtotal,
        discount: order.discount,
        shippingFee: order.shippingFee,
        codFee: order.codFee,
        tax: order.tax,
        total: order.total,
        couponCode: order.couponCode,
      },
      contact: { email: order.contactEmail, phone: order.contactPhone },
      shippingAddress: addr,
      customerNote: order.customerNote,
      hasCustomization: order.hasCustomization,
      items: order.items.map((it) => {
        const p = it.productSnapshot as any;
        const v = it.variantSnapshot as any;
        const snap = it.customizationSnapshot as unknown as CustomizationSnapshot | null;
        return {
          id: it.id,
          productId: it.productId,
          slug: p?.slug ?? null,
          name: pickBilingual(p?.name, locale),
          variantName: pickBilingual(v?.name, locale) || null,
          variant: { color: v?.color ?? null, size: v?.size ?? null, paper: v?.paper ?? null, material: v?.material ?? null },
          image: p?.image ?? null,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          totalPrice: it.totalPrice,
          customization: snap?.summary ?? null,
          reviewStatus: it.customizationReviewStatus,
          reviewNote: it.customizationReviewStatus === 'NEEDS_CHANGES' ? it.customizationReviewNote : null,
        };
      }),
      gift: order.gift
        ? { recipientName: order.gift.recipientName, senderName: order.gift.senderName, message: order.gift.message, hidePrices: order.gift.hidePrices }
        : null,
      timeline: buildTimeline({ status, hasCustomization: order.hasCustomization, placedAt: order.placedAt, history: order.history }),
      shipments: order.shipments.map((s) => ({
        id: s.id,
        carrier: s.carrier,
        trackingNumber: s.trackingNumber,
        trackingUrl: s.trackingUrl,
        status: s.status,
        shippedAt: s.shippedAt,
        deliveredAt: s.deliveredAt,
        events: s.events.map((e) => ({ status: e.status, description: e.description, location: e.location, at: e.occurredAt })),
      })),
      payment: payment
        ? {
            status: payment.status,
            method: payment.method,
            canPayNow: status === 'PENDING_PAYMENT' && payment.method !== 'COD' && reservationOpen,
            payBefore: status === 'PENDING_PAYMENT' ? order.reservationExpiresAt : null,
          }
        : null,
      canCancel: CUSTOMER_CANCELLABLE.includes(status),
      canEdit: CUSTOMER_EDITABLE.includes(status),
      canEditPersonalization: order.hasCustomization && CUSTOMER_EDITABLE.includes(status),
    };
  }

  // ================================================================ lookups

  async findForAccess(ref: string, access: OrderAccess): Promise<OrderViewRow> {
    const order = await this.prisma.order.findFirst({
      where: { OR: [{ id: ref }, { orderNumber: ref.toUpperCase() }] },
      include: ORDER_VIEW_INCLUDE,
    });
    const ok =
      order &&
      ('userId' in access ? order.userId === access.userId : order.contactEmail.toLowerCase() === access.email.toLowerCase());
    if (!order || !ok) throw AppError.notFound('ORDER_NOT_FOUND');
    return order;
  }

  async get(ref: string, access: OrderAccess, locale: Locale) {
    return this.view(await this.findForAccess(ref, access), locale);
  }

  async listMine(userId: string, pagination: Pagination, locale: Locale, status?: OrderStatus) {
    const where: Prisma.OrderWhereInput = { userId, ...(status ? { status } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.order.findMany({ where, orderBy: { placedAt: 'desc' }, ...skipTake(pagination), include: ORDER_VIEW_INCLUDE }),
      this.prisma.order.count({ where }),
    ]);
    return toPage(rows.map((r) => this.view(r, locale)), total, pagination);
  }

  /** Guest tracking: order number + the email used at checkout (or the phone). */
  async track(orderNumber: string, proof: { email?: string; phone?: string }, locale: Locale) {
    const order = await this.prisma.order.findUnique({ where: { orderNumber: orderNumber.trim().toUpperCase() }, include: ORDER_VIEW_INCLUDE });
    const ok =
      order &&
      ((proof.email && order.contactEmail.toLowerCase() === proof.email.toLowerCase()) || (proof.phone && order.contactPhone === proof.phone));
    if (!order || !ok) throw AppError.notFound('ORDER_NOT_FOUND');
    return this.view(order, locale);
  }

  // ================================================================ transitions (the ONLY way status changes)

  /** Public entry point: runs in its own transaction and fires notifications after commit. */
  async transition(orderId: string, to: OrderStatus, who: Who, opts: { note?: string; reason?: string } = {}) {
    let after: AfterCommit = [];
    const updated = await this.prisma.tx((tx) => {
      after = []; // the transaction may be retried after a write conflict: never keep side effects of a failed attempt
      return this.transitionInTx(tx, orderId, to, who, opts, after);
    });
    await this.runAfter(after);
    return updated;
  }

  async runAfter(after: AfterCommit) {
    for (const fn of after) {
      try {
        await fn();
      } catch (e) {
        logEvent('error', 'order.after_commit_failed', { message: (e as Error).message });
      }
    }
  }

  async transitionInTx(tx: Tx, orderId: string, to: OrderStatus, who: Who, opts: { note?: string; reason?: string }, after: AfterCommit) {
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!order) throw AppError.notFound('ORDER_NOT_FOUND');
    const from = order.status as OrderStatus;

    try {
      assertTransition(from, to, { hasCustomization: order.hasCustomization, actor: toTransitionActor(who.type), paymentStatus: order.paymentStatus });
    } catch (e) {
      if (e instanceof InvalidTransitionError) throw AppError.conflict('INVALID_TRANSITION', { from, to });
      throw e;
    }

    const now = new Date();
    const data: Prisma.OrderUpdateManyMutationInput = { status: to };
    const customerData = this.notificationData(order);
    const notifyCustomer = (event: Parameters<NotificationsService['notify']>[0]['event'], extra: Record<string, unknown> = {}) =>
      after.push(() =>
        this.notifications.notify({ event, locale: order.locale as Locale, userId: order.userId, email: order.contactEmail, data: { ...customerData, ...extra } }),
      );

    let followUp: OrderStatus | null = null;

    switch (to) {
      case 'PAYMENT_CONFIRMED': {
        data.confirmedAt = now;
        data.reservationExpiresAt = null;
        const low = await this.inventory.finalizeForOrder(tx, orderId, who.id);
        for (const hit of low) after.push(() => this.notifications.notifyAdmins('inventory.read', 'admin_low_stock', { sku: hit.sku, available: hit.available }));
        notifyCustomer('payment_confirmed');
        if (order.hasCustomization) followUp = 'CUSTOMIZATION_REVIEW';
        break;
      }
      case 'CUSTOMIZATION_REVIEW':
        after.push(() => this.notifications.notifyAdmins('customizations.review', 'admin_customization_pending', { orderNumber: order.orderNumber }));
        break;
      case 'CUSTOMIZATION_APPROVED': {
        const bad = order.items.some((i) => i.customizationReviewStatus && i.customizationReviewStatus !== 'APPROVED');
        if (bad) throw AppError.conflict('CUSTOMIZATION_NOT_APPROVED');
        notifyCustomer('customization_approved');
        break;
      }
      case 'IN_PRODUCTION': {
        const bad = order.items.some((i) => i.customizationReviewStatus && !['APPROVED', 'SENT_TO_PRODUCTION'].includes(i.customizationReviewStatus));
        if (bad) throw AppError.conflict('CUSTOMIZATION_NOT_APPROVED');
        await tx.orderItem.updateMany({ where: { orderId, customizationReviewStatus: 'APPROVED' }, data: { customizationReviewStatus: 'SENT_TO_PRODUCTION' } });
        notifyCustomer('production_started');
        break;
      }
      case 'OUT_FOR_DELIVERY':
        await tx.shipment.updateMany({ where: { orderId, status: { in: ['PENDING', 'PICKED_UP', 'IN_TRANSIT'] } }, data: { status: 'OUT_FOR_DELIVERY' } });
        break;
      case 'DELIVERED': {
        data.deliveredAt = now;
        await tx.shipment.updateMany({ where: { orderId, status: { not: 'DELIVERED' } }, data: { status: 'DELIVERED', deliveredAt: now } });
        if (order.paymentMethod === 'COD') {
          data.paymentStatus = 'PAID';
          data.paidAt = now;
          await tx.payment.updateMany({ where: { orderId, method: 'COD', status: { not: 'PAID' } }, data: { status: 'PAID', paidAt: now } });
        }
        for (const it of order.items) {
          await tx.product.update({ where: { id: it.productId }, data: { salesCount: { increment: it.quantity } } });
        }
        notifyCustomer('order_delivered');
        break;
      }
      case 'CANCELLED': {
        data.cancelledAt = now;
        data.cancelReason = opts.reason ?? opts.note ?? null;
        data.reservationExpiresAt = null;
        await this.inventory.releaseForOrder(tx, orderId, 'order_cancelled', who.id);
        await this.rollbackCoupon(tx, orderId);

        const paid = order.paymentStatus === 'PAID';
        if (paid) {
          const payment = await tx.payment.findFirst({ where: { orderId, status: 'PAID' }, orderBy: { createdAt: 'desc' } });
          if (payment) {
            await tx.refund.create({
              data: { paymentId: payment.id, orderId, amount: order.total, reason: data.cancelReason as string | null, status: 'PENDING', requestedById: who.type === 'ADMIN' ? who.id : null },
            });
          }
          data.paymentStatus = 'REFUND_PENDING';
        } else {
          data.paymentStatus = 'CANCELLED';
          await tx.payment.updateMany({ where: { orderId, status: { in: ['PENDING', 'COD_PENDING', 'AUTHORIZED'] } }, data: { status: 'CANCELLED' } });
        }
        notifyCustomer('order_cancelled', { refundPending: paid });
        break;
      }
      case 'REFUNDED':
        data.paymentStatus = 'REFUNDED';
        break;
      default:
        break;
    }

    const res = await tx.order.updateMany({ where: { id: orderId, status: from }, data });
    if (res.count === 0) throw AppError.conflict('ORDER_CHANGED');

    await tx.orderStatusHistory.create({
      data: { orderId, fromStatus: from, toStatus: to, actorId: who.id ?? null, actorType: who.type, note: opts.note ?? opts.reason ?? null },
    });

    if (followUp) {
      await this.transitionInTx(tx, orderId, followUp, { type: 'SYSTEM' }, { note: 'auto' }, after);
    }
    return tx.order.findUniqueOrThrow({ where: { id: orderId }, include: ORDER_VIEW_INCLUDE });
  }

  private notificationData(order: { orderNumber: string; total: number; paymentMethod: string; hasCustomization: boolean; shippingAddress: unknown }) {
    const addr = order.shippingAddress as { firstName?: string } | null;
    return {
      name: addr?.firstName,
      orderNumber: order.orderNumber,
      total: order.total,
      paymentMethod: order.paymentMethod,
      hasCustomization: order.hasCustomization,
    };
  }

  private async rollbackCoupon(tx: Tx, orderId: string) {
    const usage = await tx.couponUsage.findUnique({ where: { orderId } });
    if (!usage) return;
    await tx.couponUsage.delete({ where: { orderId } });
    await tx.coupon.updateMany({ where: { id: usage.couponId, usedCount: { gt: 0 } }, data: { usedCount: { decrement: 1 } } });
  }

  // ================================================================ payment hooks (used by the payments module)

  /**
   * Online payment succeeded (webhook / verified return). Idempotent.
   * Stock is committed; if the reservation had already expired the order is cancelled and the payment queued for refund.
   */
  async confirmOnlinePayment(orderId: string, info: { paymentId: string; providerRef?: string | null; amount: number }) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw AppError.notFound('ORDER_NOT_FOUND');
    if (info.amount !== order.total) throw AppError.conflict('PAYMENT_AMOUNT_MISMATCH', { expected: order.total, got: info.amount });
    if (order.paymentStatus === 'PAID' && order.status !== 'PENDING_PAYMENT') return { status: 'already_confirmed' as const };

    const now = new Date();
    await this.prisma.tx(async (tx) => {
      await tx.payment.update({ where: { id: info.paymentId }, data: { status: 'PAID', paidAt: now, providerRef: info.providerRef ?? undefined } });
      await tx.order.update({ where: { id: orderId }, data: { paymentStatus: 'PAID', paidAt: now } });
    });

    const refreshed = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    if (refreshed.status !== 'PENDING_PAYMENT') {
      // Paid after the order was cancelled/expired: money must go back.
      if (refreshed.status === 'CANCELLED') await this.queueRefundForLatePayment(orderId, info.paymentId, refreshed.total);
      return { status: 'late' as const };
    }

    try {
      await this.transition(orderId, 'PAYMENT_CONFIRMED', { type: 'PROVIDER' }, { note: 'payment confirmed' });
      return { status: 'confirmed' as const };
    } catch (e) {
      if (e instanceof AppError && e.code === 'RESERVATION_LOST') {
        await this.transition(orderId, 'CANCELLED', { type: 'SYSTEM' }, { reason: 'stock_reservation_expired' });
        return { status: 'late' as const };
      }
      throw e;
    }
  }

  private async queueRefundForLatePayment(orderId: string, paymentId: string, amount: number) {
    const exists = await this.prisma.refund.findFirst({ where: { orderId, paymentId } });
    if (exists) return;
    await this.prisma.$transaction([
      this.prisma.refund.create({ data: { orderId, paymentId, amount, reason: 'late_payment', status: 'PENDING' } }),
      this.prisma.order.update({ where: { id: orderId }, data: { paymentStatus: 'REFUND_PENDING' } }),
    ]);
  }

  async failOnlinePayment(orderId: string, paymentId: string, reason: string) {
    await this.prisma.$transaction([
      this.prisma.payment.updateMany({ where: { id: paymentId, status: { not: 'PAID' } }, data: { status: 'FAILED', failureReason: reason.slice(0, 300) } }),
      this.prisma.order.updateMany({ where: { id: orderId, status: 'PENDING_PAYMENT', paymentStatus: { not: 'PAID' } }, data: { paymentStatus: 'FAILED' } }),
    ]);
  }

  // ================================================================ customer actions

  async cancelByCustomer(ref: string, access: OrderAccess, reason: string | undefined, locale: Locale) {
    const order = await this.findForAccess(ref, access);
    if (!CUSTOMER_CANCELLABLE.includes(order.status as OrderStatus)) throw AppError.unprocessable('ORDER_CANNOT_CANCEL');
    await this.transition(order.id, 'CANCELLED', { type: 'CUSTOMER', id: order.userId }, { reason: reason ?? 'customer_request' });
    return this.get(order.id, access, locale);
  }

  async updateAddress(ref: string, access: OrderAccess, address: CheckoutAddress, locale: Locale) {
    const order = await this.findForAccess(ref, access);
    if (!CUSTOMER_EDITABLE.includes(order.status as OrderStatus)) throw AppError.unprocessable('ORDER_CANNOT_EDIT');

    let patch: Prisma.OrderUpdateInput = { shippingAddress: address as unknown as Prisma.InputJsonValue, contactPhone: address.phone };
    if (address.governorate !== order.governorate) {
      const ship = await this.shipping.resolve(address.governorate, Math.max(0, order.subtotal - order.discount));
      if (order.paymentMethod === 'COD' && !ship.codAvailable) throw AppError.unprocessable('COD_NOT_AVAILABLE');
      const tax = await this.settings.get('tax');
      const totals = computeTotals({
        subtotal: order.subtotal,
        discount: order.discount,
        shippingFee: ship.fee,
        codFee: order.codFee,
        tax: { enabled: tax.enabled, rateBps: tax.rateBps, inclusive: tax.inclusive },
      });
      const priceChanged = totals.total !== order.total;
      // Online-paid orders cannot change price by themselves; COD orders can (nothing collected yet).
      if (priceChanged && order.paymentMethod !== 'COD') throw AppError.unprocessable('ORDER_EDIT_PRICE_CHANGE', { newTotal: totals.total });
      patch = { ...patch, governorate: address.governorate, shippingFee: totals.shippingFee, tax: totals.tax, total: totals.total };
      await this.prisma.payment.updateMany({ where: { orderId: order.id, status: { in: ['COD_PENDING', 'PENDING'] } }, data: { amount: totals.total } });
    }
    await this.prisma.$transaction([
      this.prisma.order.update({ where: { id: order.id }, data: patch }),
      this.prisma.orderNote.create({ data: { orderId: order.id, body: 'Shipping address changed by customer' } }),
    ]);
    return this.get(order.id, access, locale);
  }

  /**
   * Customer edits TEXT / DATE / FILE selections of one item. Allowed directly until production starts.
   * Price must not change (no new options); previous snapshot is kept as a revision; item returns to review.
   */
  async editPersonalization(ref: string, access: OrderAccess, itemId: string, edits: CustomizationInput, actor: Actor, locale: Locale) {
    const order = await this.findForAccess(ref, access);
    if (!CUSTOMER_EDITABLE.includes(order.status as OrderStatus)) throw AppError.unprocessable('ORDER_CANNOT_EDIT');
    const item = order.items.find((i) => i.id === itemId);
    if (!item || !item.customizationSnapshot) throw AppError.notFound('ORDER_ITEM_NOT_FOUND');

    const oldSnap = item.customizationSnapshot as unknown as CustomizationSnapshot;
    const groups = await this.customization.loadGroups(item.productId);
    const { input, illegalGroupCodes } = applyPersonalizationEdit(groups, snapshotToInput(oldSnap), edits);
    if (illegalGroupCodes.length) throw AppError.unprocessable('CUSTOMIZATION_INVALID', {}, illegalGroupCodes.map((g) => ({ field: g, code: 'CUSTOM_VALUE_NOT_ALLOWED' })));

    const { result } = await this.customization.evaluate(item.productId, input, actor);
    this.customization.assertValid(result);
    if (result.priceDelta !== oldSnap.priceDelta) throw AppError.unprocessable('ORDER_EDIT_PRICE_CHANGE');

    const snapshot = buildSnapshot(result);
    await this.prisma.$transaction(async (tx) => {
      await tx.orderItemRevision.create({ data: { orderItemId: item.id, snapshot: oldSnap as unknown as Prisma.InputJsonValue, changedById: access && 'userId' in access ? access.userId : null } });
      await tx.customizationSelection.deleteMany({ where: { orderItemId: item.id } });
      await tx.customizationSelection.createMany({ data: selectionRows(item.id, result.selections, locale) });
      await tx.orderItem.update({
        where: { id: item.id },
        data: { customizationSnapshot: snapshot as unknown as Prisma.InputJsonValue, customizationReviewStatus: 'PENDING_REVIEW', customizationReviewNote: null, reviewedAt: null, reviewedById: null },
      });
      if (order.status === 'CUSTOMIZATION_APPROVED') {
        await tx.order.update({ where: { id: order.id }, data: { status: 'CUSTOMIZATION_REVIEW' } });
        await tx.orderStatusHistory.create({
          data: { orderId: order.id, fromStatus: 'CUSTOMIZATION_APPROVED', toStatus: 'CUSTOMIZATION_REVIEW', actorType: 'CUSTOMER', actorId: order.userId, note: 'personalization edited' },
        });
      }
    });
    await this.notifications.notifyAdmins('customizations.review', 'admin_customization_pending', { orderNumber: order.orderNumber });
    return this.get(order.id, access, locale);
  }

  nextActions(order: { status: string; hasCustomization: boolean; paymentStatus: string }) {
    return nextAdminActions(order.status as OrderStatus, { hasCustomization: order.hasCustomization, paymentStatus: order.paymentStatus });
  }
}

/** Rows of `CustomizationSelection` for one order item (also used at checkout). */
export function selectionRows(
  orderItemId: string,
  selections: Array<{ stepKey: string; groupCode: string; groupType: any; optionCode: string | null; optionName: any; groupName: any; textValue: string | null; dateValue: string | null; artworkFileId: string | null; priceDelta: number }>,
  locale: Locale,
): Prisma.CustomizationSelectionCreateManyInput[] {
  return selections.map((s) => ({
    orderItemId,
    stepKey: s.stepKey,
    groupCode: s.groupCode,
    groupType: s.groupType,
    optionCode: s.optionCode,
    textValue: s.textValue,
    dateValue: s.dateValue ? new Date(s.dateValue) : null,
    artworkFileId: s.artworkFileId,
    priceDelta: s.priceDelta,
    nameSnapshot: pickBilingual(s.optionName ?? s.groupName, locale) || null,
  }));
}
