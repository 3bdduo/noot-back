import { z } from 'zod';
import { egyptianPhoneSchema, localeSchema } from '@nb/shared';
import { checkPasswordPolicy } from '../../common/crypto/password.js';

const email = z.string().trim().toLowerCase().email().max(254);

export const passwordSchema = z
  .string()
  .max(128)
  .refine((p) => checkPasswordPolicy(p).ok, { message: 'PASSWORD_WEAK' });

export const registerSchema = z.object({
  email,
  password: passwordSchema,
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().min(1).max(60),
  phone: egyptianPhoneSchema.optional(),
  locale: localeSchema.optional(),
  marketingOptIn: z.boolean().optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({ email, password: z.string().min(1).max(128) });
export type LoginInput = z.infer<typeof loginSchema>;

export const tokenSchema = z.object({ token: z.string().min(10).max(200) });
export const emailOnlySchema = z.object({ email });
export const resetPasswordSchema = z.object({ token: z.string().min(10).max(200), password: passwordSchema });
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema });
export const googleLoginSchema = z.object({ idToken: z.string().min(20).max(4000), locale: localeSchema.optional() });
export const twoFactorCodeSchema = z.object({ code: z.string().trim().min(6).max(10) });
export const twoFactorDisableSchema = z.object({ code: z.string().trim().min(6).max(10), password: z.string().max(128).optional() });
export const twoFactorVerifySchema = z.object({ challengeToken: z.string().min(20).max(2000), code: z.string().trim().min(6).max(10) });
