import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Locale } from '@nb/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AppError } from '../../common/errors/app-error.js';
import { skipTake, toPage } from '../../common/utils/pagination.js';
import type { Pagination } from '../../common/utils/pagination.js';
import { pickTranslation } from '../../common/utils/translate.js';
import { STORAGE_DRIVER } from '../uploads/storage.driver.js';
import type { StorageDriver } from '../uploads/storage.driver.js';

export interface ReviewInput {
  rating: number;
  title?: string;
  body?: string;
  /** Keys returned by `POST /admin`-style media upload with folder "reviews" (max 4). */
  imageKeys?: string[];
}

const maskName = (first: string, last: string) => `${first} ${last ? last.charAt(0) + '.' : ''}`.trim();

@Injectable()
export class ReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_DRIVER) private readonly storage: StorageDriver,
  ) {}

  // ---------------------------------------------------------------- public

  async listForProduct(slug: string, pagination: Pagination, sort: 'recent' | 'highest' | 'lowest') {
    const product = await this.prisma.product.findFirst({ where: { slug, status: 'ACTIVE', deletedAt: null }, select: { id: true, avgRating: true, reviewCount: true } });
    if (!product) throw AppError.notFound('PRODUCT_NOT_FOUND');

    const where: Prisma.ReviewWhereInput = { productId: product.id, status: 'APPROVED' };
    const orderBy: Prisma.ReviewOrderByWithRelationInput[] =
      sort === 'highest' ? [{ rating: 'desc' }, { createdAt: 'desc' }] : sort === 'lowest' ? [{ rating: 'asc' }, { createdAt: 'desc' }] : [{ createdAt: 'desc' }];

    const [rows, total, dist] = await Promise.all([
      this.prisma.review.findMany({ where, orderBy, ...skipTake(pagination), include: { images: true, user: { select: { firstName: true, lastName: true } } } }),
      this.prisma.review.count({ where }),
      this.prisma.review.groupBy({ by: ['rating'], where, _count: { _all: true } }),
    ]);
    const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const d of dist) distribution[d.rating] = d._count._all;

    return {
      summary: { average: product.avgRating, count: product.reviewCount, distribution },
      ...toPage(
        rows.map((r) => ({
          id: r.id,
          rating: r.rating,
          title: r.title,
          body: r.body,
          author: maskName(r.user.firstName, r.user.lastName),
          verifiedPurchase: r.verifiedPurchase,
          adminResponse: r.adminResponse,
          images: r.images.map((i) => i.url),
          createdAt: r.createdAt,
        })),
        total,
        pagination,
      ),
    };
  }

  // ---------------------------------------------------------------- customer

  /** Delivered products the customer has not reviewed yet. */
  async reviewable(userId: string, locale: Locale) {
    const items = await this.prisma.orderItem.findMany({
      where: { order: { userId, status: 'DELIVERED' }, product: { deletedAt: null } },
      orderBy: { createdAt: 'desc' },
      include: { product: { include: { translations: true, media: { take: 1, orderBy: { sortOrder: 'asc' } } } }, order: { select: { orderNumber: true, deliveredAt: true } } },
    });
    const reviewed = new Set((await this.prisma.review.findMany({ where: { userId }, select: { productId: true } })).map((r) => r.productId));
    const seen = new Set<string>();
    return items
      .filter((i) => !reviewed.has(i.productId) && !seen.has(i.productId) && seen.add(i.productId))
      .map((i) => ({
        orderItemId: i.id,
        productId: i.productId,
        slug: i.product.slug,
        name: pickTranslation(i.product.translations, locale)?.name ?? i.product.slug,
        image: i.product.media[0]?.url ?? null,
        orderNumber: i.order.orderNumber,
        deliveredAt: i.order.deliveredAt,
      }));
  }

  async mine(userId: string, locale: Locale) {
    const rows = await this.prisma.review.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { images: true, product: { include: { translations: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      productId: r.productId,
      slug: r.product.slug,
      productName: pickTranslation(r.product.translations, locale)?.name ?? r.product.slug,
      rating: r.rating,
      title: r.title,
      body: r.body,
      status: r.status,
      adminResponse: r.adminResponse,
      images: r.images.map((i) => i.url),
      createdAt: r.createdAt,
    }));
  }

  async create(userId: string, productId: string, input: ReviewInput) {
    const purchase = await this.prisma.orderItem.findFirst({
      where: { productId, order: { userId, status: 'DELIVERED' } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (!purchase) throw AppError.forbidden('REVIEW_NOT_ALLOWED');
    const exists = await this.prisma.review.findUnique({ where: { productId_userId: { productId, userId } } });
    if (exists) throw AppError.conflict('REVIEW_EXISTS');

    const images = await this.resolveImages(input.imageKeys);
    const review = await this.prisma.review.create({
      data: {
        productId,
        userId,
        orderItemId: purchase.id,
        rating: input.rating,
        title: input.title ?? null,
        body: input.body ?? null,
        status: 'PENDING',
        verifiedPurchase: true,
        images: { create: images },
      },
    });
    return { id: review.id, status: review.status };
  }

  /** Editing sends the review back to moderation. */
  async update(userId: string, id: string, input: ReviewInput) {
    const review = await this.prisma.review.findFirst({ where: { id, userId } });
    if (!review) throw AppError.notFound();
    const images = input.imageKeys ? await this.resolveImages(input.imageKeys) : null;
    await this.prisma.$transaction(async (tx) => {
      await tx.review.update({ where: { id }, data: { rating: input.rating, title: input.title ?? null, body: input.body ?? null, status: 'PENDING', adminResponse: null } });
      if (images) {
        await tx.reviewImage.deleteMany({ where: { reviewId: id } });
        if (images.length) await tx.reviewImage.createMany({ data: images.map((i) => ({ ...i, reviewId: id })) });
      }
    });
    await this.recompute(review.productId);
    return { id, status: 'PENDING' as const };
  }

  async remove(userId: string, id: string) {
    const review = await this.prisma.review.findFirst({ where: { id, userId } });
    if (!review) throw AppError.notFound();
    await this.prisma.review.delete({ where: { id } });
    await this.recompute(review.productId);
    return { ok: true };
  }

  private async resolveImages(keys?: string[]) {
    if (!keys?.length) return [];
    if (keys.length > 4) throw AppError.badRequest('VALIDATION_ERROR', {}, [{ field: 'imageKeys', code: 'TOO_MANY' }]);
    const out: Array<{ url: string; storageKey: string }> = [];
    for (const key of new Set(keys)) {
      if (!/^media\/reviews\/[\w.-]+$/.test(key)) throw AppError.badRequest('VALIDATION_ERROR', {}, [{ field: 'imageKeys', code: 'INVALID_KEY' }]);
      if (!(await this.storage.head(key))) throw AppError.unprocessable('UPLOAD_MISSING');
      out.push({ url: this.storage.publicUrl(key), storageKey: key });
    }
    return out;
  }

  // ---------------------------------------------------------------- admin

  async adminList(f: { status?: string; productId?: string; rating?: number; q?: string }, pagination: Pagination) {
    const where: Prisma.ReviewWhereInput = {
      status: f.status as any,
      productId: f.productId,
      rating: f.rating,
      ...(f.q ? { OR: [{ title: { contains: f.q, mode: 'insensitive' } }, { body: { contains: f.q, mode: 'insensitive' } }] } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.review.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...skipTake(pagination),
        include: { images: true, user: { select: { email: true, firstName: true, lastName: true } }, product: { select: { slug: true, translations: { where: { locale: 'ar' }, select: { name: true } } } } },
      }),
      this.prisma.review.count({ where }),
    ]);
    return toPage(items, total, pagination);
  }

  async moderate(id: string, input: { status?: 'APPROVED' | 'REJECTED' | 'PENDING'; adminResponse?: string | null }) {
    const review = await this.prisma.review.findUnique({ where: { id } });
    if (!review) throw AppError.notFound();
    await this.prisma.review.update({ where: { id }, data: { status: input.status, adminResponse: input.adminResponse } });
    await this.recompute(review.productId);
    return this.prisma.review.findUnique({ where: { id }, include: { images: true } });
  }

  async adminDelete(id: string) {
    const review = await this.prisma.review.findUnique({ where: { id } });
    if (!review) throw AppError.notFound();
    await this.prisma.review.delete({ where: { id } });
    await this.recompute(review.productId);
    return { ok: true };
  }

  /** Denormalised rating on the product card, derived only from approved reviews. */
  async recompute(productId: string) {
    const agg = await this.prisma.review.aggregate({ where: { productId, status: 'APPROVED' }, _avg: { rating: true }, _count: { _all: true } });
    await this.prisma.product.update({
      where: { id: productId },
      data: { avgRating: Math.round((agg._avg.rating ?? 0) * 10) / 10, reviewCount: agg._count._all },
    });
  }
}
