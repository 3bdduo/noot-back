import { Injectable } from '@nestjs/common';
import type { Locale } from '@nb/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { logEvent } from '../../common/logger.js';
import { pickTranslation } from '../../common/utils/translate.js';
import { env } from '../../config/env.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { isPurchasable } from '../inventory/inventory.logic.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { OrdersService } from '../orders/orders.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { UploadsService } from '../uploads/uploads.service.js';

type TaskResult = { ok: boolean; result?: unknown; error?: string; ms: number };

/**
 * Background work for a serverless host: there is no always-on worker, so one idempotent "tick" runs everything that
 * is due. Trigger it every few minutes from Vercel Cron (daily on Hobby) and/or a free external pinger (cron-job.org).
 * Every task is safe to run twice and bounded in size.
 */
@Injectable()
export class JobsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly orders: OrdersService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly uploads: UploadsService,
  ) {}

  async tick(): Promise<Record<string, TaskResult>> {
    const tasks: Array<[string, () => Promise<unknown>]> = [
      ['releaseExpiredReservations', () => this.inventory.releaseAllExpired()],
      ['expireUnpaidOrders', () => this.expireOrders()],
      ['retryEmails', () => this.notifications.processPending()],
      ['abandonedCarts', () => this.abandonedCarts()],
      ['backInStock', () => this.backInStock()],
      ['cleanupTokens', () => this.cleanupTokens()],
      ['cleanupUploads', () => this.uploads.cleanup()],
    ];
    const out: Record<string, TaskResult> = {};
    for (const [name, fn] of tasks) {
      const started = Date.now();
      try {
        out[name] = { ok: true, result: await fn(), ms: Date.now() - started };
      } catch (e) {
        out[name] = { ok: false, error: (e as Error).message, ms: Date.now() - started };
        logEvent('error', 'cron.task_failed', { task: name, message: (e as Error).message });
      }
    }
    logEvent('info', 'cron.tick', { tasks: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.ok])) });
    return out;
  }

  /** Unpaid online orders past the payment window and unconfirmed COD orders past the auto-cancel window. */
  private async expireOrders() {
    const due = await this.prisma.order.findMany({
      where: { status: { in: ['PENDING_PAYMENT', 'COD_PENDING'] }, reservationExpiresAt: { lt: new Date() } },
      select: { id: true, status: true },
      take: 100,
    });
    let cancelled = 0;
    for (const o of due) {
      try {
        await this.orders.transition(o.id, 'CANCELLED', { type: 'SYSTEM' }, { reason: o.status === 'PENDING_PAYMENT' ? 'payment_window_expired' : 'not_confirmed_in_time' });
        cancelled++;
      } catch (e) {
        logEvent('warn', 'cron.expire_order_skipped', { orderId: o.id, message: (e as Error).message });
      }
    }
    return { due: due.length, cancelled };
  }

  private async abandonedCarts() {
    const cfg = await this.settings.get('notifications');
    if (!cfg.abandonedCartEmails) return { skipped: 'disabled' };
    const before = new Date(Date.now() - cfg.abandonedCartAfterHours * 3_600_000);
    const carts = await this.prisma.cart.findMany({
      where: { userId: { not: null }, abandonedEmailSentAt: null, updatedAt: { lt: before, gt: new Date(Date.now() - 14 * 86_400_000) }, items: { some: { savedForLater: false } } },
      include: { user: { select: { id: true, email: true, firstName: true, locale: true, status: true, deletedAt: true } } },
      take: 50,
    });
    let sent = 0;
    for (const c of carts) {
      const u = c.user;
      // claim first, so a retry of the tick cannot double-send
      const claim = await this.prisma.cart.updateMany({ where: { id: c.id, abandonedEmailSentAt: null }, data: { abandonedEmailSentAt: new Date() } });
      if (claim.count === 0 || !u || u.status !== 'ACTIVE' || u.deletedAt) continue;
      await this.notifications.notify({ event: 'abandoned_cart', locale: u.locale as Locale, userId: u.id, email: u.email, data: { name: u.firstName } });
      sent++;
    }
    return { candidates: carts.length, sent };
  }

  private async backInStock() {
    const cfg = await this.settings.get('notifications');
    if (!cfg.backInStockEmails) return { skipped: 'disabled' };
    const subs = await this.prisma.backInStockSubscription.findMany({
      where: { notifiedAt: null },
      include: { product: { include: { translations: true, variants: { where: { isActive: true, deletedAt: null }, include: { inventory: true } } } } },
      take: 200,
    });
    let sent = 0;
    for (const s of subs) {
      const p = s.product;
      if (p.status !== 'ACTIVE' || p.deletedAt || !p.variants.some((v) => isPurchasable(v.inventory, 1))) continue;
      const claim = await this.prisma.backInStockSubscription.updateMany({ where: { id: s.id, notifiedAt: null }, data: { notifiedAt: new Date() } });
      if (claim.count === 0) continue;
      await this.notifications.notify({
        event: 'back_in_stock',
        locale: s.locale as Locale,
        email: s.email,
        data: { productName: pickTranslation(p.translations, s.locale as Locale)?.name ?? p.slug, productUrl: `${env.APP_URL.replace(/\/$/, '')}/products/${p.slug}` },
      });
      sent++;
    }
    return { waiting: subs.length, sent };
  }

  private async cleanupTokens() {
    const weekAgo = new Date(Date.now() - 7 * 86_400_000);
    const [rt, et, hooks] = await Promise.all([
      this.prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: weekAgo } } }),
      this.prisma.emailToken.deleteMany({ where: { expiresAt: { lt: weekAgo } } }),
      this.prisma.paymentWebhookEvent.deleteMany({ where: { receivedAt: { lt: new Date(Date.now() - 180 * 86_400_000) }, status: 'PROCESSED' } }),
    ]);
    return { refreshTokens: rt.count, emailTokens: et.count, webhookEvents: hooks.count };
  }
}
