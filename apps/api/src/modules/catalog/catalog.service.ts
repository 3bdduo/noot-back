import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Locale } from '@nb/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { env } from '../../config/env.js';
import { AppError } from '../../common/errors/app-error.js';
import { normalizeSearch } from '../../common/utils/normalize.js';
import { pickTranslation } from '../../common/utils/translate.js';
import { skipTake, toPage } from '../../common/utils/pagination.js';
import type { Actor } from '../../common/types.js';
import { CustomizationService } from '../customization/customization.service.js';
import { buildSnapshot } from '../customization/customization.engine.js';
import { isPurchasable, publicRemaining } from '../inventory/inventory.logic.js';
import { lineUnitPrice } from '../pricing/pricing.js';
import type { ListProductsQuery } from './catalog.schemas.js';
import type { CustomizationInput } from '@nb/shared';

const VARIANT_WHERE = { isActive: true, deletedAt: null } satisfies Prisma.ProductVariantWhereInput;

export const CARD_INCLUDE = {
  translations: true,
  media: { orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }], take: 2 },
  variants: { where: VARIANT_WHERE, orderBy: { sortOrder: 'asc' }, include: { inventory: true } },
} satisfies Prisma.ProductInclude;

const DETAIL_INCLUDE = {
  translations: true,
  media: { orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }] },
  variants: { where: VARIANT_WHERE, orderBy: { sortOrder: 'asc' }, include: { inventory: true, translations: true } },
  categories: { include: { category: { include: { translations: true } } } },
  collections: { include: { collection: { include: { translations: true } } } },
} satisfies Prisma.ProductInclude;

type CardRow = Prisma.ProductGetPayload<{ include: typeof CARD_INCLUDE }>;
type DetailRow = Prisma.ProductGetPayload<{ include: typeof DETAIL_INCLUDE }>;

const publicUrl = (path: string) => `${env.APP_URL.replace(/\/$/, '')}${path}`;

@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customization: CustomizationService,
  ) {}

  // ---------------------------------------------------------------- listing

  async listProducts(query: ListProductsQuery, locale: Locale) {
    const and: Prisma.ProductWhereInput[] = [{ status: 'ACTIVE', deletedAt: null }];

    if (query.q) {
      const words = normalizeSearch(query.q).split(' ').filter(Boolean).slice(0, 6);
      for (const w of words) and.push({ searchText: { contains: w } });
    }
    if (query.category) {
      const ids = await this.categoryIdsWithChildren(query.category);
      and.push({ categories: { some: { categoryId: { in: ids } } } });
    }
    if (query.collection) and.push({ collections: { some: { collection: { slug: query.collection, active: true, deletedAt: null } } } });
    if (query.minPrice !== undefined) and.push({ basePrice: { gte: query.minPrice } });
    if (query.maxPrice !== undefined) and.push({ basePrice: { lte: query.maxPrice } });
    if (query.color?.length) and.push({ variants: { some: { ...VARIANT_WHERE, color: { in: query.color } } } });
    if (query.material?.length) {
      and.push({ OR: [{ material: { in: query.material } }, { variants: { some: { ...VARIANT_WHERE, material: { in: query.material } } } }] });
    }
    if (query.featured !== undefined) and.push({ featured: query.featured });
    if (query.gift !== undefined) and.push({ isGift: query.gift });
    if (query.customizable !== undefined) and.push({ isCustomizable: query.customizable });
    if (query.inStock) {
      // Approximation at DB level (quantity > 0); exact "quantity - reserved" is applied in the card DTO.
      and.push({
        variants: {
          some: { ...VARIANT_WHERE, OR: [{ inventory: null }, { inventory: { is: { OR: [{ trackInventory: false }, { allowBackorder: true }, { quantity: { gt: 0 } }] } } }] },
        },
      });
    }

    const where: Prisma.ProductWhereInput = { AND: and };
    const orderBy = this.orderByFor(query.sort);

    const [rows, total] = await Promise.all([
      this.prisma.product.findMany({ where, orderBy, ...skipTake(query), include: CARD_INCLUDE }),
      this.prisma.product.count({ where }),
    ]);
    return toPage(rows.map((r) => this.toCard(r, locale)), total, query);
  }

  private orderByFor(sort: ListProductsQuery['sort']): Prisma.ProductOrderByWithRelationInput[] {
    switch (sort) {
      case 'newest':
        return [{ createdAt: 'desc' }];
      case 'price_asc':
        return [{ basePrice: 'asc' }, { createdAt: 'desc' }];
      case 'price_desc':
        return [{ basePrice: 'desc' }, { createdAt: 'desc' }];
      case 'best_selling':
        return [{ salesCount: 'desc' }, { createdAt: 'desc' }];
      default:
        return [{ featured: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'desc' }];
    }
  }

  private async categoryIdsWithChildren(slug: string): Promise<string[]> {
    const category = await this.prisma.category.findFirst({
      where: { slug, active: true, deletedAt: null },
      select: { id: true, children: { where: { active: true, deletedAt: null }, select: { id: true } } },
    });
    if (!category) return ['__none__'];
    return [category.id, ...category.children.map((c) => c.id)];
  }

  toCard(p: CardRow, locale: Locale) {
    const tr = pickTranslation(p.translations, locale);
    const prices = p.variants.map((v) => p.basePrice + v.priceDelta);
    const price = prices.length ? Math.min(...prices) : p.basePrice;
    const inStock = p.variants.length > 0 && p.variants.some((v) => isPurchasable(v.inventory));
    const [primary, secondary] = p.media;
    return {
      id: p.id,
      slug: p.slug,
      name: tr?.name ?? p.slug,
      shortDescription: tr?.shortDescription ?? null,
      price,
      hasPriceRange: new Set(prices).size > 1,
      compareAtPrice: p.compareAtPrice,
      discountPercent: p.compareAtPrice && p.compareAtPrice > price ? Math.round(((p.compareAtPrice - price) / p.compareAtPrice) * 100) : null,
      currency: 'EGP',
      image: primary ? { url: primary.url, alt: primary.alt } : null,
      hoverImage: secondary ? { url: secondary.url, alt: secondary.alt } : null,
      rating: p.avgRating,
      reviewCount: p.reviewCount,
      inStock,
      isCustomizable: p.isCustomizable,
      isGift: p.isGift,
      featured: p.featured,
      colors: [...new Set(p.variants.map((v) => v.color).filter((c): c is string => Boolean(c)))],
    };
  }

  // ---------------------------------------------------------------- detail

  async getProduct(slug: string, locale: Locale) {
    const p = await this.prisma.product.findFirst({
      where: { slug, status: 'ACTIVE', deletedAt: null },
      include: DETAIL_INCLUDE,
    });
    if (!p) throw AppError.notFound('PRODUCT_NOT_FOUND');
    return this.toDetail(p, locale);
  }

  private async toDetail(p: DetailRow, locale: Locale) {
    const tr = pickTranslation(p.translations, locale);
    const name = tr?.name ?? p.slug;
    const variants = p.variants.map((v) => {
      const vtr = pickTranslation(v.translations, locale);
      return {
        id: v.id,
        sku: v.sku,
        name: vtr?.name || [v.size, v.color, v.material, v.paper].filter(Boolean).join(' / ') || v.sku,
        color: v.color,
        material: v.material,
        size: v.size,
        paper: v.paper,
        priceDelta: v.priceDelta,
        price: p.basePrice + v.priceDelta,
        isDefault: v.isDefault,
        available: isPurchasable(v.inventory),
        remaining: publicRemaining(v.inventory),
        mediaIds: [] as string[],
      };
    });
    const defaultVariant = variants.find((v) => v.isDefault) ?? variants[0];
    const price = defaultVariant ? defaultVariant.price : p.basePrice;
    const inStock = variants.some((v) => v.available);

    const media = p.media.map((m) => ({ id: m.id, type: m.type, url: m.url, alt: m.alt ?? name, isPrimary: m.isPrimary, variantId: m.variantId }));
    for (const v of variants) v.mediaIds = media.filter((m) => m.variantId === v.id).map((m) => m.id);

    const categories = p.categories.map((c) => {
      const ctr = pickTranslation(c.category.translations, locale);
      return { id: c.category.id, slug: c.category.slug, name: ctr?.name ?? c.category.slug };
    });
    const collections = p.collections.map((c) => {
      const ctr = pickTranslation(c.collection.translations, locale);
      return { id: c.collection.id, slug: c.collection.slug, name: ctr?.name ?? c.collection.slug };
    });

    const url = publicUrl(`/products/${p.slug}`);
    const description = tr?.seoDescription ?? tr?.shortDescription ?? tr?.description ?? '';
    const jsonLd: Record<string, unknown> = {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name,
      description,
      sku: p.sku ?? defaultVariant?.sku,
      image: media.filter((m) => m.type === 'IMAGE').map((m) => m.url),
      offers: {
        '@type': 'Offer',
        url,
        priceCurrency: 'EGP',
        price: (price / 100).toFixed(2),
        availability: inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      },
    };
    if (p.reviewCount > 0) jsonLd.aggregateRating = { '@type': 'AggregateRating', ratingValue: p.avgRating.toFixed(1), reviewCount: p.reviewCount };

    const firstCategory = categories[0];
    const breadcrumbs = [
      { name: locale === 'ar' ? 'الرئيسية' : 'Home', url: publicUrl('/') },
      { name: locale === 'ar' ? 'المتجر' : 'Shop', url: publicUrl('/shop') },
      ...(firstCategory ? [{ name: firstCategory.name, url: publicUrl(`/shop?category=${firstCategory.slug}`) }] : []),
      { name, url },
    ];
    const breadcrumbLd = {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: breadcrumbs.map((b, i) => ({ '@type': 'ListItem', position: i + 1, name: b.name, item: b.url })),
    };

    const customizer = p.isCustomizable ? await this.customization.publicConfig(p.id, locale) : null;
    const related = await this.related(p.id, categories.map((c) => c.id), locale);

    return {
      id: p.id,
      slug: p.slug,
      sku: p.sku,
      name,
      shortDescription: tr?.shortDescription ?? null,
      description: tr?.description ?? null,
      price,
      basePrice: p.basePrice,
      compareAtPrice: p.compareAtPrice,
      currency: 'EGP',
      inStock,
      isCustomizable: p.isCustomizable,
      isGift: p.isGift,
      leadTimeDays: p.leadTimeDays,
      material: p.material,
      rating: p.avgRating,
      reviewCount: p.reviewCount,
      variants,
      media,
      categories,
      collections,
      customizer,
      related,
      seo: {
        title: tr?.seoTitle ?? name,
        description,
        canonical: url,
        openGraph: { type: 'product', title: tr?.seoTitle ?? name, description, url, image: media[0]?.url ?? null },
        jsonLd,
        breadcrumbLd,
        breadcrumbs,
      },
    };
  }

  private async related(productId: string, categoryIds: string[], locale: Locale) {
    if (categoryIds.length === 0) return [];
    const rows = await this.prisma.product.findMany({
      where: { id: { not: productId }, status: 'ACTIVE', deletedAt: null, categories: { some: { categoryId: { in: categoryIds } } } },
      orderBy: [{ featured: 'desc' }, { salesCount: 'desc' }],
      take: 4,
      include: CARD_INCLUDE,
    });
    return rows.map((r) => this.toCard(r, locale));
  }

  // ---------------------------------------------------------------- taxonomy & filters

  async listCategories(locale: Locale) {
    const rows = await this.prisma.category.findMany({
      where: { active: true, deletedAt: null },
      orderBy: { sortOrder: 'asc' },
      include: { translations: true },
    });
    const dto = rows.map((c) => {
      const tr = pickTranslation(c.translations, locale);
      return { id: c.id, slug: c.slug, parentId: c.parentId, imageUrl: c.imageUrl, name: tr?.name ?? c.slug, description: tr?.description ?? null, children: [] as any[] };
    });
    const byId = new Map(dto.map((c) => [c.id, c]));
    const roots: typeof dto = [];
    for (const c of dto) {
      const parent = c.parentId ? byId.get(c.parentId) : undefined;
      if (parent) parent.children.push(c);
      else roots.push(c);
    }
    return roots;
  }

  async listCollections(locale: Locale, featuredOnly = false) {
    const rows = await this.prisma.collection.findMany({
      where: { active: true, deletedAt: null, featured: featuredOnly ? true : undefined },
      orderBy: { sortOrder: 'asc' },
      include: { translations: true, _count: { select: { products: true } } },
    });
    return rows.map((c) => {
      const tr = pickTranslation(c.translations, locale);
      return { id: c.id, slug: c.slug, imageUrl: c.imageUrl, featured: c.featured, name: tr?.name ?? c.slug, description: tr?.description ?? null, productCount: c._count.products };
    });
  }

  async getCollection(slug: string, locale: Locale) {
    const c = await this.prisma.collection.findFirst({
      where: { slug, active: true, deletedAt: null },
      include: { translations: true },
    });
    if (!c) throw AppError.notFound();
    const tr = pickTranslation(c.translations, locale);
    const name = tr?.name ?? c.slug;
    return {
      id: c.id,
      slug: c.slug,
      imageUrl: c.imageUrl,
      name,
      description: tr?.description ?? null,
      seo: { title: name, description: tr?.description ?? '', canonical: publicUrl(`/collections/${c.slug}`) },
    };
  }

  /** Data for the /shop filter sidebar: price range + the colors / materials that actually exist. */
  async shopFilters(locale: Locale) {
    const [agg, colors, materials, categories] = await Promise.all([
      this.prisma.product.aggregate({ where: { status: 'ACTIVE', deletedAt: null }, _min: { basePrice: true }, _max: { basePrice: true } }),
      this.prisma.productVariant.findMany({
        where: { ...VARIANT_WHERE, color: { not: null }, product: { status: 'ACTIVE', deletedAt: null } },
        distinct: ['color'],
        select: { color: true },
      }),
      this.prisma.productVariant.findMany({
        where: { ...VARIANT_WHERE, material: { not: null }, product: { status: 'ACTIVE', deletedAt: null } },
        distinct: ['material'],
        select: { material: true },
      }),
      this.listCategories(locale),
    ]);
    return {
      price: { min: agg._min.basePrice ?? 0, max: agg._max.basePrice ?? 0 },
      colors: colors.map((c) => c.color).filter(Boolean),
      materials: materials.map((m) => m.material).filter(Boolean),
      categories,
      sorts: ['featured', 'newest', 'price_asc', 'price_desc', 'best_selling'],
    };
  }

  // ---------------------------------------------------------------- live price quote for the customizer

  /**
   * Server-side price for a configuration. Never throws for invalid customization: the customizer
   * shows `issues` inline while the shopper is still choosing.
   */
  async quote(
    slug: string,
    body: { variantId?: string; quantity: number; customization?: CustomizationInput },
    actor: Actor,
  ) {
    const product = await this.prisma.product.findFirst({
      where: { slug, status: 'ACTIVE', deletedAt: null },
      include: { variants: { where: VARIANT_WHERE, orderBy: { sortOrder: 'asc' }, include: { inventory: true } } },
    });
    if (!product) throw AppError.notFound('PRODUCT_NOT_FOUND');

    const variant = body.variantId
      ? product.variants.find((v) => v.id === body.variantId)
      : (product.variants.find((v) => v.isDefault) ?? product.variants[0]);
    if (!variant) throw AppError.unprocessable('VARIANT_UNAVAILABLE');

    const { result } = await this.customization.evaluate(product.id, body.customization, actor);
    const unitPrice = lineUnitPrice(product.basePrice, variant.priceDelta, result.priceDelta);
    return {
      valid: result.ok && isPurchasable(variant.inventory, body.quantity),
      issues: result.issues,
      available: isPurchasable(variant.inventory, body.quantity),
      currency: 'EGP',
      quantity: body.quantity,
      unitPrice,
      lineTotal: unitPrice * body.quantity,
      breakdown: { base: product.basePrice, variant: variant.priceDelta, customization: result.priceDelta },
      selections: result.selections.map((s) => ({ stepKey: s.stepKey, groupCode: s.groupCode, optionCode: s.optionCode, priceDelta: s.priceDelta })),
      snapshotPreview: result.ok ? buildSnapshot(result).summary : null,
    };
  }
}
