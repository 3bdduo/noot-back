import type { Request } from 'express';
import type { Locale } from '@nb/shared';

export interface AuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  locale: Locale;
  roles: string[];
  permissions: string[];
  twoFactorEnabled: boolean;
}

export interface AppRequest extends Request {
  user?: AuthUser;
  requestId?: string;
  locale?: Locale;
  rawBody?: Buffer;
}

/** Who is performing an action on the storefront: a signed-in user or an anonymous guest. */
export interface Actor {
  userId: string | null;
  /** sha256 of the raw guest token (never store the raw token). */
  guestHash: string | null;
}

export interface RequestMeta {
  ip: string;
  userAgent: string;
}
