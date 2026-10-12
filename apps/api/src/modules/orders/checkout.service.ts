import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CheckoutRequest, Locale } from '@nb/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AppError } from '../../common/errors/app-error.js';
import { logEvent } from '../../common/logger.js';
import { randomReadable, sha256Hex } from '../../common/crypto/tokens.js';
import type { Actor } from '../../common/types.js';
import { env } from '../../config/env.js';
import { CartService } from '../cart/cart.service.js';
import { CouponsService } from '../coupons/coupons.service.js';
import { CustomizationService } from '../customization/customization.service.js';
import { buildSnapshot } from '../customization/customization.engine.js';
import { InventoryService } from '../inventory/inventory.service.js';
import type { StockNeedInput } from '../inventory/inventory.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { ShippingService } from '../shipping/shipping.service.js';
import { computeTotals, estimateDelivery, subtotalOf } from '../pricing/pricing.js';
import { ORDER_VIEW_INCLUDE, OrdersService, pickBilingual, selectionRows } from './orders.service.js';
import type { OrderViewRow } from './orders.service.js';
import type { SettingValue } from '../settings/settings.registry.js';

function orderNumber(): string {
  const d = new Date();
  const yy = String(d.getUTCFullYear()).slice(2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${env.ORDER_NUMBER_PREFIX}-${yy}${mm}${dd}-${randomReadable(6)}`;
}

@Injectable()
export class CheckoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cart: CartService,
    private readonly coupons: CouponsService,
    private readonly customization: CustomizationService,
    private readonly inventory: InventoryService,
    private readonly shipping: ShippingService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly orders: OrdersService,
  ) {}

  /** Read-only preview of what `placeOrder` would charge, for the checkout summary. */
  async preview(actor: Actor, governorate: string, paymentMethod: 'CARD' | 'WALLET' | 'COD', locale: Locale) {
    const view = await this.cart.view(actor, locale, { governorate });
    const cod = await this.settings.get('cod');
    const codFee = paymentMethod === 'COD' ? cod.fee : 0;
    const tax = await this.settings.get('tax');
    const totals = computeTotals({
      subtotal: view.totals.subtotal,
      discount: view.totals.discount,
      shippingFee: view.totals.shippingFee,
      codFee,
      tax: { enabled: tax.enabled, rateBps: tax.rateBps, inclusive: tax.inclusive },
    });
    return { ...view, totals, codFee, paymentMethod };
  }

  async placeOrder(actor: Actor, body: CheckoutRequest, locale: Locale, idempotencyHeader?: string) {
    const checkoutSettings = await this.settings.get('checkout');
    if (!actor.userId && !checkoutSettings.guestCheckout) throw AppError.unauthorized('LOGIN_REQUIRED');
    if (!actor.userId && !body.email) throw AppError.badRequest('VALIDATION_ERROR', {}, [{ field: 'email', code: 'REQUIRED' }]);

    // ---- idempotency: the same key from the same shopper returns the same order
    const idempotencyKey = idempotencyHeader
      ? sha256Hex(`${actor.userId ?? actor.guestHash ?? 'anon'}:${idempotencyHeader}`)
      : null;
    if (idempotencyKey) {
      const existing = await this.prisma.order.findUnique({ where: { idempotencyKey }, include: ORDER_VIEW_INCLUDE });
      if (existing) return this.result(existing, locale, true);
    }

    // ---- cart
    const cartRow = await this.cart.getCartForCheckout(actor);
    if (!cartRow) throw AppError.unprocessable('CART_EMPTY');
    const items = (await this.cart.loadItems(cartRow.id)).filter((i) => !i.savedForLater);
    if (items.length === 0) throw AppError.unprocessable('CART_EMPTY');

    const lines = await this.cart.evaluateItems(items, actor);
    const blocking = lines.filter((l) => l.status !== 'OK');
    if (blocking.length) {
      throw AppError.unprocessable(
        'CART_HAS_ISSUES',
        {},
        blocking.map((l) => ({ itemId: l.item.id, status: l.status, issues: l.issues })),
      );
    }
    const priced = CartService.toPricedLines(lines);
    const subtotal = subtotalOf(priced);

    // ---- address
    const address = await this.resolveAddress(actor, body);
    const contactEmail = (actor.userId ? await this.userEmail(actor.userId) : body.email!).toLowerCase();

    // ---- coupon
    let discount = 0;
    let couponId: string | null = null;
    let couponCode: string | null = null;
    let couponUsageLimit: number | null = null;
    const wantedCode = body.couponCode ?? cartRow.couponCode;
    if (wantedCode) {
      const { coupon, result } = await this.coupons.evaluate(wantedCode, priced, { userId: actor.userId, email: contactEmail });
      if (result.ok === false) throw AppError.unprocessable(result.code, result.params);
      discount = result.discount;
      couponId = coupon.id;
      couponCode = coupon.code;
      couponUsageLimit = coupon.usageLimit;
    }

    // ---- shipping + payment method rules
    const ship = await this.shipping.resolve(address.governorate, Math.max(0, subtotal - discount));
    const cod = await this.settings.get('cod');
    const isCod = body.paymentMethod === 'COD';
    if (isCod) await this.assertCodAllowed(cod, ship.codAvailable, address.phone, subtotal - discount + ship.fee + cod.fee);
    else if (env.PAYMENT_PROVIDER === 'none') throw AppError.unprocessable('PAYMENT_NOT_AVAILABLE');

    const tax = await this.settings.get('tax');
    const totals = computeTotals({
      subtotal,
      discount,
      shippingFee: ship.fee,
      codFee: isCod ? cod.fee : 0,
      tax: { enabled: tax.enabled, rateBps: tax.rateBps, inclusive: tax.inclusive },
    });
    if (isCod && cod.maxOrderTotal !== null && totals.total > cod.maxOrderTotal) throw AppError.unprocessable('COD_LIMIT_EXCEEDED', { max: (cod.maxOrderTotal / 100).toFixed(2) });

    const now = new Date();
    const reservationExpiresAt = isCod
      ? cod.autoCancelHours > 0
        ? new Date(now.getTime() + cod.autoCancelHours * 3_600_000)
        : null
      : new Date(now.getTime() + checkoutSettings.reservationMinutes * 60_000);
    const leadTime = lines.reduce((max, l) => Math.max(max, l.item.product.leadTimeDays), 0);
    const hasCustomization = lines.some((l) => (l.evaluation?.selections.length ?? 0) > 0);

    // option ids that consume stock
    const needs: StockNeedInput[] = [];
    for (const l of lines) {
      const groups = await this.customization.loadGroups(l.item.productId);
      const optionIds: string[] = [];
      for (const s of l.evaluation!.selections) {
        const opt = groups.find((g) => g.code === s.groupCode)?.options.find((o) => o.code === s.optionCode);
        if (opt) optionIds.push(opt.id);
      }
      needs.push({
        variantId: l.item.variantId,
        optionIds,
        quantity: l.item.quantity,
        label: pickBilingual(
          { ar: l.item.product.translations.find((t) => t.locale === 'ar')?.name, en: l.item.product.translations.find((t) => t.locale === 'en')?.name },
          locale,
        ) || l.item.product.slug,
      });
    }

    const gift = body.giftMessage ?? (await this.prisma.giftMessage.findUnique({ where: { cartId: cartRow.id } })) ?? null;
    const status = isCod ? 'COD_PENDING' : 'PENDING_PAYMENT';
    const paymentStatus = isCod ? 'COD_PENDING' : 'PENDING';

    let created!: { id: string };
    for (let attempt = 0; ; attempt++) {
      try {
        created = await this.prisma.tx(async (tx) => {
          const order = await tx.order.create({
            data: {
              orderNumber: orderNumber(),
              userId: actor.userId,
              guestEmail: actor.userId ? null : contactEmail,
              guestPhone: actor.userId ? null : address.phone,
              contactEmail,
              contactPhone: address.phone,
              status,
              paymentStatus,
              paymentMethod: body.paymentMethod,
              subtotal: totals.subtotal,
              discount: totals.discount,
              shippingFee: totals.shippingFee,
              codFee: totals.codFee,
              tax: totals.tax,
              total: totals.total,
              couponId,
              couponCode,
              governorate: address.governorate,
              shippingAddress: address as unknown as Prisma.InputJsonValue,
              customerNote: body.customerNote ?? null,
              locale,
              idempotencyKey,
              hasCustomization,
              estimatedDeliveryAt: estimateDelivery(now, leadTime, ship.estimatedDaysMax),
              reservationExpiresAt,
            },
          });

          for (const l of lines) {
            const { item, evaluation } = l;
            const p = item.product;
            const v = item.variant;
            const hasSelections = (evaluation?.selections.length ?? 0) > 0;
            const orderItem = await tx.orderItem.create({
              data: {
                orderId: order.id,
                productId: item.productId,
                variantId: item.variantId,
                quantity: item.quantity,
                unitPrice: l.unitPrice,
                totalPrice: l.unitPrice * item.quantity,
                productSnapshot: {
                  slug: p.slug,
                  sku: p.sku,
                  name: { ar: p.translations.find((t) => t.locale === 'ar')?.name ?? p.slug, en: p.translations.find((t) => t.locale === 'en')?.name ?? p.slug },
                  image: p.media[0]?.url ?? null,
                },
                variantSnapshot: {
                  sku: v.sku,
                  color: v.color,
                  size: v.size,
                  paper: v.paper,
                  material: v.material,
                  name: { ar: v.translations.find((t) => t.locale === 'ar')?.name ?? null, en: v.translations.find((t) => t.locale === 'en')?.name ?? null },
                },
                customizationSnapshot: hasSelections ? (buildSnapshot(evaluation!) as unknown as Prisma.InputJsonValue) : null,
                leadTimeDays: p.leadTimeDays,
                customizationReviewStatus: hasSelections ? 'PENDING_REVIEW' : null,
              },
            });
            if (hasSelections) await tx.customizationSelection.createMany({ data: selectionRows(orderItem.id, evaluation!.selections, locale) });
          }

          await tx.payment.create({
            data: {
              orderId: order.id,
              method: body.paymentMethod,
              provider: isCod ? null : env.PAYMENT_PROVIDER,
              status: paymentStatus,
              amount: totals.total,
            },
          });
          await tx.orderStatusHistory.create({ data: { orderId: order.id, fromStatus: null, toStatus: status, actorType: actor.userId ? 'CUSTOMER' : 'SYSTEM', actorId: actor.userId, note: 'order placed' } });

          if (gift) {
            await tx.giftMessage.create({
              data: { orderId: order.id, recipientName: gift.recipientName ?? null, senderName: gift.senderName ?? null, message: gift.message, hidePrices: gift.hidePrices ?? false },
            });
          }

          if (couponId) {
            // Atomic against the usage limit: two shoppers cannot both take the last use.
            const bump = await tx.coupon.updateMany({
              where: { id: couponId, ...(couponUsageLimit !== null ? { usedCount: { lt: couponUsageLimit } } : {}) },
              data: { usedCount: { increment: 1 } },
            });
            if (bump.count === 0) throw AppError.unprocessable('COUPON_LIMIT_REACHED');
            await tx.couponUsage.create({ data: { couponId, userId: actor.userId, guestEmail: actor.userId ? null : contactEmail, orderId: order.id, discount: totals.discount } });
          }

          await this.inventory.reserveForOrder(tx, order.id, needs, reservationExpiresAt);
          await this.cart.clearPurchased(cartRow.id, tx);
          return order;
        });
        break;
      } catch (e) {
        // order-number collision (practically impossible) or concurrent identical idempotency key
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && attempt < 3) {
          const target = String((e.meta as any)?.target ?? '');
          if (target.includes('idempotencyKey') && idempotencyKey) {
            const existing = await this.prisma.order.findUnique({ where: { idempotencyKey }, include: ORDER_VIEW_INCLUDE });
            if (existing) return this.result(existing, locale, true);
          }
          continue;
        }
        throw e;
      }
    }

    const full = await this.prisma.order.findUniqueOrThrow({ where: { id: created.id }, include: ORDER_VIEW_INCLUDE });
    logEvent('info', 'order.placed', { orderId: full.id, orderNumber: full.orderNumber, total: full.total, method: full.paymentMethod });

    await this.notifications.notify({
      event: 'order_confirmation',
      locale,
      userId: actor.userId,
      email: contactEmail,
      data: { name: address.firstName, orderNumber: full.orderNumber, total: full.total, paymentMethod: full.paymentMethod },
    });
    await this.notifications.notifyAdmins('orders.read', 'admin_new_order', { orderNumber: full.orderNumber, total: full.total });
    return this.result(full, locale, false);
  }

  private result(order: OrderViewRow, locale: Locale, replayed: boolean) {
    return {
      replayed,
      order: this.orders.view(order, locale),
      nextAction: order.paymentMethod === 'COD' ? 'AWAIT_CONFIRMATION' : 'PAY_ONLINE',
    };
  }

  // ---------------------------------------------------------------- helpers

  private async userEmail(userId: string): Promise<string> {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
    return u.email;
  }

  private async resolveAddress(actor: Actor, body: CheckoutRequest) {
    if (body.address) return body.address;
    if (body.addressId && actor.userId) {
      const a = await this.prisma.address.findFirst({ where: { id: body.addressId, userId: actor.userId, deletedAt: null } });
      if (!a) throw AppError.notFound('ADDRESS_NOT_FOUND');
      return {
        firstName: a.firstName,
        lastName: a.lastName,
        phone: a.phone,
        governorate: a.governorate,
        city: a.city,
        street: a.street,
        building: a.building ?? undefined,
        apartment: a.apartment ?? undefined,
        postalCode: a.postalCode ?? undefined,
      };
    }
    throw AppError.badRequest('VALIDATION_ERROR', {}, [{ field: 'address', code: 'REQUIRED' }]);
  }

  /** Fake-order protection for cash on delivery. */
  private async assertCodAllowed(cod: SettingValue<'cod'>, zoneAllows: boolean, phone: string, total: number) {
    if (!cod.enabled || !zoneAllows) throw AppError.unprocessable('COD_NOT_AVAILABLE');
    if (cod.maxOrderTotal !== null && total > cod.maxOrderTotal) throw AppError.unprocessable('COD_LIMIT_EXCEEDED', { max: (cod.maxOrderTotal / 100).toFixed(2) });
    const blocked = await this.prisma.blockedPhone.findUnique({ where: { phone } });
    if (blocked) throw AppError.forbidden('PHONE_BLOCKED');
    const pending = await this.prisma.order.count({ where: { contactPhone: phone, status: 'COD_PENDING' } });
    if (pending >= cod.maxPendingPerPhone) throw AppError.unprocessable('COD_TOO_MANY_PENDING');
  }
}
