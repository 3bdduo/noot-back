import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Tx } from '../../prisma/prisma.service.js';
import { AppError } from '../../common/errors/app-error.js';
import { skipTake, toPage } from '../../common/utils/pagination.js';
import type { Pagination } from '../../common/utils/pagination.js';
import { availableOf } from './inventory.logic.js';

/** What one order line consumes: its variant plus every chosen customization option that is stock-tracked. */
export interface StockNeedInput {
  variantId: string;
  optionIds: string[];
  quantity: number;
  /** Product name shown in the OUT_OF_STOCK message. */
  label: string;
}

export interface LowStockHit {
  sku: string | null;
  available: number;
}

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------- reservation lifecycle (all run inside the caller's transaction)

  /**
   * RESERVE: atomically holds stock for an order. Two shoppers can never both take the last unit
   * (no overselling): see `applyDelta` for how MongoDB transactions guarantee that.
   */
  async reserveForOrder(tx: Tx, orderId: string, lines: StockNeedInput[], expiresAt: Date | null): Promise<void> {
    const needs = await this.collectNeeds(tx, lines);
    if (needs.size === 0) return;

    // Free anything that expired on the items involved so abandoned checkouts never block real buyers.
    await this.releaseExpiredFor(tx, [...needs.keys()]);

    // Stable order keeps concurrent checkouts touching documents in the same sequence.
    for (const [itemId, need] of [...needs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const item = await this.applyDelta(tx, itemId, { reserved: need.quantity }, (cur) => {
        if (!cur.allowBackorder && cur.quantity - cur.reserved < need.quantity) throw AppError.conflict('OUT_OF_STOCK', { name: need.label });
      });
      await tx.inventoryReservation.create({ data: { orderId, inventoryItemId: itemId, quantity: need.quantity, status: 'ACTIVE', expiresAt } });
      await tx.inventoryMovement.create({
        data: { inventoryItemId: itemId, type: 'RESERVE', quantity: need.quantity, quantityAfter: item.quantity, reservedAfter: item.reserved, orderId },
      });
    }
  }

  /**
   * Applies a relative change to one stock document inside the caller's transaction.
   * MongoDB gives snapshot isolation inside a transaction and aborts the loser of two concurrent writes
   * to the same document (retried by `PrismaService.tx`), so read -> check -> write cannot oversell.
   * The write is also compare-and-set on the values that were read, as a second line of defence.
   * `reserved` never goes below zero.
   */
  private async applyDelta(
    tx: Tx,
    itemId: string,
    delta: { quantity?: number; reserved?: number },
    guard?: (cur: { quantity: number; reserved: number; allowBackorder: boolean }) => void,
  ): Promise<{ quantity: number; reserved: number }> {
    const cur = await tx.inventoryItem.findUnique({ where: { id: itemId }, select: { quantity: true, reserved: true, allowBackorder: true } });
    if (!cur) throw AppError.notFound();
    guard?.(cur);
    const next = { quantity: cur.quantity + (delta.quantity ?? 0), reserved: Math.max(cur.reserved + (delta.reserved ?? 0), 0) };
    const res = await tx.inventoryItem.updateMany({ where: { id: itemId, quantity: cur.quantity, reserved: cur.reserved }, data: next });
    if (res.count === 0) throw AppError.conflict('CONFLICT');
    return next;
  }

  /**
   * FINALIZE (order confirmed): converts the hold into a real deduction.
   * Throws RESERVATION_LOST when the hold expired meanwhile (caller cancels + refunds).
   */
  async finalizeForOrder(tx: Tx, orderId: string, actorId?: string | null): Promise<LowStockHit[]> {
    const reservations = await tx.inventoryReservation.findMany({ where: { orderId }, include: { inventoryItem: true } });
    if (reservations.some((r) => r.status === 'EXPIRED')) throw AppError.conflict('RESERVATION_LOST');

    const low: LowStockHit[] = [];
    for (const r of reservations.filter((x) => x.status === 'ACTIVE')) {
      await this.applyDelta(tx, r.inventoryItemId, { quantity: -r.quantity, reserved: -r.quantity });
      await tx.inventoryReservation.update({ where: { id: r.id }, data: { status: 'FINALIZED', finalizedAt: new Date() } });
      const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: r.inventoryItemId } });
      await tx.inventoryMovement.create({
        data: { inventoryItemId: item.id, type: 'OUT', quantity: r.quantity, quantityAfter: item.quantity, reservedAfter: item.reserved, orderId, actorId: actorId ?? null },
      });
      const available = availableOf(item);
      if (item.trackInventory && available <= item.lowStockThreshold) low.push({ sku: item.sku, available });
    }
    return low;
  }

  /**
   * RELEASE (order cancelled / expired): ACTIVE holds are freed; already FINALIZED stock is put back (restock).
   */
  async releaseForOrder(tx: Tx, orderId: string, reason: string, actorId?: string | null): Promise<void> {
    const reservations = await tx.inventoryReservation.findMany({ where: { orderId, status: { in: ['ACTIVE', 'FINALIZED'] } } });
    for (const r of reservations) {
      const item = await this.applyDelta(tx, r.inventoryItemId, r.status === 'ACTIVE' ? { reserved: -r.quantity } : { quantity: r.quantity });
      await tx.inventoryReservation.update({ where: { id: r.id }, data: { status: 'RELEASED', releasedAt: new Date() } });
      await tx.inventoryMovement.create({
        data: {
          inventoryItemId: r.inventoryItemId,
          type: r.status === 'ACTIVE' ? 'RELEASE' : 'IN',
          quantity: r.quantity,
          quantityAfter: item.quantity,
          reservedAfter: item.reserved,
          orderId,
          reason,
          actorId: actorId ?? null,
        },
      });
    }
  }

  /** Marks overdue ACTIVE holds as EXPIRED and frees their stock (only for the given items). */
  private async releaseExpiredFor(tx: Tx, itemIds: string[]): Promise<void> {
    const overdue = await tx.inventoryReservation.findMany({
      where: { inventoryItemId: { in: itemIds }, status: 'ACTIVE', expiresAt: { lt: new Date() } },
    });
    for (const r of overdue) {
      const item = await this.applyDelta(tx, r.inventoryItemId, { reserved: -r.quantity });
      await tx.inventoryReservation.update({ where: { id: r.id }, data: { status: 'EXPIRED', releasedAt: new Date() } });
      await tx.inventoryMovement.create({
        data: { inventoryItemId: r.inventoryItemId, type: 'RELEASE', quantity: r.quantity, quantityAfter: item.quantity, reservedAfter: item.reserved, orderId: r.orderId, reason: 'reservation expired' },
      });
    }
  }

  /** Cron entry point: frees every overdue hold (the unpaid orders themselves are cancelled by OrdersService). */
  async releaseAllExpired(limit = 500): Promise<number> {
    const ids = await this.prisma.inventoryReservation.findMany({
      where: { status: 'ACTIVE', expiresAt: { lt: new Date() } },
      select: { inventoryItemId: true },
      distinct: ['inventoryItemId'],
      take: limit,
    });
    if (ids.length === 0) return 0;
    await this.prisma.tx(async (tx) => this.releaseExpiredFor(tx, ids.map((i) => i.inventoryItemId)));
    return ids.length;
  }

  private async collectNeeds(tx: Tx, lines: StockNeedInput[]) {
    const variantIds = [...new Set(lines.map((l) => l.variantId))];
    const optionIds = [...new Set(lines.flatMap((l) => l.optionIds))];
    const items = await tx.inventoryItem.findMany({
      where: { OR: [{ variantId: { in: variantIds } }, ...(optionIds.length ? [{ optionId: { in: optionIds } }] : [])] },
      select: { id: true, variantId: true, optionId: true, trackInventory: true },
    });
    const byVariant = new Map(items.filter((i) => i.variantId).map((i) => [i.variantId as string, i]));
    const byOption = new Map(items.filter((i) => i.optionId).map((i) => [i.optionId as string, i]));

    const needs = new Map<string, { quantity: number; label: string }>();
    const add = (item: { id: string; trackInventory: boolean } | undefined, quantity: number, label: string) => {
      if (!item || !item.trackInventory) return;
      const cur = needs.get(item.id);
      needs.set(item.id, { quantity: (cur?.quantity ?? 0) + quantity, label });
    };
    for (const l of lines) {
      add(byVariant.get(l.variantId), l.quantity, l.label);
      for (const optionId of l.optionIds) add(byOption.get(optionId), l.quantity, l.label);
    }
    return needs;
  }

  // ---------------------------------------------------------------- admin

  async list(query: { q?: string; lowStock?: boolean; kind?: 'variant' | 'option' }, pagination: Pagination) {
    const where: Prisma.InventoryItemWhereInput = {
      ...(query.kind === 'variant' ? { variantId: { not: null } } : query.kind === 'option' ? { optionId: { not: null } } : {}),
      ...(query.q
        ? {
            OR: [
              { sku: { contains: query.q, mode: 'insensitive' } },
              { variant: { sku: { contains: query.q, mode: 'insensitive' } } },
              { variant: { product: { searchText: { contains: query.q.toLowerCase() } } } },
            ],
          }
        : {}),
    };
    // "low stock" compares two columns, which Prisma cannot express: filter after loading a bounded set.
    const take = query.lowStock ? 1000 : pagination.pageSize;
    const skip = query.lowStock ? 0 : (pagination.page - 1) * pagination.pageSize;
    const rows = await this.prisma.inventoryItem.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip,
      take,
      include: {
        variant: { select: { sku: true, color: true, size: true, product: { select: { id: true, slug: true, translations: { select: { locale: true, name: true } } } } } },
        option: { select: { code: true, group: { select: { code: true } }, translations: { select: { locale: true, name: true } } } },
      },
    });
    const mapped = rows.map((r) => ({
      id: r.id,
      kind: r.variantId ? 'variant' : 'option',
      sku: r.sku ?? r.variant?.sku ?? null,
      name: r.variant
        ? (r.variant.product.translations.find((t) => t.locale === 'ar') ?? r.variant.product.translations[0])?.name
        : (r.option?.translations.find((t) => t.locale === 'ar') ?? r.option?.translations[0])?.name,
      detail: r.variant ? [r.variant.size, r.variant.color].filter(Boolean).join(' / ') : r.option ? `${r.option.group.code}:${r.option.code}` : '',
      productId: r.variant?.product.id ?? null,
      quantity: r.quantity,
      reserved: r.reserved,
      available: availableOf(r),
      lowStockThreshold: r.lowStockThreshold,
      trackInventory: r.trackInventory,
      allowBackorder: r.allowBackorder,
      isLow: r.trackInventory && availableOf(r) <= r.lowStockThreshold,
      updatedAt: r.updatedAt,
    }));
    if (query.lowStock) {
      const low = mapped.filter((m) => m.isLow);
      const start = (pagination.page - 1) * pagination.pageSize;
      return toPage(low.slice(start, start + pagination.pageSize), low.length, pagination);
    }
    const total = await this.prisma.inventoryItem.count({ where });
    return toPage(mapped, total, pagination);
  }

  movements(itemId: string, pagination: Pagination) {
    return this.prisma.$transaction([
      this.prisma.inventoryMovement.findMany({ where: { inventoryItemId: itemId }, orderBy: { createdAt: 'desc' }, ...skipTake(pagination) }),
      this.prisma.inventoryMovement.count({ where: { inventoryItemId: itemId } }),
    ]).then(([items, total]) => toPage(items, total, pagination));
  }

  /** Create the stock record for a variant / option that does not have one yet. */
  async createItem(input: { variantId?: string; optionId?: string; quantity: number; lowStockThreshold?: number; trackInventory?: boolean; allowBackorder?: boolean }, actorId: string) {
    if (Boolean(input.variantId) === Boolean(input.optionId)) throw AppError.badRequest('VALIDATION_ERROR');
    const existing = await this.prisma.inventoryItem.findFirst({ where: input.variantId ? { variantId: input.variantId } : { optionId: input.optionId }, select: { id: true } });
    if (existing) throw AppError.conflict('CONFLICT');

    return this.prisma.$transaction(async (tx) => {
      const sku = input.variantId
        ? (await tx.productVariant.findUnique({ where: { id: input.variantId }, select: { sku: true } }))?.sku
        : (await tx.customizationOption.findUnique({ where: { id: input.optionId }, select: { sku: true } }))?.sku;
      const item = await tx.inventoryItem.create({
        data: {
          variantId: input.variantId,
          optionId: input.optionId,
          sku: sku ?? null,
          quantity: input.quantity,
          lowStockThreshold: input.lowStockThreshold ?? 5,
          trackInventory: input.trackInventory ?? true,
          allowBackorder: input.allowBackorder ?? false,
        },
      });
      if (input.quantity > 0) {
        await tx.inventoryMovement.create({ data: { inventoryItemId: item.id, type: 'IN', quantity: input.quantity, quantityAfter: input.quantity, reservedAfter: 0, reason: 'initial stock', actorId } });
      }
      return item;
    });
  }

  /** Manual stock change. SET = absolute count (stocktake), DELTA = relative (+restock / -damage). */
  async adjust(itemId: string, input: { mode: 'SET' | 'DELTA'; quantity: number; reason: string }, actorId: string) {
    return this.prisma.tx(async (tx) => {
      const row = await tx.inventoryItem.findUnique({ where: { id: itemId }, select: { quantity: true } });
      if (!row) throw AppError.notFound();
      const before = row.quantity;
      const target = input.mode === 'SET' ? input.quantity : before + input.quantity;
      if (target < 0) throw AppError.badRequest('INVALID_QUANTITY');
      const delta = target - before;

      await this.applyDelta(tx, itemId, { quantity: delta });
      const updated = await tx.inventoryItem.findUniqueOrThrow({ where: { id: itemId } });
      await tx.inventoryMovement.create({
        data: {
          inventoryItemId: itemId,
          type: input.mode === 'DELTA' && delta > 0 ? 'IN' : 'ADJUSTMENT',
          quantity: delta,
          quantityAfter: updated.quantity,
          reservedAfter: updated.reserved,
          reason: input.reason,
          actorId,
        },
      });
      return { ...updated, available: availableOf(updated) };
    });
  }

  async updateSettings(itemId: string, input: { lowStockThreshold?: number; trackInventory?: boolean; allowBackorder?: boolean }) {
    const exists = await this.prisma.inventoryItem.findUnique({ where: { id: itemId }, select: { id: true } });
    if (!exists) throw AppError.notFound();
    return this.prisma.inventoryItem.update({ where: { id: itemId }, data: input });
  }

  async subscribeBackInStock(slug: string, email: string, locale: 'ar' | 'en') {
    const product = await this.prisma.product.findFirst({ where: { slug, status: 'ACTIVE', deletedAt: null }, select: { id: true } });
    if (!product) throw AppError.notFound('PRODUCT_NOT_FOUND');
    await this.prisma.backInStockSubscription.upsert({
      where: { productId_email: { productId: product.id, email } },
      create: { productId: product.id, email, locale },
      update: { notifiedAt: null, locale },
    });
    return { ok: true };
  }
}
