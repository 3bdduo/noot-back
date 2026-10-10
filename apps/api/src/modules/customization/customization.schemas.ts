import { z } from 'zod';
import { ALLOWED_ARTWORK_MIME_TYPES, CUSTOMIZATION_GROUP_TYPES, TEXT_CHARSETS, localeSchema } from '@nb/shared';

const code = z.string().trim().min(1).max(64).regex(/^[a-z0-9_]+$/, { message: 'INVALID_CODE' });
const optionalInt = z.number().int().min(0).nullable().optional();
const money = z.number().int().min(-10_000_000).max(10_000_000);

export const groupTranslationSchema = z.object({
  locale: localeSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  placeholder: z.string().trim().max(120).nullable().optional(),
  helpText: z.string().trim().max(500).nullable().optional(),
});

export const optionTranslationSchema = z.object({
  locale: localeSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
});

const urlish = z.string().trim().max(1000).nullable().optional();
const colorHex = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, { message: 'INVALID_COLOR' }).nullable().optional();

export const createGroupSchema = z.object({
  code,
  stepKey: code,
  type: z.enum(CUSTOMIZATION_GROUP_TYPES),
  required: z.boolean().optional(),
  exclusiveWithinStep: z.boolean().optional(),
  minSelect: z.number().int().min(0).max(20).optional(),
  maxSelect: z.number().int().min(1).max(20).nullable().optional(),
  minLength: optionalInt,
  maxLength: z.number().int().min(1).max(500).nullable().optional(),
  allowedCharsets: z.array(z.enum(TEXT_CHARSETS)).max(5).optional(),
  pattern: z.string().max(200).nullable().optional(),
  allowedMimeTypes: z.array(z.enum(ALLOWED_ARTWORK_MIME_TYPES)).max(5).optional(),
  maxFileSizeBytes: z.number().int().min(1024).max(25 * 1024 * 1024).nullable().optional(),
  minWidthPx: optionalInt,
  minHeightPx: optionalInt,
  maxWidthPx: optionalInt,
  maxHeightPx: optionalInt,
  priceDelta: money.optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  active: z.boolean().optional(),
  translations: z.array(groupTranslationSchema).min(1).max(2),
});
export type CreateGroupInput = z.infer<typeof createGroupSchema>;

export const updateGroupSchema = createGroupSchema.omit({ code: true }).partial();
export type UpdateGroupInput = z.infer<typeof updateGroupSchema>;

export const stockInputSchema = z.object({
  quantity: z.number().int().min(0).max(1_000_000),
  lowStockThreshold: z.number().int().min(0).max(100_000).optional(),
  trackInventory: z.boolean().optional(),
  allowBackorder: z.boolean().optional(),
});

export const createOptionSchema = z.object({
  code,
  imageUrl: urlish,
  previewLayerUrl: urlish,
  colorHex,
  priceDelta: money.optional(),
  sku: z.string().trim().min(1).max(64).nullable().optional(),
  isDefault: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  active: z.boolean().optional(),
  translations: z.array(optionTranslationSchema).min(1).max(2),
  stock: stockInputSchema.optional(),
});
export type CreateOptionInput = z.infer<typeof createOptionSchema>;

export const updateOptionSchema = createOptionSchema.omit({ code: true, stock: true }).partial();
export type UpdateOptionInput = z.infer<typeof updateOptionSchema>;

export const productGroupsSchema = z
  .array(
    z.object({
      groupId: z.string().min(1).max(64),
      required: z.boolean().nullable().optional(),
      sortOrder: z.number().int().min(0).max(10_000).optional(),
    }),
  )
  .max(30);

export const listGroupsQuerySchema = z.object({
  stepKey: z.string().max(64).optional(),
  search: z.string().trim().max(100).optional(),
  includeInactive: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});
