import { z } from 'zod';
import { customizationInputSchema, localeSchema } from '@nb/shared';
import { paginationSchema } from '../../common/utils/pagination.js';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');
const csv = z
  .string()
  .max(200)
  .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20));

export const PRODUCT_SORTS = ['featured', 'newest', 'price_asc', 'price_desc', 'best_selling'] as const;

export const listProductsQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  category: z.string().trim().max(100).optional(),
  collection: z.string().trim().max(100).optional(),
  /** piasters */
  minPrice: z.coerce.number().int().min(0).optional(),
  maxPrice: z.coerce.number().int().min(0).optional(),
  color: csv.optional(),
  material: csv.optional(),
  inStock: bool.optional(),
  featured: bool.optional(),
  gift: bool.optional(),
  customizable: bool.optional(),
  sort: z.enum(PRODUCT_SORTS).default('featured'),
});
export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;

export const quoteSchema = z.object({
  variantId: z.string().max(64).optional(),
  quantity: z.number().int().min(1).max(100).default(1),
  customization: customizationInputSchema.optional(),
});

// ----------------------------------------------------------------------------- admin

const slug = z.string().trim().min(1).max(120).regex(/^[a-z0-9؀-ۿ]+(?:-[a-z0-9؀-ۿ]+)*$/, { message: 'INVALID_SLUG' });
const money = z.number().int().min(0).max(100_000_000);
const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();

export const productTranslationSchema = z.object({
  locale: localeSchema,
  name: z.string().trim().min(1).max(200),
  shortDescription: nullableText(500),
  description: nullableText(10_000),
  seoTitle: nullableText(200),
  seoDescription: nullableText(400),
});

const stockSchema = z.object({
  quantity: z.number().int().min(0).max(1_000_000),
  lowStockThreshold: z.number().int().min(0).max(100_000).optional(),
  trackInventory: z.boolean().optional(),
  allowBackorder: z.boolean().optional(),
});

export const variantInputSchema = z.object({
  id: z.string().max(64).optional(),
  sku: z.string().trim().min(1).max(64),
  color: nullableText(60),
  material: nullableText(60),
  size: nullableText(60),
  paper: nullableText(60),
  priceDelta: z.number().int().min(-100_000_000).max(100_000_000).optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  translations: z.array(z.object({ locale: localeSchema, name: z.string().trim().min(1).max(120) })).max(2).optional(),
  /** Only used when the variant is created. Later changes go through the inventory endpoints. */
  stock: stockSchema.optional(),
});

export const mediaInputSchema = z.object({
  id: z.string().max(64).optional(),
  url: z.string().trim().min(1).max(1000),
  storageKey: z.string().trim().max(500).nullable().optional(),
  alt: nullableText(200),
  type: z.enum(['IMAGE', 'VIDEO']).optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  isPrimary: z.boolean().optional(),
  variantSku: z.string().trim().max(64).nullable().optional(),
});

export const createProductSchema = z.object({
  slug: slug.optional(),
  sku: z.string().trim().min(1).max(64).nullable().optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).optional(),
  basePrice: money,
  compareAtPrice: money.nullable().optional(),
  isGift: z.boolean().optional(),
  featured: z.boolean().optional(),
  leadTimeDays: z.number().int().min(0).max(120).optional(),
  material: nullableText(60),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  translations: z.array(productTranslationSchema).min(1).max(2),
  variants: z.array(variantInputSchema).min(1).max(100),
  media: z.array(mediaInputSchema).max(40).optional(),
  categoryIds: z.array(z.string().max(64)).max(20).optional(),
  collectionIds: z.array(z.string().max(64)).max(20).optional(),
});
export type CreateProductInput = z.infer<typeof createProductSchema>;

export const updateProductSchema = createProductSchema.partial();
export type UpdateProductInput = z.infer<typeof updateProductSchema>;

export const adminListProductsQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).optional(),
  category: z.string().max(64).optional(),
  includeArchived: bool.optional(),
});

export const categoryInputSchema = z.object({
  slug,
  parentId: z.string().max(64).nullable().optional(),
  imageUrl: nullableText(1000),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  active: z.boolean().optional(),
  translations: z.array(z.object({ locale: localeSchema, name: z.string().trim().min(1).max(120), description: nullableText(1000) })).min(1).max(2),
});
export const updateCategorySchema = categoryInputSchema.partial();

export const collectionInputSchema = z.object({
  slug,
  imageUrl: nullableText(1000),
  featured: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  active: z.boolean().optional(),
  translations: z.array(z.object({ locale: localeSchema, name: z.string().trim().min(1).max(120), description: nullableText(1000) })).min(1).max(2),
  productIds: z.array(z.string().max(64)).max(500).optional(),
});
export const updateCollectionSchema = collectionInputSchema.partial();
