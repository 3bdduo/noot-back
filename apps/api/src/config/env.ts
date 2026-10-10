import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  APP_URL: z.string().url().default('http://localhost:3000'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  BRAND_NAME: z.string().default('Notebook Brand'),
  BRAND_DOMAIN: z.string().default('brand-domain.com'),
  ORDER_NUMBER_PREFIX: z.string().min(1).max(6).default('NB'),

  DATABASE_URL: z.string().min(1),

  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_MIN: z.coerce.number().int().positive().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  COOKIE_SECURE: bool.default(false),
  COOKIE_DOMAIN: optionalString,
  GOOGLE_CLIENT_ID: optionalString,
  ADMIN_REQUIRE_2FA: bool.default(false),

  EMAIL_API_KEY: optionalString,
  EMAIL_FROM: z.string().default('Notebook Brand <no-reply@brand-domain.com>'),
  SMS_API_KEY: optionalString,

  STORAGE_ACCOUNT_ID: optionalString,
  STORAGE_ACCESS_KEY_ID: optionalString,
  STORAGE_SECRET_ACCESS_KEY: optionalString,
  STORAGE_BUCKET: optionalString,
  STORAGE_PUBLIC_URL: optionalString,
  STORAGE_ENDPOINT: optionalString,

  PAYMENT_PROVIDER: z.enum(['none', 'mock']).default('none'),
  PAYMENT_MOCK_SECRET: z.string().default('dev-mock-webhook-secret'),

  CRON_SECRET: optionalString,
  ENABLE_SWAGGER: bool.default(true),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Env = z.infer<typeof schema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  const env = result.data;
  if (env.NODE_ENV === 'production') {
    if (env.PAYMENT_PROVIDER === 'mock') {
      throw new Error('PAYMENT_PROVIDER=mock is not allowed in production');
    }
    if (env.AUTH_SECRET.startsWith('change-me')) {
      throw new Error('AUTH_SECRET must be changed in production');
    }
  }
  return env;
}

export const env: Env = parseEnv(process.env as Record<string, string | undefined>);

export const corsOrigins: string[] = env.CORS_ORIGINS.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const isProd = env.NODE_ENV === 'production';
