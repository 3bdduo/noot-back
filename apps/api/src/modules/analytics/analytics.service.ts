import { Injectable } from '@nestjs/common';
import type { OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AppError } from '../../common/errors/app-error.js';

const TZ = 'Africa/Cairo';
/** Orders that count as real sales: confirmed and not cancelled/refunded. */
const SALE_STATUSES: OrderStatus[] = [
  'PAYMENT_CONFIRMED',
  'CUSTOMIZATION_REVIEW',
  'CUSTOMIZATION_APPROVED',
  'IN_PRODUCTION',
  'QUALITY_CHECK',
  'PACKED',
  'SHIPPED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
];
const MAX_RANGE_DAYS = 366;
/** Safety cap for the in-memory aggregations below (a year of a very busy store). */
const MAX_ROWS = 100_000;

export interface Range {
  from: Date;
  to: Date;
}

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : 0);

/** `YYYY-MM-DD` of an instant on the Cairo calendar. */
const cairoDay = (() => {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  return (d: Date) => fmt.format(d);
})();

/**
 * Analytics for MongoDB: simple counts/sums use Prisma aggregates, the rest is grouped in memory from
 * narrow `select`ed rows inside the (max 366 day) range. That keeps everything typed and independent
 * of hand-written aggregation pipelines; MAX_ROWS bounds the memory used.
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Defaults to the last 30 days; day boundaries are Cairo days. */
  resolveRange(from?: Date, to?: Date): Range {
    const end = to ?? new Date();
    const start = from ?? new Date(end.getTime() - 30 * 86_400_000);
    if (start > end) throw AppError.badRequest('VALIDATION_ERROR', {}, [{ field: 'from', code: 'INVALID_RULE' }]);
    if ((end.getTime() - start.getTime()) / 86_400_000 > MAX_RANGE_DAYS) throw AppError.badRequest('VALIDATION_ERROR', {}, [{ field: 'to', code: 'RANGE_TOO_LARGE' }]);
    return { from: start, to: end };
  }

  private saleWhere(r: Range): Prisma.OrderWhereInput {
    return { status: { in: SALE_STATUSES }, placedAt: { gte: r.from, lte: r.to } };
  }

  async overview(r: Range) {
    const where = this.saleWhere(r);
    const rangeAll: Prisma.OrderWhereInput = { placedAt: { gte: r.from, lte: r.to } };
    const [sales, customized, placed, cancelled, cod, items, newCustomers, perCustomer] = await Promise.all([
      this.prisma.order.aggregate({ where, _count: { _all: true }, _sum: { total: true, discount: true, shippingFee: true } }),
      this.prisma.order.count({ where: { ...where, hasCustomization: true } }),
      this.prisma.order.count({ where: rangeAll }),
      this.prisma.order.count({ where: { ...rangeAll, status: 'CANCELLED' } }),
      this.prisma.order.count({ where: { ...rangeAll, paymentMethod: 'COD' } }),
      this.prisma.orderItem.aggregate({ where: { order: where }, _sum: { quantity: true } }),
      this.prisma.user.count({ where: { createdAt: { gte: r.from, lte: r.to }, deletedAt: null, roles: { some: { role: { key: 'customer' } } } } }),
      // lifetime sale-order count per registered customer -> repeat buyers
      this.prisma.order.groupBy({ by: ['userId'], where: { userId: { not: null }, status: { in: SALE_STATUSES } }, _count: { _all: true } }),
    ]);

    const orders = sales._count._all;
    const revenue = num(sales._sum.total);
    return {
      range: r,
      timezone: TZ,
      orders,
      revenue,
      averageOrderValue: orders ? Math.round(revenue / orders) : 0,
      unitsSold: num(items._sum.quantity),
      discountsGiven: num(sales._sum.discount),
      shippingCollected: num(sales._sum.shippingFee),
      customizedShare: pct(customized, orders),
      ordersPlaced: placed,
      cancellationRate: pct(cancelled, placed),
      codShare: pct(cod, placed),
      newCustomers,
      repeatCustomers: perCustomer.filter((c) => c._count._all > 1).length,
    };
  }

  async salesByDay(r: Range) {
    const rows = await this.prisma.order.findMany({ where: this.saleWhere(r), select: { placedAt: true, total: true }, take: MAX_ROWS });
    const days = new Map<string, { orders: number; revenue: number }>();
    for (const o of rows) {
      const key = cairoDay(o.placedAt);
      const d = days.get(key) ?? { orders: 0, revenue: 0 };
      d.orders += 1;
      d.revenue += o.total;
      days.set(key, d);
    }
    return [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, v]) => ({ day, ...v }));
  }

  async topProducts(r: Range, limit = 10) {
    const rows = await this.prisma.orderItem.findMany({
      where: { order: this.saleWhere(r) },
      select: { productId: true, quantity: true, totalPrice: true, productSnapshot: true },
      take: MAX_ROWS,
    });
    const byProduct = new Map<string, { productId: string; name: string | null; units: number; revenue: number }>();
    for (const it of rows) {
      const snap = it.productSnapshot as { name?: { ar?: string } } | null;
      const cur = byProduct.get(it.productId) ?? { productId: it.productId, name: snap?.name?.ar ?? null, units: 0, revenue: 0 };
      cur.units += it.quantity;
      cur.revenue += it.totalPrice;
      byProduct.set(it.productId, cur);
    }
    return [...byProduct.values()].sort((a, b) => b.units - a.units).slice(0, limit);
  }

  /** Which customization options customers actually choose (for stock planning and merchandising). */
  async customizationPopularity(r: Range, limit = 40) {
    const rows = await this.prisma.customizationSelection.findMany({
      where: { optionCode: { not: null }, orderItem: { order: this.saleWhere(r) } },
      select: { groupCode: true, optionCode: true, nameSnapshot: true, orderItem: { select: { quantity: true } } },
      take: MAX_ROWS,
    });
    const byOption = new Map<string, { groupCode: string; optionCode: string | null; name: string | null; uses: number; units: number }>();
    for (const s of rows) {
      const key = `${s.groupCode}\u0000${s.optionCode}`;
      const cur = byOption.get(key) ?? { groupCode: s.groupCode, optionCode: s.optionCode, name: s.nameSnapshot, uses: 0, units: 0 };
      cur.uses += 1;
      cur.units += s.orderItem.quantity;
      byOption.set(key, cur);
    }
    return [...byOption.values()].sort((a, b) => b.units - a.units).slice(0, limit);
  }

  async byGovernorate(r: Range) {
    const rows = await this.prisma.order.groupBy({ by: ['governorate'], where: this.saleWhere(r), _count: { _all: true }, _sum: { total: true } });
    return rows.map((x) => ({ governorate: x.governorate, orders: x._count._all, revenue: num(x._sum.total) })).sort((a, b) => b.revenue - a.revenue);
  }

  async byPaymentMethod(r: Range) {
    const rows = await this.prisma.order.groupBy({ by: ['paymentMethod'], where: this.saleWhere(r), _count: { _all: true }, _sum: { total: true } });
    return rows.map((x) => ({ method: x.paymentMethod as string, orders: x._count._all, revenue: num(x._sum.total) }));
  }

  async couponPerformance(r: Range) {
    const rows = await this.prisma.couponUsage.findMany({
      where: { order: this.saleWhere(r) },
      select: { discount: true, coupon: { select: { code: true } }, order: { select: { total: true } } },
      take: MAX_ROWS,
    });
    const byCode = new Map<string, { code: string; uses: number; discount: number; revenue: number }>();
    for (const u of rows) {
      const cur = byCode.get(u.coupon.code) ?? { code: u.coupon.code, uses: 0, discount: 0, revenue: 0 };
      cur.uses += 1;
      cur.discount += u.discount;
      cur.revenue += u.order.total;
      byCode.set(u.coupon.code, cur);
    }
    return [...byCode.values()].sort((a, b) => b.uses - a.uses).slice(0, 20);
  }

  /** Operational snapshot (not range based): what needs attention right now. */
  async operations() {
    const [byStatus, pendingReview, tracked, abandonedCarts, newMessages, pendingReviews, pendingRefunds] = await Promise.all([
      this.prisma.order.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.orderItem.count({ where: { customizationReviewStatus: 'PENDING_REVIEW', order: { status: 'CUSTOMIZATION_REVIEW' } } }),
      // "available <= threshold" compares two fields of the same document, so it is evaluated here
      this.prisma.inventoryItem.findMany({ where: { trackInventory: true }, select: { quantity: true, reserved: true, lowStockThreshold: true } }),
      this.prisma.cart.count({ where: { updatedAt: { lt: new Date(Date.now() - 3 * 3_600_000) }, items: { some: { savedForLater: false } } } }),
      this.prisma.contactMessage.count({ where: { status: 'NEW' } }),
      this.prisma.review.count({ where: { status: 'PENDING' } }),
      this.prisma.refund.count({ where: { status: 'PENDING' } }),
    ]);
    return {
      ordersByStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
      customizationsAwaitingReview: pendingReview,
      lowStockItems: tracked.filter((i) => i.quantity - i.reserved <= i.lowStockThreshold).length,
      abandonedCarts,
      newContactMessages: newMessages,
      reviewsAwaitingModeration: pendingReviews,
      refundsPending: pendingRefunds,
    };
  }
}
