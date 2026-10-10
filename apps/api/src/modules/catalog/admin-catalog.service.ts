import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Tx } from '../../prisma/prisma.service.js';
import { AppError } from '../../common/errors/app-error.js';
import { normalizeSearch, slugify } from '../../common/utils/normalize.js';
import { skipTake, toPage } from '../../common/utils/pagination.js';
import type { Pagination } from '../../common/utils/pagination.js';
import { availableOf } from '../inventory/inventory.logic.js';
import type { CreateProductInput, UpdateProductInput } from './catalog.schemas.js';
import type { z } from 'zod';
import type { categoryInputSchema, collectionInputSchema, updateCategorySchema, updateCollectionSchema } from './catalog.schemas.js';

type CategoryInput = z.infer<typeof categoryInputSchema>;
type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
type CollectionInput = z.infer<typeof collectionInputSchema>;
type UpdateCollectionInput = z.infer<typeof updateCollectionSchema>;

export function buildSearchText(parts: {
  translations: Array<{ name: string; shortDescription?: string | null }>;
  sku?: string | null;
  material?: string | null;
  variantSkus?: string[];
  categoryNames?: string[];
}): string {
  const bag = [
    ...parts.translations.flatMap((t) => [t.name, t.shortDescription ?? '']),
    parts.sku ?? '',
    parts.material ?? '',
    ...(parts.variantSkus ?? []),
    ...(parts.categoryNames ?? []),
  ];
  return normalizeSearch(bag.join(' ')).slice(0, 2000);
}

@Injectable()
export class AdminCatalogService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------- products

  async listProducts(
    query: { q?: string; status?: 'DRAFT' | 'ACTIVE' | 'ARCHIVED'; category?: string; includeArchived?: boolean },
    pagination: Pagination,
  ) {
    const where: Prisma.ProductWhereInput = {
      deletedAt: null,
      status: query.status ?? (query.includeArchived ? undefined : { not: 'ARCHIVED' }),
      ...(query.category ? { categories: { some: { categoryId: query.category } } } : {}),
      ...(query.q
        ? {
            OR: [
              { searchText: { contains: normalizeSearch(query.q) } },
              { sku: { contains: query.q, mode: 'insensitive' } },
              { variants: { some: { sku: { contains: query.q, mode: 'insensitive' } } } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        ...skipTake(pagination),
        include: {
          translations: true,
          media: { orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }], take: 1 },
          variants: { where: { deletedAt: null }, include: { inventory: true } },
        },
      }),
      this.prisma.product.count({ where }),
    ]);
    return toPage(
      rows.map((p) => {
        const tr = p.translations.find((t) => t.locale === 'ar') ?? p.translations[0];
        const tracked = p.variants.filter((v) => v.inventory?.trackInventory);
        return {
          id: p.id,
          slug: p.slug,
          sku: p.sku,
          name: tr?.name ?? p.slug,
          status: p.status,
          basePrice: p.basePrice,
          isCustomizable: p.isCustomizable,
          featured: p.featured,
          image: p.media[0]?.url ?? null,
          variantsCount: p.variants.length,
          stockAvailable: tracked.reduce((s, v) => s + availableOf(v.inventory!), 0),
          updatedAt: p.updatedAt,
        };
      }),
      total,
      pagination,
    );
  }

  async getProduct(id: string) {
    const p = await this.prisma.product.findFirst({
      where: { id, deletedAt: null },
      include: {
        translations: true,
        variants: { where: { deletedAt: null }, orderBy: { sortOrder: 'asc' }, include: { translations: true, inventory: true } },
        media: { orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }] },
        categories: true,
        collections: true,
        customizations: { orderBy: { sortOrder: 'asc' }, include: { group: { include: { translations: true } } } },
      },
    });
    if (!p) throw AppError.notFound('PRODUCT_NOT_FOUND');
    return p;
  }

  async createProduct(input: CreateProductInput, actorId: string) {
    const variants = this.normalizeVariants(input.variants);
    await this.assertSkusFree(input.sku, variants.map((v) => v.sku));
    const slug = await this.resolveSlug(input.slug, input.translations);
    await this.assertRefs(input.categoryIds, input.collectionIds);
    const categoryNames = await this.categoryNames(input.categoryIds ?? []);

    const productId = await this.prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: {
          slug,
          sku: input.sku ?? null,
          status: input.status ?? 'DRAFT',
          basePrice: input.basePrice,
          compareAtPrice: input.compareAtPrice ?? null,
          isGift: input.isGift ?? false,
          featured: input.featured ?? false,
          leadTimeDays: input.leadTimeDays ?? 0,
          material: input.material ?? null,
          sortOrder: input.sortOrder ?? 0,
          publishedAt: input.status === 'ACTIVE' ? new Date() : null,
          searchText: buildSearchText({
            translations: input.translations,
            sku: input.sku,
            material: input.material,
            variantSkus: variants.map((v) => v.sku),
            categoryNames,
          }),
          translations: { create: input.translations },
          variants: {
            create: variants.map((v, i) => ({
              sku: v.sku,
              color: v.color ?? null,
              material: v.material ?? null,
              size: v.size ?? null,
              paper: v.paper ?? null,
              priceDelta: v.priceDelta ?? 0,
              isDefault: v.isDefault ?? false,
              isActive: v.isActive ?? true,
              sortOrder: v.sortOrder ?? i,
              translations: v.translations?.length ? { create: v.translations } : undefined,
            })),
          },
        },
        include: { variants: { select: { id: true, sku: true } } },
      });

      for (const v of variants) {
        if (!v.stock) continue;
        const created = product.variants.find((x) => x.sku === v.sku)!;
        await this.createInitialStock(tx, created.id, v.sku, v.stock, actorId);
      }
      await this.syncMedia(tx, product.id, input.media, product.variants);
      await this.syncLinks(tx, product.id, input.categoryIds, input.collectionIds);
      return product.id;
    });
    return this.getProduct(productId);
  }

  async updateProduct(id: string, input: UpdateProductInput, actorId: string) {
    const existing = await this.getProduct(id);
    const variants = input.variants ? this.normalizeVariants(input.variants) : undefined;
    if (variants) {
      const ownSkus = new Set(existing.variants.map((v) => v.sku));
      await this.assertSkusFree(input.sku ?? undefined, variants.filter((v) => !v.id || !ownSkus.has(v.sku)).map((v) => v.sku), id);
    } else if (input.sku) {
      await this.assertSkusFree(input.sku, [], id);
    }
    if (input.slug && input.slug !== existing.slug) {
      const taken = await this.prisma.product.findFirst({ where: { slug: input.slug, id: { not: id } }, select: { id: true } });
      if (taken) throw AppError.conflict('SLUG_TAKEN');
    }
    await this.assertRefs(input.categoryIds, input.collectionIds);

    await this.prisma.$transaction(async (tx) => {
      const becomesActive = input.status === 'ACTIVE' && existing.status !== 'ACTIVE';
      await tx.product.update({
        where: { id },
        data: {
          slug: input.slug,
          sku: input.sku,
          status: input.status,
          basePrice: input.basePrice,
          compareAtPrice: input.compareAtPrice,
          isGift: input.isGift,
          featured: input.featured,
          leadTimeDays: input.leadTimeDays,
          material: input.material,
          sortOrder: input.sortOrder,
          publishedAt: becomesActive && !existing.publishedAt ? new Date() : undefined,
        },
      });

      for (const t of input.translations ?? []) {
        await tx.productTranslation.upsert({
          where: { productId_locale: { productId: id, locale: t.locale } },
          create: { productId: id, ...t },
          update: t,
        });
      }

      let variantRows: Array<{ id: string; sku: string }> = existing.variants.map((v) => ({ id: v.id, sku: v.sku }));
      if (variants) variantRows = await this.syncVariants(tx, id, existing.variants.map((v) => v.id), variants, actorId);
      await this.syncMedia(tx, id, input.media, variantRows);
      await this.syncLinks(tx, id, input.categoryIds, input.collectionIds, true);

      // refresh the search index text from the final state
      const fresh = await tx.product.findUniqueOrThrow({
        where: { id },
        include: {
          translations: true,
          variants: { where: { deletedAt: null }, select: { sku: true } },
          categories: { include: { category: { include: { translations: true } } } },
        },
      });
      await tx.product.update({
        where: { id },
        data: {
          searchText: buildSearchText({
            translations: fresh.translations,
            sku: fresh.sku,
            material: fresh.material,
            variantSkus: fresh.variants.map((v) => v.sku),
            categoryNames: fresh.categories.flatMap((c) => c.category.translations.map((t) => t.name)),
          }),
        },
      });
    });
    return this.getProduct(id);
  }

  /** "Delete" = archive. Orders keep their snapshots; the product disappears from the storefront. */
  async archiveProduct(id: string) {
    await this.getProduct(id);
    await this.prisma.product.update({ where: { id }, data: { status: 'ARCHIVED', featured: false } });
    return { ok: true };
  }

  // ---------------------------------------------------------------- product helpers

  private normalizeVariants(variants: CreateProductInput['variants']): Array<CreateProductInput['variants'][number]> {
    const list = variants.map((v) => ({ ...v, sku: v.sku.trim() }));
    const skus = new Set<string>();
    for (const v of list) {
      if (skus.has(v.sku)) throw AppError.conflict('SKU_TAKEN');
      skus.add(v.sku);
    }
    // exactly one default variant: the first flagged one, otherwise the first in the list
    const firstDefault = list.findIndex((v) => v.isDefault);
    const defaultIndex = firstDefault === -1 ? 0 : firstDefault;
    return list.map((v, i) => ({ ...v, isDefault: i === defaultIndex }));
  }

  private async assertSkusFree(productSku: string | null | undefined, variantSkus: string[], excludeProductId?: string) {
    if (productSku) {
      const hit = await this.prisma.product.findFirst({ where: { sku: productSku, id: excludeProductId ? { not: excludeProductId } : undefined }, select: { id: true } });
      if (hit) throw AppError.conflict('SKU_TAKEN');
    }
    if (variantSkus.length) {
      const hit = await this.prisma.productVariant.findFirst({ where: { sku: { in: variantSkus } }, select: { id: true } });
      if (hit) throw AppError.conflict('SKU_TAKEN');
    }
  }

  private async resolveSlug(provided: string | undefined, translations: Array<{ locale: string; name: string }>): Promise<string> {
    if (provided) {
      const taken = await this.prisma.product.findUnique({ where: { slug: provided }, select: { id: true } });
      if (taken) throw AppError.conflict('SLUG_TAKEN');
      return provided;
    }
    const source = translations.find((t) => t.locale === 'en')?.name ?? translations[0].name;
    const base = slugify(source) || `product-${Date.now().toString(36)}`;
    for (let i = 0; i < 20; i++) {
      const candidate = i === 0 ? base : `${base}-${i + 1}`;
      const taken = await this.prisma.product.findUnique({ where: { slug: candidate }, select: { id: true } });
      if (!taken) return candidate;
    }
    return `${base}-${Date.now().toString(36)}`;
  }

  private async assertRefs(categoryIds?: string[], collectionIds?: string[]) {
    if (categoryIds?.length) {
      const n = await this.prisma.category.count({ where: { id: { in: categoryIds }, deletedAt: null } });
      if (n !== new Set(categoryIds).size) throw AppError.notFound();
    }
    if (collectionIds?.length) {
      const n = await this.prisma.collection.count({ where: { id: { in: collectionIds }, deletedAt: null } });
      if (n !== new Set(collectionIds).size) throw AppError.notFound();
    }
  }

  private async categoryNames(ids: string[]): Promise<string[]> {
    if (!ids.length) return [];
    const rows = await this.prisma.categoryTranslation.findMany({ where: { categoryId: { in: ids } }, select: { name: true } });
    return rows.map((r) => r.name);
  }

  private async createInitialStock(
    tx: Tx,
    variantId: string,
    sku: string,
    stock: { quantity: number; lowStockThreshold?: number; trackInventory?: boolean; allowBackorder?: boolean },
    actorId: string,
  ) {
    const item = await tx.inventoryItem.create({
      data: {
        variantId,
        sku,
        quantity: stock.quantity,
        lowStockThreshold: stock.lowStockThreshold ?? 5,
        trackInventory: stock.trackInventory ?? true,
        allowBackorder: stock.allowBackorder ?? false,
      },
    });
    if (stock.quantity > 0) {
      await tx.inventoryMovement.create({
        data: { inventoryItemId: item.id, type: 'IN', quantity: stock.quantity, quantityAfter: stock.quantity, reservedAfter: 0, reason: 'initial stock', actorId },
      });
    }
  }

  /** Update by id, create when new, soft-delete variants that were removed from the list. */
  private async syncVariants(tx: Tx, productId: string, currentIds: string[], variants: Array<CreateProductInput['variants'][number]>, actorId: string) {
    const keep = new Set<string>();
    const result: Array<{ id: string; sku: string }> = [];

    for (const [i, v] of variants.entries()) {
      const data = {
        sku: v.sku,
        color: v.color ?? null,
        material: v.material ?? null,
        size: v.size ?? null,
        paper: v.paper ?? null,
        priceDelta: v.priceDelta ?? 0,
        isDefault: v.isDefault ?? false,
        isActive: v.isActive ?? true,
        sortOrder: v.sortOrder ?? i,
      };
      let variantId: string;
      if (v.id) {
        if (!currentIds.includes(v.id)) throw AppError.notFound('VARIANT_UNAVAILABLE');
        await tx.productVariant.update({ where: { id: v.id }, data });
        variantId = v.id;
      } else {
        const created = await tx.productVariant.create({ data: { ...data, productId } });
        variantId = created.id;
        if (v.stock) await this.createInitialStock(tx, variantId, v.sku, v.stock, actorId);
      }
      for (const t of v.translations ?? []) {
        await tx.productVariantTranslation.upsert({
          where: { variantId_locale: { variantId, locale: t.locale } },
          create: { variantId, ...t },
          update: t,
        });
      }
      keep.add(variantId);
      result.push({ id: variantId, sku: v.sku });
    }

    const removed = currentIds.filter((id) => !keep.has(id));
    if (removed.length) {
      await tx.productVariant.updateMany({ where: { id: { in: removed } }, data: { deletedAt: new Date(), isActive: false, isDefault: false } });
    }
    return result;
  }

  private async syncMedia(
    tx: Tx,
    productId: string,
    media: CreateProductInput['media'] | undefined,
    variants: Array<{ id: string; sku: string }>,
  ) {
    if (!media) return;
    const keepIds = media.map((m) => m.id).filter((x): x is string => Boolean(x));
    await tx.productMedia.deleteMany({ where: { productId, id: { notIn: keepIds } } });

    let primarySeen = false;
    for (const [i, m] of media.entries()) {
      const variantId = m.variantSku ? (variants.find((v) => v.sku === m.variantSku)?.id ?? null) : null;
      const isPrimary = Boolean(m.isPrimary) && !primarySeen;
      if (isPrimary) primarySeen = true;
      const data = {
        url: m.url,
        storageKey: m.storageKey ?? null,
        alt: m.alt ?? null,
        type: m.type ?? ('IMAGE' as const),
        sortOrder: m.sortOrder ?? i,
        isPrimary,
        variantId,
      };
      if (m.id) await tx.productMedia.update({ where: { id: m.id }, data });
      else await tx.productMedia.create({ data: { ...data, productId } });
    }
    if (!primarySeen && media.length) {
      const first = await tx.productMedia.findFirst({ where: { productId }, orderBy: { sortOrder: 'asc' }, select: { id: true } });
      if (first) await tx.productMedia.update({ where: { id: first.id }, data: { isPrimary: true } });
    }
  }

  private async syncLinks(tx: Tx, productId: string, categoryIds?: string[], collectionIds?: string[], replace = false) {
    if (categoryIds) {
      if (replace) await tx.productCategory.deleteMany({ where: { productId } });
      const ids = [...new Set(categoryIds)];
      if (ids.length) await tx.productCategory.createMany({ data: ids.map((categoryId) => ({ productId, categoryId })) });
    }
    if (collectionIds) {
      if (replace) await tx.productCollection.deleteMany({ where: { productId } });
      const ids = [...new Set(collectionIds)];
      if (ids.length) await tx.productCollection.createMany({ data: ids.map((collectionId, i) => ({ productId, collectionId, sortOrder: i })) });
    }
  }

  // ---------------------------------------------------------------- categories

  listCategories() {
    return this.prisma.category.findMany({
      where: { deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { translations: true, _count: { select: { products: true } } },
    });
  }

  async createCategory(input: CategoryInput) {
    await this.assertCategoryParent(null, input.parentId);
    const { translations, ...data } = input;
    try {
      return await this.prisma.category.create({ data: { ...data, translations: { create: translations } }, include: { translations: true } });
    } catch (err) {
      throw this.slugConflict(err);
    }
  }

  async updateCategory(id: string, input: UpdateCategoryInput) {
    const existing = await this.prisma.category.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
    if (!existing) throw AppError.notFound();
    if (input.parentId !== undefined) await this.assertCategoryParent(id, input.parentId);
    const { translations, ...data } = input;
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.category.update({ where: { id }, data });
        for (const t of translations ?? []) {
          await tx.categoryTranslation.upsert({ where: { categoryId_locale: { categoryId: id, locale: t.locale } }, create: { categoryId: id, ...t }, update: t });
        }
      });
    } catch (err) {
      throw this.slugConflict(err);
    }
    return this.prisma.category.findUnique({ where: { id }, include: { translations: true } });
  }

  async deleteCategory(id: string) {
    const existing = await this.prisma.category.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
    if (!existing) throw AppError.notFound();
    await this.prisma.$transaction(async (tx) => {
      await tx.category.update({ where: { id }, data: { deletedAt: new Date(), active: false } });
      await tx.category.updateMany({ where: { parentId: id }, data: { parentId: null } });
    });
    return { ok: true };
  }

  /** Two levels maximum (parent -> child) and no cycles. */
  private async assertCategoryParent(selfId: string | null, parentId: string | null | undefined) {
    if (!parentId) return;
    if (parentId === selfId) throw AppError.badRequest('VALIDATION_ERROR', {}, [{ field: 'parentId', code: 'INVALID_PARENT' }]);
    const parent = await this.prisma.category.findFirst({ where: { id: parentId, deletedAt: null }, select: { parentId: true } });
    if (!parent) throw AppError.notFound();
    if (parent.parentId) throw AppError.badRequest('VALIDATION_ERROR', {}, [{ field: 'parentId', code: 'INVALID_PARENT' }]);
    if (selfId) {
      const hasChildren = await this.prisma.category.count({ where: { parentId: selfId, deletedAt: null } });
      if (hasChildren) throw AppError.badRequest('VALIDATION_ERROR', {}, [{ field: 'parentId', code: 'INVALID_PARENT' }]);
    }
  }

  private slugConflict(err: unknown): unknown {
    return (err as any)?.code === 'P2002' ? AppError.conflict('SLUG_TAKEN') : err;
  }

  // ---------------------------------------------------------------- collections

  listCollections() {
    return this.prisma.collection.findMany({
      where: { deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { translations: true, products: { select: { productId: true }, orderBy: { sortOrder: 'asc' } } },
    });
  }

  async createCollection(input: CollectionInput) {
    const { translations, productIds, ...data } = input;
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const c = await tx.collection.create({ data: { ...data, translations: { create: translations } } });
        if (productIds?.length) await tx.productCollection.createMany({ data: [...new Set(productIds)].map((productId, i) => ({ productId, collectionId: c.id, sortOrder: i })) });
        return c;
      });
      return this.prisma.collection.findUnique({ where: { id: created.id }, include: { translations: true, products: { select: { productId: true } } } });
    } catch (err) {
      throw this.slugConflict(err);
    }
  }

  async updateCollection(id: string, input: UpdateCollectionInput) {
    const existing = await this.prisma.collection.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
    if (!existing) throw AppError.notFound();
    const { translations, productIds, ...data } = input;
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.collection.update({ where: { id }, data });
        for (const t of translations ?? []) {
          await tx.collectionTranslation.upsert({ where: { collectionId_locale: { collectionId: id, locale: t.locale } }, create: { collectionId: id, ...t }, update: t });
        }
        if (productIds) {
          await tx.productCollection.deleteMany({ where: { collectionId: id } });
          if (productIds.length) await tx.productCollection.createMany({ data: [...new Set(productIds)].map((productId, i) => ({ productId, collectionId: id, sortOrder: i })) });
        }
      });
    } catch (err) {
      throw this.slugConflict(err);
    }
    return this.prisma.collection.findUnique({ where: { id }, include: { translations: true, products: { select: { productId: true } } } });
  }

  async deleteCollection(id: string) {
    const existing = await this.prisma.collection.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
    if (!existing) throw AppError.notFound();
    await this.prisma.collection.update({ where: { id }, data: { deletedAt: new Date(), active: false } });
    return { ok: true };
  }
}
