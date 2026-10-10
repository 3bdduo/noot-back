import { z } from 'zod';
import { checkoutAddressSchema, egyptianPhoneSchema, localeSchema } from '@nb/shared';

export const updateProfileSchema = z
  .object({
    firstName: z.string().trim().min(1).max(60),
    lastName: z.string().trim().min(1).max(60),
    phone: egyptianPhoneSchema.nullable(),
    locale: localeSchema,
    marketingOptIn: z.boolean(),
  })
  .partial();
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const addressSchema = checkoutAddressSchema.extend({
  label: z.string().trim().max(40).optional(),
  notes: z.string().trim().max(300).optional(),
  isDefault: z.boolean().optional(),
});
export type AddressInput = z.infer<typeof addressSchema>;

export const updateAddressSchema = addressSchema.partial();
export type UpdateAddressInput = z.infer<typeof updateAddressSchema>;

export const deleteAccountSchema = z.object({ password: z.string().max(128).optional() });
