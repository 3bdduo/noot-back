import type { Request } from 'express';
import type { Locale } from '@nb/shared';
import { sha256Hex } from './crypto/tokens.js';
import type { Actor, AppRequest, RequestMeta } from './types.js';

export function clientIp(req: Request): string {
  const xf = req.headers['x-forwarded-for'];
  const first = Array.isArray(xf) ? xf[0] : xf?.split(',')[0];
  return (first || req.ip || req.socket?.remoteAddress || '').trim();
}

export function requestMeta(req: Request): RequestMeta {
  return {
    ip: clientIp(req),
    userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300),
  };
}

export function resolveLocale(req: Request): Locale {
  const explicit = (req.headers['x-locale'] as string | undefined) ?? (req.query?.lang as string | undefined);
  const header = explicit ?? (req.headers['accept-language'] as string | undefined) ?? '';
  const lower = String(header).toLowerCase();
  if (lower.startsWith('en')) return 'en';
  if (lower.startsWith('ar')) return 'ar';
  return 'ar';
}

/** Reads the anonymous visitor token from `x-guest-token` and returns the hashed form. */
export function guestHashFrom(req: Request): string | null {
  const raw = req.headers['x-guest-token'];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (!token || typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
  return sha256Hex(token);
}

export function actorFrom(req: AppRequest): Actor {
  return { userId: req.user?.id ?? null, guestHash: guestHashFrom(req) };
}
