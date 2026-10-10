import { z } from 'zod';
import { GOVERNORATE_CODES } from './governorates.js';
import { LOCALES, PAYMENT_METHODS } from './constants.js';

/** One entry per customization group the shopper touched. */
export const customizationSelectionSchema = z.object({
  groupCode: z.string().min(1).max(64),
  optionCodes: z.array(z.string().min(1).max(64)).max(20).optional(),
  text: z.string().max(500).optional(),
  date: z.string().max(32).optional(),
  artworkFileId: z.string().min(1).max(64).optional(),
});
export type CustomizationSelectionInput = z.infer<typeof customizationSelectionSchema>;

export const customizationInputSchema = z.array(customizationSelectionSchema).max(50);
export type CustomizationInput = z.infer<typeof customizationInputSchema>;

export const localeSchema = z.enum(LOCALES);

export const egyptianPhoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s\-()]/g, ''))
  .refine((v) => /^(\+20|0020|0)?1[0125]\d{8}$/.test(v), { message: 'INVALID_PHONE' })
  .transform((v) => {
    const digits = v.replace(/^(\+20|0020)/, '').replace(/^0/, '');
    return `+20${digits}`;
  });

export const checkoutAddressSchema = z.object({
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().min(1).max(60),
  phone: egyptianPhoneSchema,
  governorate: z.enum(GOVERNORATE_CODES),
  city: z.string().trim().min(1).max(100),
  street: z.string().trim().min(1).max(200),
  building: z.string().trim().max(60).optional(),
  apartment: z.string().trim().max(60).optional(),
  postalCode: z.string().trim().max(20).optional(),
});
export type CheckoutAddress = z.infer<typeof checkoutAddressSchema>;

export const checkoutRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254).optional(),
  addressId: z.string().min(1).max(64).optional(),
  address: checkoutAddressSchema.optional(),
  paymentMethod: z.enum(PAYMENT_METHODS),
  couponCode: z.string().trim().max(64).optional(),
  customerNote: z.string().trim().max(500).optional(),
  giftMessage: z
    .object({
      recipientName: z.string().trim().max(100).optional(),
      senderName: z.string().trim().max(100).optional(),
      message: z.string().trim().min(1).max(500),
      hidePrices: z.boolean().optional(),
    })
    .optional(),
});
export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>;
