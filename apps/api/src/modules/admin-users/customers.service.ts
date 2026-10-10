import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AppError } from '../../common/errors/app-error.js';
import { paginationSchema, skipTake, toPage } from '../../common/utils/pagination.js';
import type { Pagination } from '../../common/utils/pagination.js';

const REVENUE_STATUSES = [
  'PAYMENT_CONFIRMED', 'CUSTOMIZATION_REVIEW', 'CUSTOMIZATION_APPROVED', 'IN_PRODUCTION', 'QUALITY_CHECK',
  'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED',
] as const;

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: { search?: string; status?: 'ACTIVE' | 'SUSPENDED' }, pagination: Pagination = paginationSchema.parse({})) {
    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      roles: { some: { role: { key: 'customer' } } },
      status: query.status,
      ...(query.search
        ? {
            OR: [
              { email: { contains: query.search, mode: 'insensitive' } },
              { firstName: { contains: query.search, mode: 'insensitive' } },
              { lastName: { contains: query.search, mode: 'insensitive' } },
              { phone: { contains: query.search } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...skipTake(pagination),
        select: { id: true, email: true, firstName: true, lastName: true, phone: true, status: true, emailVerifiedAt: true, createdAt: true, lastLoginAt: true },
      }),
      this.prisma.user.count({ where }),
    ]);

    const ids = rows.map((r) => r.id);
    const stats = ids.length
      ? await this.prisma.order.groupBy({
          by: ['userId'],
          where: { userId: { in: ids }, status: { in: [...REVENUE_STATUSES] } },
          _count: { _all: true },
          _sum: { total: true },
        })
      : [];
    const byUser = new Map(stats.map((s) => [s.userId, s]));
    return toPage(
      rows.map((u) => ({
        ...u,
        ordersCount: byUser.get(u.id)?._count._all ?? 0,
        totalSpent: byUser.get(u.id)?._sum.total ?? 0,
      })),
      total,
      pagination,
    );
  }

  async detail(id: string) {
    const user = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true, email: true, firstName: true, lastName: true, phone: true, locale: true, status: true, emailVerifiedAt: true,
        marketingOptIn: true, createdAt: true, lastLoginAt: true,
        addresses: { where: { deletedAt: null } },
        orders: {
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: { id: true, orderNumber: true, status: true, paymentStatus: true, total: true, createdAt: true },
        },
      },
    });
    if (!user) throw AppError.notFound('USER_NOT_FOUND');
    return user;
  }

  async setStatus(id: string, status: 'ACTIVE' | 'SUSPENDED') {
    const user = await this.prisma.user.findFirst({ where: { id, deletedAt: null }, select: { id: true, roles: { select: { role: { select: { key: true } } } } } });
    if (!user) throw AppError.notFound('USER_NOT_FOUND');
    if (user.roles.some((r) => r.role.key !== 'customer')) throw AppError.forbidden(); // staff are managed under /admin/admins
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { status } });
      if (status === 'SUSPENDED') await tx.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    });
    return { ok: true };
  }
}
