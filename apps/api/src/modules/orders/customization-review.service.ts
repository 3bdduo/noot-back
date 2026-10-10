import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Locale } from '@nb/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AppError } from '../../common/errors/app-error.js';
import { skipTake, toPage } from '../../common/utils/pagination.js';
import type { Pagination } from '../../common/utils/pagination.js';
import { env } from '../../config/env.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { OrdersService, pickBilingual } from './orders.service.js';
import type { Who } from './orders.service.js';

export type ReviewAction = 'approve' | 'request_changes' | 'reject';

@Injectable()
export class CustomizationReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Queue of customized items, oldest first. */
  async list(filters: { status?: string; q?: string }, pagination: Pagination, locale: Locale) {
    const where: Prisma.OrderItemWhereInput = {
      customizationReviewStatus: (filters.status ?? 'PENDING_REVIEW') as any,
      order: {
        status: { notIn: ['CANCELLED', 'REFUNDED', 'PENDING_PAYMENT', 'COD_PENDING'] },
        ...(filters.q ? { OR: [{ orderNumber: { contains: filters.q.toUpperCase() } }, { contactEmail: { contains: filters.q.toLowerCase() } }] } : {}),
      },
    };
    const [rows, total] = await Promise.all([
      this.prisma.orderItem.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        ...skipTake(pagination),
        include: { order: { select: { id: true, orderNumber: true, status: true, placedAt: true, contactEmail: true } } },
      }),
      this.prisma.orderItem.count({ where }),
    ]);
    return toPage(rows.map((r) => this.row(r, locale)), total, pagination);
  }

  async get(itemId: string, locale: Locale) {
    const item = await this.prisma.orderItem.findUnique({
      where: { id: itemId },
      include: {
        order: { select: { id: true, orderNumber: true, status: true, placedAt: true, contactEmail: true } },
        selections: { include: { artworkFile: { select: { id: true, originalName: true, mimeType: true, widthPx: true, heightPx: true, status: true } } } },
        revisions: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!item || !item.customizationSnapshot) throw AppError.notFound('ORDER_ITEM_NOT_FOUND');
    return { ...this.row(item, locale), snapshot: item.customizationSnapshot, selections: item.selections, revisions: item.revisions, reviewNote: item.customizationReviewNote };
  }

  private row(item: any, locale: Locale) {
    return {
      id: item.id,
      orderId: item.order.id,
      orderNumber: item.order.orderNumber,
      orderStatus: item.order.status,
      placedAt: item.order.placedAt,
      productName: pickBilingual(item.productSnapshot?.name, locale),
      quantity: item.quantity,
      reviewStatus: item.customizationReviewStatus,
      summary: item.customizationSnapshot?.summary ?? null,
    };
  }

  async review(itemId: string, action: ReviewAction, note: string | undefined, who: Who) {
    if (action !== 'approve' && !note?.trim()) throw AppError.badRequest('VALIDATION_ERROR', {}, [{ field: 'note', code: 'REQUIRED' }]);

    const item = await this.prisma.orderItem.findUnique({ where: { id: itemId }, include: { order: true } });
    if (!item || !item.customizationSnapshot) throw AppError.notFound('ORDER_ITEM_NOT_FOUND');
    const order = item.order;
    if (!['CUSTOMIZATION_REVIEW', 'CUSTOMIZATION_APPROVED'].includes(order.status)) throw AppError.conflict('INVALID_TRANSITION', { from: order.status });
    if (!['PENDING_REVIEW', 'APPROVED', 'NEEDS_CHANGES'].includes(item.customizationReviewStatus ?? '')) throw AppError.conflict('ORDER_CHANGED');

    const status = action === 'approve' ? 'APPROVED' : action === 'request_changes' ? 'NEEDS_CHANGES' : 'REJECTED';
    await this.prisma.orderItem.update({
      where: { id: itemId },
      data: { customizationReviewStatus: status, customizationReviewNote: note?.trim() ?? null, reviewedById: who.id ?? null, reviewedAt: new Date() },
    });

    const notify = (event: 'customization_changes') =>
      this.notifications.notify({
        event,
        locale: order.locale as Locale,
        userId: order.userId,
        email: order.contactEmail,
        data: {
          name: (order.shippingAddress as any)?.firstName,
          orderNumber: order.orderNumber,
          note: note?.trim(),
          editUrl: `${env.APP_URL.replace(/\/$/, '')}/account/orders/${order.id}`,
        },
      });

    if (action === 'approve') {
      const pending = await this.prisma.orderItem.count({
        where: { orderId: order.id, customizationReviewStatus: { in: ['PENDING_REVIEW', 'NEEDS_CHANGES', 'REJECTED'] } },
      });
      if (pending === 0 && order.status === 'CUSTOMIZATION_REVIEW') {
        await this.orders.transition(order.id, 'CUSTOMIZATION_APPROVED', who, { note: 'all customizations approved' });
      }
    } else {
      // Needs changes / rejected: the order goes (back) to "review" until the customer fixes it or staff cancels.
      if (order.status === 'CUSTOMIZATION_APPROVED') await this.orders.transition(order.id, 'CUSTOMIZATION_REVIEW', who, { note: `item ${action}` });
      await notify('customization_changes');
    }
    return { ok: true, status };
  }
}
