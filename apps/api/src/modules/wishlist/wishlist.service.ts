import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CustomizationInput, Locale } from '@nb/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AppError } from '../../common/errors/app-error.js';
import type { Actor } from '../../common/types.js';
import { pickTranslation } from '../../common/utils/translate.js';
import { CartService } from '../cart/cart.service.js';
import { CustomizationService } from '../customization/customization.service.js';
import { isPurchasable } from '../inventory/inventory.logic.js';

const PRODUCT_INCLUDE = {
  translations: true,
  media: { orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }], take: 1 },
  variants: { where: { isActive: true, deletedAt: null }, orderBy: { sortOrder: 'asc' }, include: { inventory: true } },
} satisfies Prisma.ProductInclude;

@Injectable()
export class WishlistService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cart: CartService,
    private readonly customization: CustomizationService,
  ) {}

  // ---------------------------------------------------------------- wishlist

  async list(userId: string, locale: Locale) {
    const wl = await this.prisma.wishlist.findUnique({
      where: { userId },
      include: {
        items: {
          orderBy: { createdAt: 'desc' },
          include: { product: { include: PRODUCT_INCLUDE } },
        },
      },
    });
    const items = (wl?.items ?? [])
      .filter((i) => i.product.status === 'ACTIVE' && !i.product.deletedAt)
      .map((i) => {
        const p = i.product;
        const tr = pickTranslation(p.translations, locale);
        const prices = p.variants.map((v) => p.basePrice + v.priceDelta);
        return {
          productId: p.id,
          slug: p.slug,
          name: tr?.name ?? p.slug,
          image: p.media[0]?.url ?? null,
          price: prices.length ? Math.min(...prices) : p.basePrice,
          compareAtPrice: p.compareAtPrice,
          isCustomizable: p.isCustomizable,
          inStock: p.variants.some((v) => isPurchasable(v.inventory, 1)),
          addedAt: i.createdAt,
        };
      });
    return { items, count: items.length };
  }

  async add(userId: string, productId: string, locale: Locale) {
    const product = await this.prisma.product.findFirst({ where: { id: productId, status: 'ACTIVE', deletedAt: null }, select: { id: true } });
    if (!product) throw AppError.notFound('PRODUCT_NOT_FOUND');
    const wl = await this.prisma.wishlist.upsert({ where: { userId }, create: { userId }, update: {} });
    await this.prisma.wishlistItem.upsert({
      where: { wishlistId_productId: { wishlistId: wl.id, productId } },
      create: { wishlistId: wl.id, productId },
      update: {},
    });
    return this.list(userId, locale);
  }

  async remove(userId: string, productId: string, locale: Locale) {
    const wl = await this.prisma.wishlist.findUnique({ where: { userId } });
    if (wl) await this.prisma.wishlistItem.deleteMany({ where: { wishlistId: wl.id, productId } });
    return this.list(userId, locale);
  }

  /**
   * Moves a wishlist product to the cart. Products that need customization cannot be added blindly:
   * the shopper must go through the customizer first (`PRODUCT_NEEDS_CONFIGURATION`).
   */
  async moveToCart(actor: Actor, productId: string, locale: Locale) {
    if (!actor.userId) throw AppError.unauthorized();
    const { result } = await this.customization.evaluate(productId, [], actor);
    if (!result.ok) throw AppError.unprocessable('PRODUCT_NEEDS_CONFIGURATION');
    const view = await this.cart.addItem(actor, { productId, quantity: 1 }, locale);
    await this.remove(actor.userId, productId, locale);
    return view;
  }

  // ---------------------------------------------------------------- saved designs

  async listDesigns(userId: string, locale: Locale) {
    const rows = await this.prisma.savedDesign.findMany({
      where: { userId, product: { deletedAt: null } },
      orderBy: { updatedAt: 'desc' },
      include: { product: { include: { translations: true, media: { take: 1, orderBy: { sortOrder: 'asc' } } } } },
    });
    return rows.map((d) => ({
      id: d.id,
      name: d.name,
      productId: d.productId,
      slug: d.product.slug,
      productName: pickTranslation(d.product.translations, locale)?.name ?? d.product.slug,
      image: d.product.media[0]?.url ?? null,
      variantId: d.variantId,
      selections: d.selections,
      updatedAt: d.updatedAt,
    }));
  }

  async saveDesign(
    userId: string,
    input: { productId: string; variantId?: string; name: string; selections: CustomizationInput },
    actor: Actor,
    locale: Locale,
  ) {
    const product = await this.prisma.product.findFirst({ where: { id: input.productId, status: 'ACTIVE', deletedAt: null }, select: { id: true } });
    if (!product) throw AppError.notFound('PRODUCT_NOT_FOUND');
    // Drafts may be incomplete, but unknown groups/options are rejected so garbage never gets stored.
    const { result } = await this.customization.evaluate(product.id, input.selections, actor);
    const hardIssues = result.issues.filter((i) => !['CUSTOM_REQUIRED', 'CUSTOM_TEXT_REQUIRED', 'CUSTOM_FILE_REQUIRED', 'CUSTOM_TOO_FEW', 'CUSTOM_TEXT_TOO_SHORT'].includes(i.code));
    if (hardIssues.length) throw AppError.unprocessable('CUSTOMIZATION_INVALID', {}, hardIssues);

    const count = await this.prisma.savedDesign.count({ where: { userId } });
    if (count >= 50) throw AppError.unprocessable('SAVED_DESIGN_LIMIT', { max: 50 });

    await this.prisma.savedDesign.create({
      data: { userId, productId: product.id, variantId: input.variantId ?? null, name: input.name, selections: input.selections as Prisma.InputJsonValue },
    });
    return this.listDesigns(userId, locale);
  }

  async deleteDesign(userId: string, id: string, locale: Locale) {
    await this.prisma.savedDesign.deleteMany({ where: { id, userId } });
    return this.listDesigns(userId, locale);
  }

  async designToCart(actor: Actor, id: string, quantity: number, locale: Locale) {
    if (!actor.userId) throw AppError.unauthorized();
    const d = await this.prisma.savedDesign.findFirst({ where: { id, userId: actor.userId } });
    if (!d) throw AppError.notFound();
    return this.cart.addItem(
      actor,
      { productId: d.productId, variantId: d.variantId ?? undefined, quantity, customization: d.selections as unknown as CustomizationInput },
      locale,
    );
  }
}
