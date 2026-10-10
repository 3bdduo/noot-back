import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Locale } from '@nb/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AppError } from '../../common/errors/app-error.js';
import { logEvent } from '../../common/logger.js';
import { skipTake, toPage } from '../../common/utils/pagination.js';
import type { Pagination } from '../../common/utils/pagination.js';
import { env } from '../../config/env.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { OrdersService } from '../orders/orders.service.js';
import type { OrderAccess, Who } from '../orders/orders.service.js';
import { MockProvider } from './mock.provider.js';
import type { PaymentProvider } from './payment-provider.js';

@Injectable()
export class PaymentsService {
  private readonly providers = new Map<string, PaymentProvider>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly notifications: NotificationsService,
  ) {
    // Register real providers here (e.g. this.providers.set('paymob', new PaymobProvider())).
    if (env.PAYMENT_PROVIDER === 'mock') this.providers.set('mock', new MockProvider());
  }

  get activeProviderName() {
    return env.PAYMENT_PROVIDER;
  }

  private provider(name: string = env.PAYMENT_PROVIDER): PaymentProvider {
    const p = this.providers.get(name);
    if (!p) throw AppError.unprocessable('PAYMENT_NOT_AVAILABLE');
    return p;
  }

  /** What the checkout page can offer right now. */
  availableMethods() {
    const online = env.PAYMENT_PROVIDER !== 'none';
    return { CARD: online, WALLET: online, COD: true, provider: env.PAYMENT_PROVIDER };
  }

  // ---------------------------------------------------------------- start an online payment

  async initiate(orderRef: string, access: OrderAccess) {
    const order = await this.orders.findForAccess(orderRef, access);
    if (order.status !== 'PENDING_PAYMENT' || order.paymentMethod === 'COD') throw AppError.unprocessable('ORDER_NOT_PAYABLE');
    if (order.reservationExpiresAt && order.reservationExpiresAt < new Date()) throw AppError.unprocessable('RESERVATION_LOST');

    const provider = this.provider();
    const payment = await this.prisma.payment.findFirst({ where: { orderId: order.id, status: { in: ['PENDING', 'FAILED'] } }, orderBy: { createdAt: 'desc' } });
    if (!payment) throw AppError.unprocessable('ORDER_NOT_PAYABLE');

    const addr = order.shippingAddress as any;
    const result = await provider.createPayment({
      orderId: order.id,
      orderNumber: order.orderNumber,
      paymentId: payment.id,
      amount: order.total,
      currency: order.currency,
      method: order.paymentMethod as 'CARD' | 'WALLET',
      customer: { email: order.contactEmail, phone: order.contactPhone, name: `${addr?.firstName ?? ''} ${addr?.lastName ?? ''}`.trim() },
    });

    await this.prisma.$transaction([
      this.prisma.payment.update({ where: { id: payment.id }, data: { provider: provider.name, providerRef: result.providerRef, status: 'PENDING', failureReason: null } }),
      this.prisma.paymentTransaction.create({ data: { paymentId: payment.id, type: 'CREATE', status: 'CREATED', amount: order.total, providerTransactionId: result.providerRef } }),
      this.prisma.order.update({ where: { id: order.id }, data: { paymentStatus: 'PENDING' } }),
    ]);
    return { redirectUrl: result.redirectUrl, provider: provider.name };
  }

  /** Polling endpoint for the "payment result" page. */
  async status(orderRef: string, access: OrderAccess) {
    const order = await this.orders.findForAccess(orderRef, access);
    return { orderNumber: order.orderNumber, status: order.status, paymentStatus: order.paymentStatus, paid: order.paymentStatus === 'PAID' };
  }

  // ---------------------------------------------------------------- webhooks

  /**
   * Idempotent: the same provider event delivered twice is processed once. The signature is verified over the raw
   * body, and where the provider supports it the final state is re-fetched server-to-server before trusting it.
   */
  async handleWebhook(providerName: string, rawBody: Buffer, headers: Record<string, string | string[] | undefined>) {
    const provider = this.provider(providerName);
    let event;
    try {
      event = provider.parseWebhook(rawBody, headers);
    } catch (e) {
      logEvent('warn', 'payment.webhook_rejected', { provider: providerName });
      throw e;
    }

    const payload = JSON.parse(rawBody.toString('utf8')) as Prisma.InputJsonValue;
    let record;
    try {
      record = await this.prisma.paymentWebhookEvent.create({
        data: { provider: providerName, eventId: event.eventId, eventType: event.type, payload, signatureValid: true },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return { ok: true, duplicate: true };
      throw e;
    }

    try {
      const payment = await this.prisma.payment.findFirst({ where: { provider: providerName, providerRef: event.providerRef } });
      if (!payment) {
        await this.prisma.paymentWebhookEvent.update({ where: { id: record.id }, data: { status: 'IGNORED', error: 'payment_not_found', processedAt: new Date() } });
        return { ok: true, ignored: true };
      }

      let status = event.status;
      let amount = event.amount;
      if (provider.fetchStatus) {
        const live = await provider.fetchStatus(event.providerRef);
        if (live.status === 'PENDING') throw AppError.conflict('PAYMENT_PENDING');
        status = live.status;
        amount = live.amount;
      }

      await this.prisma.paymentTransaction.create({
        data: { paymentId: payment.id, type: 'WEBHOOK', status, amount, providerTransactionId: event.eventId, rawResponse: payload },
      });

      if (status === 'PAID') {
        await this.orders.confirmOnlinePayment(payment.orderId, { paymentId: payment.id, providerRef: event.providerRef, amount });
      } else {
        await this.orders.failOnlinePayment(payment.orderId, payment.id, event.type);
      }
      await this.prisma.paymentWebhookEvent.update({ where: { id: record.id }, data: { status: 'PROCESSED', processedAt: new Date() } });
      return { ok: true };
    } catch (e) {
      await this.prisma.paymentWebhookEvent.update({
        where: { id: record.id },
        data: { status: 'FAILED', error: String((e as Error).message).slice(0, 300), processedAt: new Date() },
      });
      logEvent('error', 'payment.webhook_failed', { provider: providerName, eventId: event.eventId, message: (e as Error).message });
      throw e;
    }
  }

  // ---------------------------------------------------------------- refunds

  /**
   * Creates a refund request. Money only moves when `completeRefund` runs
   * (provider API when supported, otherwise the operator confirms a manual bank/wallet transfer).
   */
  async requestRefund(orderId: string, input: { amount: number; reason?: string; orderItemId?: string }, who: Who) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { refunds: true } });
    if (!order) throw AppError.notFound('ORDER_NOT_FOUND');
    if (order.paymentStatus !== 'PAID' && order.paymentStatus !== 'PARTIALLY_REFUNDED' && order.paymentStatus !== 'REFUND_PENDING') {
      throw AppError.unprocessable('REFUND_NOT_ALLOWED');
    }
    const payment = await this.prisma.payment.findFirst({ where: { orderId, status: { in: ['PAID', 'PARTIALLY_REFUNDED', 'REFUND_PENDING'] } }, orderBy: { createdAt: 'desc' } });
    if (!payment) throw AppError.unprocessable('REFUND_NOT_ALLOWED');

    const committed = order.refunds.filter((r) => r.status !== 'FAILED').reduce((s, r) => s + r.amount, 0);
    if (input.amount < 1 || committed + input.amount > payment.amount) throw AppError.unprocessable('REFUND_EXCEEDS_PAID', { max: ((payment.amount - committed) / 100).toFixed(2) });

    if (input.orderItemId) {
      const item = await this.prisma.orderItem.findFirst({ where: { id: input.orderItemId, orderId } });
      if (!item) throw AppError.notFound('ORDER_ITEM_NOT_FOUND');
    }

    const refund = await this.prisma.refund.create({
      data: { orderId, paymentId: payment.id, amount: input.amount, reason: input.reason ?? null, orderItemId: input.orderItemId ?? null, status: 'PENDING', requestedById: who.id ?? null },
    });
    await this.prisma.order.update({ where: { id: orderId }, data: { paymentStatus: 'REFUND_PENDING' } });

    // Full refund of a delivered/shipped order moves it into the refund flow.
    if (committed + input.amount === payment.amount && ['SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED'].includes(order.status)) {
      await this.orders.transition(orderId, 'REFUND_REQUESTED', who, { note: input.reason });
    }
    return refund;
  }

  async completeRefund(refundId: string, who: Who, manualReference?: string) {
    const refund = await this.prisma.refund.findUnique({ where: { id: refundId }, include: { payment: true, order: true } });
    if (!refund) throw AppError.notFound();
    if (refund.status === 'COMPLETED') return refund;
    if (refund.status !== 'PENDING') throw AppError.conflict('REFUND_NOT_PENDING');

    let providerRefundId: string | null = manualReference ?? null;
    const provider = refund.payment.provider ? this.providers.get(refund.payment.provider) : undefined;
    if (provider?.refund && refund.payment.providerRef) {
      const res = await provider.refund({ providerRef: refund.payment.providerRef, amount: refund.amount, reason: refund.reason ?? undefined });
      providerRefundId = res.providerRefundId;
      await this.prisma.paymentTransaction.create({
        data: { paymentId: refund.paymentId, type: 'REFUND', status: 'COMPLETED', amount: refund.amount, providerTransactionId: res.providerRefundId },
      });
    } else if (!manualReference) {
      // No provider API (COD / unsupported): the operator must record how the money was returned.
      throw AppError.badRequest('VALIDATION_ERROR', {}, [{ field: 'manualReference', code: 'REQUIRED' }]);
    }

    let after: Array<() => Promise<void>> = [];
    await this.prisma.tx(async (tx) => {
      after = []; // reset on transaction retry
      await tx.refund.update({ where: { id: refundId }, data: { status: 'COMPLETED', completedAt: new Date(), providerRefundId } });
      if (refund.orderItemId) await tx.orderItem.update({ where: { id: refund.orderItemId }, data: { refundedAmount: { increment: refund.amount } } });

      const completed = await tx.refund.aggregate({ where: { orderId: refund.orderId, status: 'COMPLETED' }, _sum: { amount: true } });
      const pending = await tx.refund.count({ where: { orderId: refund.orderId, status: 'PENDING' } });
      const total = completed._sum.amount ?? 0;
      const full = total >= refund.payment.amount;
      const paymentStatus = full ? 'REFUNDED' : pending > 0 ? 'REFUND_PENDING' : 'PARTIALLY_REFUNDED';
      await tx.payment.update({ where: { id: refund.paymentId }, data: { status: full ? 'REFUNDED' : 'PARTIALLY_REFUNDED' } });
      await tx.order.update({ where: { id: refund.orderId }, data: { paymentStatus } });
      if (full && refund.order.status === 'REFUND_REQUESTED') {
        await this.orders.transitionInTx(tx, refund.orderId, 'REFUNDED', who, { note: 'refund completed' }, after);
      }
    });
    after.push(() =>
      this.notifications.notify({
        event: 'refund_confirmed',
        locale: refund.order.locale as Locale,
        userId: refund.order.userId,
        email: refund.order.contactEmail,
        data: { orderNumber: refund.order.orderNumber, amount: refund.amount },
      }),
    );
    await this.orders.runAfter(after);
    return this.prisma.refund.findUniqueOrThrow({ where: { id: refundId } });
  }

  async cancelRefund(refundId: string) {
    const r = await this.prisma.refund.findUnique({ where: { id: refundId } });
    if (!r) throw AppError.notFound();
    if (r.status !== 'PENDING') throw AppError.conflict('REFUND_NOT_PENDING');
    await this.prisma.refund.update({ where: { id: refundId }, data: { status: 'FAILED' } });
    const stillPending = await this.prisma.refund.count({ where: { orderId: r.orderId, status: 'PENDING' } });
    if (!stillPending) {
      const done = await this.prisma.refund.count({ where: { orderId: r.orderId, status: 'COMPLETED' } });
      await this.prisma.order.update({ where: { id: r.orderId }, data: { paymentStatus: done ? 'PARTIALLY_REFUNDED' : 'PAID' } });
    }
    return { ok: true };
  }

  // ---------------------------------------------------------------- admin lists

  async listPayments(f: { status?: string; method?: string; q?: string }, pagination: Pagination) {
    const where: Prisma.PaymentWhereInput = {
      status: f.status as any,
      method: f.method as any,
      ...(f.q ? { OR: [{ providerRef: { contains: f.q } }, { order: { orderNumber: { contains: f.q.toUpperCase() } } }] } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.payment.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(pagination), include: { order: { select: { orderNumber: true, status: true, contactEmail: true } } } }),
      this.prisma.payment.count({ where }),
    ]);
    return toPage(items, total, pagination);
  }

  async listRefunds(f: { status?: string }, pagination: Pagination) {
    const where: Prisma.RefundWhereInput = { status: f.status as any };
    const [items, total] = await Promise.all([
      this.prisma.refund.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(pagination), include: { order: { select: { orderNumber: true, contactEmail: true } } } }),
      this.prisma.refund.count({ where }),
    ]);
    return toPage(items, total, pagination);
  }

  async listWebhooks(f: { status?: string }, pagination: Pagination) {
    const where: Prisma.PaymentWebhookEventWhereInput = { status: f.status as any };
    const [items, total] = await Promise.all([
      this.prisma.paymentWebhookEvent.findMany({ where, orderBy: { receivedAt: 'desc' }, ...skipTake(pagination) }),
      this.prisma.paymentWebhookEvent.count({ where }),
    ]);
    return toPage(items, total, pagination);
  }

  async findByProviderRef(provider: string, ref: string) {
    return this.prisma.payment.findFirst({ where: { provider, providerRef: ref }, include: { order: { select: { orderNumber: true } } } });
  }
}
