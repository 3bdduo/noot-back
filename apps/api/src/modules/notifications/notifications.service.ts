import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Locale, PermissionKey } from '@nb/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Db } from '../../prisma/prisma.service.js';
import { logEvent, maskEmail } from '../../common/logger.js';
import { EmailProvider } from './email.provider.js';
import { renderMessage } from './email-templates.js';
import type { NotificationEvent, TemplateData } from './email-templates.js';
import { paginationSchema, skipTake, toPage } from '../../common/utils/pagination.js';
import type { Pagination } from '../../common/utils/pagination.js';

const MAX_ATTEMPTS = 5;

export interface NotifyInput {
  event: NotificationEvent;
  locale: Locale;
  data?: TemplateData;
  /** Signed-in recipient: also receives an in-app notification. */
  userId?: string | null;
  /** Email address for the EMAIL channel (guests have no userId). */
  email?: string | null;
  inApp?: boolean;
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailProvider,
  ) {}

  /**
   * Persists the notification(s) (outbox pattern). Safe to call inside a transaction by passing `db`.
   * Returns ids of EMAIL notifications; call `deliver(ids)` after the transaction commits.
   */
  async enqueue(input: NotifyInput, db: Db = this.prisma): Promise<string[]> {
    const msg = renderMessage(input.event, input.locale, input.data ?? {});
    const ids: string[] = [];

    if (input.email) {
      const row = await db.notification.create({
        data: {
          userId: input.userId ?? null,
          channel: 'EMAIL',
          event: input.event,
          title: msg.subject,
          body: msg.lines.slice(1).join('\n'),
          toAddress: input.email,
          locale: input.locale,
          data: (input.data ?? {}) as Prisma.InputJsonValue,
          status: 'PENDING',
        },
        select: { id: true },
      });
      ids.push(row.id);
    }

    if (input.userId && input.inApp !== false) {
      await db.notification.create({
        data: {
          userId: input.userId,
          channel: 'IN_APP',
          event: input.event,
          title: msg.subject,
          body: msg.lines.slice(1).join('\n'),
          locale: input.locale,
          data: (input.data ?? {}) as Prisma.InputJsonValue,
          status: 'SENT',
          sentAt: new Date(),
        },
      });
    }
    return ids;
  }

  /** Enqueue and immediately try to send (use outside of transactions). Never throws. */
  async notify(input: NotifyInput): Promise<void> {
    try {
      const ids = await this.enqueue(input);
      await this.deliver(ids);
    } catch (err) {
      logEvent('error', 'notification.notify_failed', { event: input.event, message: (err as Error).message });
    }
  }

  /** In-app notification for every user that holds the given permission (admin bell). */
  async notifyAdmins(permission: PermissionKey, event: NotificationEvent, data: TemplateData, db: Db = this.prisma): Promise<void> {
    try {
      const admins = await db.user.findMany({
        where: {
          deletedAt: null,
          status: 'ACTIVE',
          roles: { some: { role: { permissions: { some: { permission: { key: permission } } } } } },
        },
        select: { id: true, locale: true },
      });
      for (const admin of admins) {
        await this.enqueue({ event, locale: admin.locale, userId: admin.id, data, email: null }, db);
      }
    } catch (err) {
      logEvent('error', 'notification.admin_failed', { event, message: (err as Error).message });
    }
  }

  /** Sends pending EMAIL notifications by id. Failures stay PENDING and are retried by the cron tick. */
  async deliver(ids: string[]): Promise<void> {
    for (const id of ids) {
      const n = await this.prisma.notification.findUnique({ where: { id } });
      if (!n || n.status !== 'PENDING' || n.channel !== 'EMAIL' || !n.toAddress) continue;
      const msg = renderMessage(n.event as NotificationEvent, n.locale, (n.data as TemplateData) ?? {});
      try {
        await this.email.send({ to: n.toAddress, subject: msg.subject, html: msg.html, text: msg.text });
        await this.prisma.notification.update({ where: { id }, data: { status: 'SENT', sentAt: new Date(), attempts: n.attempts + 1, error: null } });
      } catch (err) {
        const attempts = n.attempts + 1;
        logEvent('warn', 'notification.email_failed', { id, event: n.event, to: maskEmail(n.toAddress), attempts, message: (err as Error).message });
        await this.prisma.notification.update({
          where: { id },
          data: { attempts, error: (err as Error).message.slice(0, 500), status: attempts >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING' },
        });
      }
    }
  }

  /** Cron: retry emails that failed or were never delivered (e.g. the process stopped after commit). */
  async processPending(limit = 50): Promise<number> {
    const rows = await this.prisma.notification.findMany({
      where: { channel: 'EMAIL', status: 'PENDING', attempts: { lt: MAX_ATTEMPTS }, createdAt: { lt: new Date(Date.now() - 60_000) } },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    await this.deliver(rows.map((r) => r.id));
    return rows.length;
  }

  async listForUser(userId: string, pagination: Pagination = paginationSchema.parse({})) {
    const where = { userId, channel: 'IN_APP' as const };
    const [items, total, unread] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...skipTake(pagination),
        select: { id: true, event: true, title: true, body: true, data: true, readAt: true, createdAt: true },
      }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { ...where, readAt: null } }),
    ]);
    return { ...toPage(items, total, pagination), unread };
  }

  async markRead(userId: string, ids?: string[]): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { userId, channel: 'IN_APP', readAt: null, ...(ids?.length ? { id: { in: ids } } : {}) },
      data: { readAt: new Date() },
    });
  }
}
