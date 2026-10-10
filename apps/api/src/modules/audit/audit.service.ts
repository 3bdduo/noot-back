import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Db } from '../../prisma/prisma.service.js';
import { redact, logEvent } from '../../common/logger.js';
import { paginationSchema, skipTake, toPage } from '../../common/utils/pagination.js';
import type { Pagination } from '../../common/utils/pagination.js';

export interface AuditEntry {
  actorId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Never throws: auditing must not break the business operation (failures are logged). */
  async log(entry: AuditEntry, db: Db = this.prisma): Promise<void> {
    try {
      await db.auditLog.create({
        data: {
          actorId: entry.actorId ?? null,
          action: entry.action.slice(0, 200),
          entity: entry.entity.slice(0, 100),
          entityId: entry.entityId?.slice(0, 100) ?? null,
          ip: entry.ip?.slice(0, 64) ?? null,
          userAgent: entry.userAgent?.slice(0, 300) ?? null,
          metadata: entry.metadata ? (redact(entry.metadata) as Prisma.InputJsonValue) : undefined,
        },
      });
    } catch (err) {
      logEvent('error', 'audit.write_failed', { action: entry.action, message: (err as Error).message });
    }
  }

  async list(
    query: { actorId?: string; entity?: string; entityId?: string; action?: string; from?: Date; to?: Date },
    pagination: Pagination = paginationSchema.parse({}),
  ) {
    const where: Prisma.AuditLogWhereInput = {
      actorId: query.actorId,
      entity: query.entity,
      entityId: query.entityId,
      action: query.action ? { contains: query.action, mode: 'insensitive' } : undefined,
      createdAt: query.from || query.to ? { gte: query.from, lte: query.to } : undefined,
    };
    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...skipTake(pagination),
        include: { actor: { select: { id: true, email: true, firstName: true, lastName: true } } },
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return toPage(items, total, pagination);
  }
}
