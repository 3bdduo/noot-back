import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Db } from '../../prisma/prisma.service.js';
import { AppError } from '../../common/errors/app-error.js';
import { skipTake, toPage } from '../../common/utils/pagination.js';
import type { Pagination } from '../../common/utils/pagination.js';
import { evaluateCoupon } from '../pricing/pricing.js';
import type { CouponDef, CouponResult, PricedLine } from '../pricing/pricing.js';

export const normalizeCouponCode = (code: string) => code.trim().toUpperCase();

const COUPON_INCLUDE = {
  products: { select: { productId: true } },
  collections: { select: { collectionId: true } },
} satisfies Prisma.CouponInclude;
type CouponRow = Prisma.CouponGetPayload<{ include: typeof COUPON_INCLUDE }>;

export interface CouponInput {
  code: string;
  type: 'PERCENTAGE' | 'FIXED';
  value: number;
  minSubtotal?: number | null;
  maxDiscount?: number | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  usageLimit?: number | null;
  perUserLimit?: number | null;
  active?: boolean;
  appliesToAll?: boolean;
  description?: string | null;
  productIds?: string[];
  collectionIds?: string[];
}

function toDef(c: CouponRow): CouponDef {
  return {
    id: c.id,
    code: c.code,
    type: c.type,
    value: c.value,
    minSubtotal: c.minSubtotal,
    maxDiscount: c.maxDiscount,
    startsAt: c.startsAt,
    endsAt: c.endsAt,
    usageLimit: c.usageLimit,
    usedCount: c.usedCount,
    perUserLimit: c.perUserLimit,
    active: c.active,
    appliesToAll: c.appliesToAll,
    productIds: c.products.map((p) => p.productId),
    collectionIds: c.collections.map((p) => p.collectionId),
  };
}

@Injectable()
export class CouponsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Validates a code against the given priced lines.
   * `customer`: the signed-in user id, or the guest's email, used for the per-customer usage limit.
   */
  async evaluate(
    rawCode: string,
    lines: PricedLine[],
    customer: { userId?: string | null; email?: string | null },
    db: Db = this.prisma,
  ): Promise<{ coupon: CouponDef; result: CouponResult }> {
    const row = await db.coupon.findUnique({ where: { code: normalizeCouponCode(rawCode) }, include: COUPON_INCLUDE });
    if (!row) throw AppError.unprocessable('COUPON_INVALID');
    const coupon = toDef(row);

    let prior = 0;
    if (coupon.perUserLimit !== null) {
      prior = await db.couponUsage.count({
        where: {
          couponId: coupon.id,
          ...(customer.userId ? { userId: customer.userId } : customer.email ? { guestEmail: customer.email.toLowerCase() } : { id: '__none__' }),
        },
      });
    }
    return { coupon, result: evaluateCoupon(coupon, lines, { now: new Date(), priorUsesByCustomer: prior }) };
  }

  // ---------------------------------------------------------------- admin

  async list(query: { q?: string; active?: boolean }, pagination: Pagination) {
    const where: Prisma.CouponWhereInput = {
      active: query.active,
      ...(query.q ? { OR: [{ code: { contains: query.q.toUpperCase() } }, { description: { contains: query.q, mode: 'insensitive' } }] } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.coupon.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(pagination), include: COUPON_INCLUDE }),
      this.prisma.coupon.count({ where }),
    ]);
    return toPage(items, total, pagination);
  }

  async get(id: string) {
    const row = await this.prisma.coupon.findUnique({ where: { id }, include: COUPON_INCLUDE });
    if (!row) throw AppError.notFound();
    return row;
  }

  async create(input: CouponInput) {
    const data = this.validated(input);
    const code = normalizeCouponCode(input.code);
    const exists = await this.prisma.coupon.findUnique({ where: { code }, select: { id: true } });
    if (exists) throw AppError.conflict('CONFLICT');

    const created = await this.prisma.$transaction(async (tx) => {
      const c = await tx.coupon.create({ data: { ...data, code } });
      await this.syncTargets(tx, c.id, input.productIds, input.collectionIds);
      return c;
    });
    return this.get(created.id);
  }

  async update(id: string, input: Partial<CouponInput>) {
    const existing = await this.get(id);
    const merged: CouponInput = {
      code: existing.code,
      type: input.type ?? existing.type,
      value: input.value ?? existing.value,
      appliesToAll: input.appliesToAll ?? existing.appliesToAll,
      productIds: input.productIds ?? existing.products.map((p) => p.productId),
      collectionIds: input.collectionIds ?? existing.collections.map((p) => p.collectionId),
    };
    this.validated(merged);
    const { code: _code, productIds, collectionIds, ...rest } = input;
    await this.prisma.$transaction(async (tx) => {
      await tx.coupon.update({ where: { id }, data: rest });
      if (productIds || collectionIds) await this.syncTargets(tx, id, productIds ?? merged.productIds, collectionIds ?? merged.collectionIds);
    });
    return this.get(id);
  }

  /** Coupons are never hard-deleted (usage history); "delete" deactivates. */
  async deactivate(id: string) {
    await this.get(id);
    await this.prisma.coupon.update({ where: { id }, data: { active: false } });
    return { ok: true };
  }

  usages(id: string, pagination: Pagination) {
    return this.prisma.$transaction([
      this.prisma.couponUsage.findMany({
        where: { couponId: id },
        orderBy: { createdAt: 'desc' },
        ...skipTake(pagination),
        include: { order: { select: { orderNumber: true, total: true } }, user: { select: { email: true } } },
      }),
      this.prisma.couponUsage.count({ where: { couponId: id } }),
    ]).then(([items, total]) => toPage(items, total, pagination));
  }

  private validated(input: CouponInput) {
    const bad = (field: string) => AppError.badRequest('VALIDATION_ERROR', {}, [{ field, code: 'INVALID_RULE' }]);
    if (input.type === 'PERCENTAGE' && (input.value < 1 || input.value > 10_000)) throw bad('value');
    if (input.type === 'FIXED' && input.value < 1) throw bad('value');
    if (input.startsAt && input.endsAt && input.startsAt > input.endsAt) throw bad('endsAt');
    if (input.appliesToAll === false && !(input.productIds?.length || input.collectionIds?.length)) throw bad('productIds');
    const { productIds: _p, collectionIds: _c, code: _code, ...data } = input;
    return data;
  }

  private async syncTargets(tx: Prisma.TransactionClient, couponId: string, productIds?: string[], collectionIds?: string[]) {
    await tx.couponProduct.deleteMany({ where: { couponId } });
    await tx.couponCollection.deleteMany({ where: { couponId } });
    if (productIds?.length) await tx.couponProduct.createMany({ data: [...new Set(productIds)].map((productId) => ({ couponId, productId })) });
    if (collectionIds?.length) await tx.couponCollection.createMany({ data: [...new Set(collectionIds)].map((collectionId) => ({ couponId, collectionId })) });
  }
}
