import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CustomizationInput, Locale } from '@nb/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Db } from '../../prisma/prisma.service.js';
import { AppError } from '../../common/errors/app-error.js';
import type { Actor } from '../../common/types.js';
import { pickTranslation } from '../../common/utils/translate.js';
import { CustomizationService } from '../customization/customization.service.js';
import { buildSnapshot } from '../customization/customization.engine.js';
import type { EvaluationResult, Issue } from '../customization/customization.engine.js';
import { CouponsService } from '../coupons/coupons.service.js';
import { ShippingService } from '../shipping/shipping.service.js';
import type { ResolvedShipping } from '../shipping/shipping.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { computeTotals, estimateDelivery, lineUnitPrice, subtotalOf } from '../pricing/pricing.js';
import type { CouponResult, PricedLine } from '../pricing/pricing.js';
import { availableOf, isPurchasable, publicRemaining } from '../inventory/inventory.logic.js';

export const MAX_LINE_QUANTITY = 50;

const ITEM_INCLUDE = {
  product: {
    include: {
      translations: true,
      media: { orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }], take: 1 },
    },
  },
  variant: { include: { translations: true, inventory: true } },
} satisfies Prisma.CartItemInclude;

type ItemRow = Prisma.CartItemGetPayload<{ include: typeof ITEM_INCLUDE }>;

export type CartLineStatus = 'OK' | 'INVALID_CUSTOMIZATION' | 'OUT_OF_STOCK' | 'UNAVAILABLE';

/** A cart row fully re-evaluated against the live catalogue, prices and stock. */
export interface EvaluatedLine {
  item: ItemRow;
  status: CartLineStatus;
  issues: Issue[];
  evaluation: EvaluationResult | null;
  unitPrice: number;
  collectionIds: string[];
}

export interface AddItemInput {
  productId: string;
  variantId?: string;
  quantity: number;
  customization?: CustomizationInput;
}

@Injectable()
export class CartService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customization: CustomizationService,
    private readonly coupons: CouponsService,
    private readonly shipping: ShippingService,
    private readonly settings: SettingsService,
  ) {}

  // ---------------------------------------------------------------- cart lookup

  private async findCart(actor: Actor, db: Db = this.prisma) {
    if (actor.userId) return db.cart.findUnique({ where: { userId: actor.userId } });
    if (actor.guestHash) return db.cart.findUnique({ where: { guestToken: actor.guestHash } });
    return null;
  }

  private async ensureCart(actor: Actor, db: Db = this.prisma) {
    if (actor.userId) {
      return db.cart.upsert({ where: { userId: actor.userId }, create: { userId: actor.userId }, update: {} });
    }
    if (actor.guestHash) {
      return db.cart.upsert({ where: { guestToken: actor.guestHash }, create: { guestToken: actor.guestHash }, update: {} });
    }
    throw AppError.badRequest('CART_SESSION_REQUIRED');
  }

  // ---------------------------------------------------------------- evaluation (shared with checkout)

  /** Re-prices and re-validates every row of the cart. Nothing from the client is trusted. */
  async evaluateItems(items: ItemRow[], actor: Actor, db: Db = this.prisma): Promise<EvaluatedLine[]> {
    const productIds = [...new Set(items.map((i) => i.productId))];
    const links = productIds.length
      ? await db.productCollection.findMany({ where: { productId: { in: productIds } }, select: { productId: true, collectionId: true } })
      : [];
    const collectionsOf = new Map<string, string[]>();
    for (const l of links) collectionsOf.set(l.productId, [...(collectionsOf.get(l.productId) ?? []), l.collectionId]);

    const out: EvaluatedLine[] = [];
    for (const item of items) {
      const base = { item, collectionIds: collectionsOf.get(item.productId) ?? [] };
      const { product, variant } = item;
      const sellable = product.status === 'ACTIVE' && !product.deletedAt && variant.isActive && !variant.deletedAt;
      if (!sellable) {
        out.push({ ...base, status: 'UNAVAILABLE', issues: [], evaluation: null, unitPrice: 0 });
        continue;
      }

      const { result } = await this.customization.evaluate(item.productId, item.customization as unknown as CustomizationInput | null, actor, db);
      const unitPrice = lineUnitPrice(product.basePrice, variant.priceDelta, result.priceDelta);
      let status: CartLineStatus = 'OK';
      if (!result.ok) status = 'INVALID_CUSTOMIZATION';
      else if (!isPurchasable(variant.inventory, item.quantity)) status = 'OUT_OF_STOCK';
      out.push({ ...base, status, issues: result.issues, evaluation: result, unitPrice });
    }
    return out;
  }

  static toPricedLines(lines: EvaluatedLine[]): PricedLine[] {
    return lines
      .filter((l) => l.status === 'OK' && !l.item.savedForLater)
      .map((l) => ({
        productId: l.item.productId,
        variantId: l.item.variantId,
        quantity: l.item.quantity,
        unitPrice: l.unitPrice,
        collectionIds: l.collectionIds,
      }));
  }

  loadItems(cartId: string, db: Db = this.prisma): Promise<ItemRow[]> {
    return db.cartItem.findMany({ where: { cartId }, orderBy: { createdAt: 'asc' }, include: ITEM_INCLUDE });
  }

  // ---------------------------------------------------------------- view

  async view(actor: Actor, locale: Locale, opts: { governorate?: string } = {}) {
    const cart = await this.findCart(actor);
    if (!cart) return this.emptyView();

    const [rows, tax, cod] = await Promise.all([this.loadItems(cart.id), this.settings.get('tax'), this.settings.get('cod')]);
    const lines = await this.evaluateItems(rows, actor);
    const priced = CartService.toPricedLines(lines);
    const subtotal = subtotalOf(priced);

    // Coupon: re-validated on every view; a code that stopped being valid is reported, not silently kept.
    let discount = 0;
    let couponInfo: { code: string; discount: number } | null = null;
    let couponError: { code: string; params?: Record<string, unknown> } | null = null;
    if (cart.couponCode) {
      const res = await this.tryCoupon(cart.couponCode, priced, actor);
      if (res.ok) {
        discount = res.discount;
        couponInfo = { code: cart.couponCode, discount };
      } else if (res.ok === false) {
        couponError = { code: res.code, params: res.params };
      }
    }

    let shipping: ResolvedShipping | null = null;
    if (opts.governorate && priced.length > 0) {
      shipping = await this.shipping.resolve(opts.governorate, Math.max(0, subtotal - discount)).catch(() => null);
    }

    const totals = computeTotals({
      subtotal,
      discount,
      shippingFee: shipping?.fee ?? 0,
      codFee: 0,
      tax: { enabled: tax.enabled, rateBps: tax.rateBps, inclusive: tax.inclusive },
    });

    const leadTimeDays = lines
      .filter((l) => l.status === 'OK' && !l.item.savedForLater)
      .reduce((max, l) => Math.max(max, l.item.product.leadTimeDays), 0);
    const estimatedDelivery = shipping ? estimateDelivery(new Date(), leadTimeDays, shipping.estimatedDaysMax) : null;

    const gift = await this.prisma.giftMessage.findUnique({ where: { cartId: cart.id } });
    const views = lines.map((l) => this.lineView(l, locale));

    return {
      currency: 'EGP',
      items: views.filter((v) => !v.savedForLater),
      savedForLater: views.filter((v) => v.savedForLater),
      itemCount: priced.reduce((n, l) => n + l.quantity, 0),
      hasBlockingIssues: lines.some((l) => !l.item.savedForLater && l.status !== 'OK'),
      coupon: couponInfo,
      couponError,
      shipping: shipping
        ? {
            fee: shipping.fee,
            rateName: shipping.rateName,
            codAvailable: shipping.codAvailable,
            estimatedDaysMin: shipping.estimatedDaysMin,
            estimatedDaysMax: shipping.estimatedDaysMax,
            remainingForFreeShipping:
              shipping.freeOverSubtotal !== null && subtotal - discount < shipping.freeOverSubtotal
                ? shipping.freeOverSubtotal - (subtotal - discount)
                : 0,
          }
        : null,
      estimatedDelivery,
      leadTimeDays,
      codFee: cod.enabled ? cod.fee : null,
      totals,
      gift: gift
        ? { recipientName: gift.recipientName, senderName: gift.senderName, message: gift.message, hidePrices: gift.hidePrices }
        : null,
    };
  }

  private emptyView() {
    return {
      currency: 'EGP',
      items: [],
      savedForLater: [],
      itemCount: 0,
      hasBlockingIssues: false,
      coupon: null,
      couponError: null,
      shipping: null,
      estimatedDelivery: null,
      leadTimeDays: 0,
      codFee: null,
      totals: computeTotals({ subtotal: 0, discount: 0, shippingFee: 0, codFee: 0, tax: { enabled: false, rateBps: 0, inclusive: false } }),
      gift: null,
    };
  }

  private lineView(l: EvaluatedLine, locale: Locale) {
    const { item } = l;
    const pTr = pickTranslation(item.product.translations, locale);
    const vTr = pickTranslation(item.variant.translations, locale);
    const inv = item.variant.inventory;
    return {
      id: item.id,
      productId: item.productId,
      variantId: item.variantId,
      slug: item.product.slug,
      name: pTr?.name ?? item.product.slug,
      variantName: vTr?.name ?? null,
      variant: { color: item.variant.color, size: item.variant.size, paper: item.variant.paper, material: item.variant.material },
      image: item.product.media[0]?.url ?? null,
      quantity: item.quantity,
      unitPrice: l.unitPrice,
      lineTotal: l.unitPrice * item.quantity,
      savedForLater: item.savedForLater,
      status: l.status,
      issues: l.issues,
      customization: l.evaluation?.ok ? buildSnapshot(l.evaluation).summary : null,
      customizationInput: item.customization,
      inStock: isPurchasable(inv, item.quantity),
      remaining: publicRemaining(inv),
      leadTimeDays: item.product.leadTimeDays,
    };
  }

  private async tryCoupon(code: string, lines: PricedLine[], actor: Actor): Promise<CouponResult> {
    if (lines.length === 0) return { ok: false, code: 'COUPON_INVALID' };
    try {
      const { result } = await this.coupons.evaluate(code, lines, { userId: actor.userId });
      return result;
    } catch (e) {
      if (e instanceof AppError) return { ok: false, code: e.code };
      throw e;
    }
  }

  // ---------------------------------------------------------------- items

  async addItem(actor: Actor, input: AddItemInput, locale: Locale) {
    const product = await this.prisma.product.findFirst({
      where: { id: input.productId, status: 'ACTIVE', deletedAt: null },
      include: { variants: { where: { isActive: true, deletedAt: null }, orderBy: { sortOrder: 'asc' }, include: { inventory: true } } },
    });
    if (!product) throw AppError.notFound('PRODUCT_NOT_FOUND');

    const variant = input.variantId
      ? product.variants.find((v) => v.id === input.variantId)
      : (product.variants.find((v) => v.isDefault) ?? product.variants[0]);
    if (!variant) throw AppError.unprocessable('VARIANT_UNAVAILABLE');

    // Files must belong to this shopper; the engine checks ownership through `actor`.
    const { result } = await this.customization.evaluate(product.id, input.customization, actor);
    this.customization.assertValid(result);

    const cart = await this.ensureCart(actor);
    const key = { cartId: cart.id, variantId: variant.id, configHash: result.configHash, savedForLater: false };
    const existing = await this.prisma.cartItem.findUnique({ where: { cartId_variantId_configHash_savedForLater: key } });
    const nextQty = (existing?.quantity ?? 0) + input.quantity;

    if (nextQty > MAX_LINE_QUANTITY) throw AppError.unprocessable('QUANTITY_LIMIT', { max: MAX_LINE_QUANTITY });
    if (!isPurchasable(variant.inventory, nextQty)) {
      throw AppError.unprocessable('OUT_OF_STOCK', { available: Math.max(0, variant.inventory ? availableOf(variant.inventory) : 0) });
    }

    if (existing) {
      await this.prisma.cartItem.update({ where: { id: existing.id }, data: { quantity: nextQty } });
    } else {
      await this.prisma.cartItem.create({
        data: {
          cartId: cart.id,
          productId: product.id,
          variantId: variant.id,
          quantity: input.quantity,
          configHash: result.configHash,
          customization: input.customization?.length ? (input.customization as Prisma.InputJsonValue) : null,
        },
      });
    }
    await this.touch(cart.id);
    return this.view(actor, locale);
  }

  async updateItem(actor: Actor, itemId: string, patch: { quantity?: number; savedForLater?: boolean }, locale: Locale) {
    const cart = await this.findCart(actor);
    if (!cart) throw AppError.notFound('CART_ITEM_NOT_FOUND');
    const item = await this.prisma.cartItem.findFirst({ where: { id: itemId, cartId: cart.id }, include: { variant: { include: { inventory: true } } } });
    if (!item) throw AppError.notFound('CART_ITEM_NOT_FOUND');

    let quantity = patch.quantity ?? item.quantity;
    if (quantity > MAX_LINE_QUANTITY) throw AppError.unprocessable('QUANTITY_LIMIT', { max: MAX_LINE_QUANTITY });
    const target = patch.savedForLater ?? item.savedForLater;

    if (!target && !isPurchasable(item.variant.inventory, quantity)) {
      throw AppError.unprocessable('OUT_OF_STOCK', { available: item.variant.inventory ? Math.max(0, availableOf(item.variant.inventory)) : 0 });
    }

    // Moving between "cart" and "saved" may collide with an identical row there: merge them.
    const twin =
      target !== item.savedForLater
        ? await this.prisma.cartItem.findUnique({
            where: { cartId_variantId_configHash_savedForLater: { cartId: cart.id, variantId: item.variantId, configHash: item.configHash, savedForLater: target } },
          })
        : null;

    await this.prisma.$transaction(async (tx) => {
      if (twin) {
        quantity = Math.min(MAX_LINE_QUANTITY, twin.quantity + quantity);
        await tx.cartItem.update({ where: { id: twin.id }, data: { quantity } });
        await tx.cartItem.delete({ where: { id: item.id } });
      } else {
        await tx.cartItem.update({ where: { id: item.id }, data: { quantity, savedForLater: target } });
      }
    });
    await this.touch(cart.id);
    return this.view(actor, locale);
  }

  async removeItem(actor: Actor, itemId: string, locale: Locale) {
    const cart = await this.findCart(actor);
    if (cart) {
      await this.prisma.cartItem.deleteMany({ where: { id: itemId, cartId: cart.id } });
      await this.touch(cart.id);
    }
    return this.view(actor, locale);
  }

  async clear(actor: Actor, locale: Locale) {
    const cart = await this.findCart(actor);
    if (cart) {
      await this.prisma.$transaction([
        this.prisma.cartItem.deleteMany({ where: { cartId: cart.id } }),
        this.prisma.giftMessage.deleteMany({ where: { cartId: cart.id } }),
        this.prisma.cart.update({ where: { id: cart.id }, data: { couponCode: null, abandonedEmailSentAt: null } }),
      ]);
    }
    return this.view(actor, locale);
  }

  // ---------------------------------------------------------------- coupon

  async applyCoupon(actor: Actor, code: string, locale: Locale) {
    const cart = await this.findCart(actor);
    if (!cart) throw AppError.unprocessable('CART_EMPTY');
    const rows = await this.loadItems(cart.id);
    const priced = CartService.toPricedLines(await this.evaluateItems(rows, actor));
    if (priced.length === 0) throw AppError.unprocessable('CART_EMPTY');

    const { coupon, result } = await this.coupons.evaluate(code, priced, { userId: actor.userId });
    if (result.ok === false) throw AppError.unprocessable(result.code, result.params);

    await this.prisma.cart.update({ where: { id: cart.id }, data: { couponCode: coupon.code } });
    return this.view(actor, locale);
  }

  async removeCoupon(actor: Actor, locale: Locale) {
    const cart = await this.findCart(actor);
    if (cart) await this.prisma.cart.update({ where: { id: cart.id }, data: { couponCode: null } });
    return this.view(actor, locale);
  }

  // ---------------------------------------------------------------- gift message

  async setGift(
    actor: Actor,
    gift: { recipientName?: string; senderName?: string; message: string; hidePrices?: boolean },
    locale: Locale,
  ) {
    const cart = await this.ensureCart(actor);
    const data = {
      recipientName: gift.recipientName ?? null,
      senderName: gift.senderName ?? null,
      message: gift.message,
      hidePrices: gift.hidePrices ?? false,
    };
    await this.prisma.giftMessage.upsert({ where: { cartId: cart.id }, create: { cartId: cart.id, ...data }, update: data });
    await this.touch(cart.id);
    return this.view(actor, locale);
  }

  async removeGift(actor: Actor, locale: Locale) {
    const cart = await this.findCart(actor);
    if (cart) await this.prisma.giftMessage.deleteMany({ where: { cartId: cart.id } });
    return this.view(actor, locale);
  }

  // ---------------------------------------------------------------- guest -> user merge

  /**
   * Called right after sign-in. Guest rows are folded into the user's cart (quantities add up, capped),
   * the guest's uploaded artwork is handed to the user, and the guest cart is deleted.
   */
  async mergeGuestCart(userId: string, guestHash: string | null, locale: Locale) {
    const actor: Actor = { userId, guestHash };
    if (guestHash) {
      const guest = await this.prisma.cart.findUnique({ where: { guestToken: guestHash }, include: { items: true, gift: true } });
      if (guest && guest.items.length + (guest.gift ? 1 : 0) > 0) {
        await this.prisma.$transaction(async (tx) => {
          const mine = await tx.cart.upsert({ where: { userId }, create: { userId }, update: {} });
          for (const it of guest.items) {
            const key = { cartId: mine.id, variantId: it.variantId, configHash: it.configHash, savedForLater: it.savedForLater };
            const twin = await tx.cartItem.findUnique({ where: { cartId_variantId_configHash_savedForLater: key } });
            if (twin) {
              await tx.cartItem.update({ where: { id: twin.id }, data: { quantity: Math.min(MAX_LINE_QUANTITY, twin.quantity + it.quantity) } });
            } else {
              await tx.cartItem.create({
                data: {
                  cartId: mine.id,
                  productId: it.productId,
                  variantId: it.variantId,
                  quantity: it.quantity,
                  configHash: it.configHash,
                  savedForLater: it.savedForLater,
                  customization: it.customization === null ? null : (it.customization as Prisma.InputJsonValue),
                },
              });
            }
          }
          if (guest.couponCode && !mine.couponCode) await tx.cart.update({ where: { id: mine.id }, data: { couponCode: guest.couponCode } });
          if (guest.gift) {
            const g = { recipientName: guest.gift.recipientName, senderName: guest.gift.senderName, message: guest.gift.message, hidePrices: guest.gift.hidePrices };
            await tx.giftMessage.upsert({ where: { cartId: mine.id }, create: { cartId: mine.id, ...g }, update: {} });
          }
          // Uploaded artwork now belongs to the account (ownership checks keep working after the merge).
          await tx.artworkFile.updateMany({ where: { guestToken: guestHash, userId: null }, data: { userId } });
          await tx.cart.delete({ where: { id: guest.id } });
        });
      }
    }
    return this.view(actor, locale);
  }

  // ---------------------------------------------------------------- used by checkout

  /** Loads the cart for checkout (no side effects). Returns null for guests without a cart. */
  getCartForCheckout(actor: Actor, db: Db = this.prisma) {
    return this.findCart(actor, db);
  }

  /** Empties the purchased rows after an order has been placed (rows saved for later survive). */
  async clearPurchased(cartId: string, db: Db = this.prisma) {
    await db.cartItem.deleteMany({ where: { cartId, savedForLater: false } });
    await db.giftMessage.deleteMany({ where: { cartId } });
    await db.cart.update({ where: { id: cartId }, data: { couponCode: null, abandonedEmailSentAt: null } });
  }

  private async touch(cartId: string) {
    // `updatedAt` drives the abandoned-cart job; a new change re-arms the reminder.
    await this.prisma.cart.update({ where: { id: cartId }, data: { abandonedEmailSentAt: null } });
  }
}
