import { z } from 'zod';
import { env } from '../../config/env.js';

/**
 * Every runtime-configurable setting lives here with its validation schema and defaults.
 * Each schema must be parseable from `{}` (all fields have defaults).
 * Money values are INTEGER piasters; rates are basis points (1400 = 14%).
 */
export const SETTING_DEFS = {
  store: {
    isPublic: true,
    schema: z.object({
      nameAr: z.string().max(100).default(env.BRAND_NAME),
      nameEn: z.string().max(100).default(env.BRAND_NAME),
      supportEmail: z.string().max(200).default(''),
      supportPhone: z.string().max(40).default(''),
      whatsapp: z.string().max(40).default(''),
      address: z.string().max(300).default(''),
      instagram: z.string().max(200).default(''),
      facebook: z.string().max(200).default(''),
      tiktok: z.string().max(200).default(''),
      logoUrl: z.string().max(500).default(''),
    }),
  },
  cod: {
    isPublic: true,
    schema: z.object({
      enabled: z.boolean().default(true),
      /** Orders above this total cannot use COD. null = no limit. */
      maxOrderTotal: z.number().int().min(0).nullable().default(null),
      /** Extra fee added to COD orders. */
      fee: z.number().int().min(0).default(0),
      /** Max simultaneously unconfirmed COD orders per phone number (fake-order protection). */
      maxPendingPerPhone: z.number().int().min(1).max(50).default(3),
      /** Auto-cancel COD orders the admin has not confirmed after N hours. 0 = never. */
      autoCancelHours: z.number().int().min(0).max(720).default(0),
    }),
  },
  tax: {
    isPublic: true,
    schema: z.object({
      enabled: z.boolean().default(false),
      rateBps: z.number().int().min(0).max(10_000).default(0),
      /** true = prices already include tax (tax is only shown, not added). */
      inclusive: z.boolean().default(false),
      label: z.string().max(40).default('VAT'),
    }),
  },
  checkout: {
    isPublic: true,
    schema: z.object({
      guestCheckout: z.boolean().default(true),
      /** How long stock is held for an unpaid online order. */
      reservationMinutes: z.number().int().min(5).max(1440).default(30),
    }),
  },
  retention: {
    isPublic: false,
    schema: z.object({
      /** null = keep customer design files forever. */
      artworkRetentionMonths: z.number().int().min(1).max(120).nullable().default(null),
    }),
  },
  notifications: {
    isPublic: false,
    schema: z.object({
      abandonedCartEmails: z.boolean().default(true),
      abandonedCartAfterHours: z.number().int().min(1).max(168).default(3),
      backInStockEmails: z.boolean().default(true),
    }),
  },
} as const;

export type SettingKey = keyof typeof SETTING_DEFS;
export const SETTING_KEYS = Object.keys(SETTING_DEFS) as SettingKey[];

export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTING_DEFS)[K]['schema']>;

export function isSettingKey(key: string): key is SettingKey {
  return (SETTING_KEYS as string[]).includes(key);
}

export function defaultFor<K extends SettingKey>(key: K): SettingValue<K> {
  return SETTING_DEFS[key].schema.parse({}) as SettingValue<K>;
}
