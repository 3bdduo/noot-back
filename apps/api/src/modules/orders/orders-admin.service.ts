import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Locale } from '@nb/shared';
import type { OrderStatus } from '@nb/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AppError } from '../../common/errors/app-error.js';
import { skipTake, toPage } from '../../common/utils/pagination.js';
import type { Pagination } from '../../common/utils/pagination.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { ShippingService } from '../shipping/shipping.service.js';
import { ORDER_VIEW_INCLUDE, OrdersService } from './orders.service.js';
import type { Who } from './orders.service.js';

export interface OrderListFilters {
  status?: OrderStatus;
  paymentStatus?: string;
  paymentMethod?: string;
  governorate?: string;
  hasCustomization?: boolean;
  q?: string;
  from?: Date;
  to?: Date;
}

export interface ShipInput {
  carrier: string;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  /** Subset of items; default = every item of the order. */
  items?: Array<{ orderItemId: string; quantity: number }>;
}

@Injectable()
export class OrdersAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly shipping: ShippingService,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------------------------------------------------------------- list / detail

  async list(f: OrderListFilters, pagination: Pagination) {
    const q = f.q?.trim();
    // MongoDB cannot filter inside a Json column, so a product-name search goes through the translations.
    const productIds = q
      ? (await this.prisma.productTranslation.findMany({ where: { name: { contains: q, mode: 'insensitive' } }, select: { productId: true }, take: 200 })).map((t) => t.productId)
      : [];
    const where: Prisma.OrderWhereInput = {
      status: f.status,
      paymentStatus: f.paymentStatus as any,
      paymentMethod: f.paymentMethod as any,
      governorate: f.governorate,
      hasCustomization: f.hasCustomization,
      placedAt: f.from || f.to ? { gte: f.from, lte: f.to } : undefined,
      ...(q
        ? {
            OR: [
              { orderNumber: { contains: q.toUpperCase() } },
              { contactEmail: { contains: q.toLowerCase() } },
              { contactPhone: { contains: q.replace(/[\s-]/g, '') } },
              ...(productIds.length ? [{ items: { some: { productId: { in: productIds } } } }] : []),
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        orderBy: { placedAt: 'desc' },
        ...skipTake(pagination),
        select: {
          id: true,
          orderNumber: true,
          status: true,
          paymentStatus: true,
          paymentMethod: true,
          total: true,
          governorate: true,
          hasCustomization: true,
          contactEmail: true,
          contactPhone: true,
          shippingAddress: true,
          placedAt: true,
          _count: { select: { items: true } },
        },
      }),
      this.prisma.order.count({ where }),
    ]);
    return toPage(
      rows.map((r) => {
        const a = r.shippingAddress as any;
        return { ...r, itemCount: r._count.items, customerName: [a?.firstName, a?.lastName].filter(Boolean).join(' '), _count: undefined, shippingAddress: undefined };
      }),
      total,
      pagination,
    );
  }

  /** Counts per status for the dashboard tabs. */
  async counts() {
    const groups = await this.prisma.order.groupBy({ by: ['status'], _count: { _all: true } });
    return Object.fromEntries(groups.map((g) => [g.status, g._count._all]));
  }

  async get(id: string, locale: Locale) {
    const order = await this.prisma.order.findFirst({
      where: { OR: [{ id }, { orderNumber: id.toUpperCase() }] },
      include: {
        ...ORDER_VIEW_INCLUDE,
        items: { orderBy: { createdAt: 'asc' }, include: { selections: true, revisions: { orderBy: { createdAt: 'desc' } } } },
        payments: { orderBy: { createdAt: 'desc' }, include: { transactions: { orderBy: { createdAt: 'asc' } } } },
        refunds: { orderBy: { createdAt: 'desc' } },
        notes: { orderBy: { createdAt: 'desc' } },
        history: { orderBy: { createdAt: 'asc' } },
        user: { select: { id: true, email: true, firstName: true, lastName: true, phone: true } },
      },
    });
    if (!order) throw AppError.notFound('ORDER_NOT_FOUND');
    const base = this.orders.view(order as any, locale);
    return {
      ...base,
      user: order.user,
      guestEmail: order.guestEmail,
      payments: order.payments,
      refunds: order.refunds,
      notes: order.notes,
      history: order.history,
      itemsDetail: order.items.map((i) => ({ id: i.id, selections: i.selections, revisions: i.revisions, reviewNote: i.customizationReviewNote, reviewedAt: i.reviewedAt, reviewStatus: i.customizationReviewStatus })),
      nextActions: this.orders.nextActions(order),
      reservationExpiresAt: order.reservationExpiresAt,
    };
  }

  // ---------------------------------------------------------------- actions

  async transition(id: string, to: OrderStatus, who: Who, note?: string, locale: Locale = 'ar') {
    if (to === 'SHIPPED') throw AppError.badRequest('USE_SHIP_ENDPOINT');
    await this.orders.transition(id, to, who, { note, reason: to === 'CANCELLED' ? note : undefined });
    return this.get(id, locale);
  }

  /** Packed -> Shipped: creates the shipment (manual carrier + tracking number) and emails the customer. */
  async ship(id: string, input: ShipInput, who: Who, locale: Locale = 'ar') {
    const order = await this.prisma.order.findUnique({ where: { id }, include: { items: true } });
    if (!order) throw AppError.notFound('ORDER_NOT_FOUND');
    if (order.status !== 'PACKED') throw AppError.conflict('INVALID_TRANSITION', { from: order.status, to: 'SHIPPED' });

    const items = input.items?.length ? input.items : order.items.map((i) => ({ orderItemId: i.id, quantity: i.quantity }));
    for (const it of items) {
      const row = order.items.find((o) => o.id === it.orderItemId);
      if (!row || it.quantity < 1 || it.quantity > row.quantity) throw AppError.badRequest('VALIDATION_ERROR', {}, [{ field: 'items', code: 'INVALID_RULE' }]);
    }

    let after: Array<() => Promise<void>> = [];
    const shipment = await this.prisma.tx(async (tx) => {
      after = []; // reset on transaction retry
      const s = await this.shipping.createShipment(tx, {
        orderId: id,
        carrier: input.carrier,
        trackingNumber: input.trackingNumber,
        trackingUrl: input.trackingUrl,
        estimatedDeliveryAt: order.estimatedDeliveryAt,
        items,
      });
      await this.orders.transitionInTx(tx, id, 'SHIPPED', who, { note: input.trackingNumber ? `tracking ${input.trackingNumber}` : undefined }, after);
      return s;
    });
    after.push(() =>
      this.notifications.notify({
        event: 'order_shipped',
        locale: order.locale as Locale,
        userId: order.userId,
        email: order.contactEmail,
        data: {
          name: (order.shippingAddress as any)?.firstName,
          orderNumber: order.orderNumber,
          carrier: shipment.carrier,
          trackingNumber: shipment.trackingNumber,
          trackingUrl: shipment.trackingUrl,
        },
      }),
    );
    await this.orders.runAfter(after);
    return this.get(id, locale);
  }

  async addNote(id: string, body: string, authorId: string) {
    const order = await this.prisma.order.findUnique({ where: { id }, select: { id: true } });
    if (!order) throw AppError.notFound('ORDER_NOT_FOUND');
    return this.prisma.orderNote.create({ data: { orderId: id, authorId, body } });
  }

  async addShipmentEvent(shipmentId: string, input: { status: string; description?: string; location?: string }) {
    const s = await this.prisma.shipment.findUnique({ where: { id: shipmentId } });
    if (!s) throw AppError.notFound();
    await this.prisma.$transaction([
      this.prisma.shipmentEvent.create({ data: { shipmentId, status: input.status as any, description: input.description ?? null, location: input.location ?? null, source: 'admin' } }),
      this.prisma.shipment.update({ where: { id: shipmentId }, data: { status: input.status as any } }),
    ]);
    return { ok: true };
  }

  // ---------------------------------------------------------------- COD abuse: blocked phones

  listBlockedPhones() {
    return this.prisma.blockedPhone.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async blockPhone(phone: string, reason?: string) {
    return this.prisma.blockedPhone.upsert({ where: { phone }, create: { phone, reason: reason ?? null }, update: { reason: reason ?? null } });
  }

  async unblockPhone(id: string) {
    await this.prisma.blockedPhone.deleteMany({ where: { id } });
    return { ok: true };
  }
}

