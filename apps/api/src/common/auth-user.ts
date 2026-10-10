import type { Prisma } from '@prisma/client';
import type { AuthUser } from './types.js';

/** Prisma select that loads everything needed to build an AuthUser (roles + flattened permissions). */
export const AUTH_USER_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
  locale: true,
  status: true,
  deletedAt: true,
  emailVerifiedAt: true,
  twoFactorEnabled: true,
  marketingOptIn: true,
  createdAt: true,
  roles: {
    select: {
      role: {
        select: {
          key: true,
          permissions: { select: { permission: { select: { key: true } } } },
        },
      },
    },
  },
} satisfies Prisma.UserSelect;

export type AuthUserRow = Prisma.UserGetPayload<{ select: typeof AUTH_USER_SELECT }>;

export function toAuthUser(row: AuthUserRow): AuthUser {
  const permissions = new Set<string>();
  const roles: string[] = [];
  for (const ur of row.roles) {
    roles.push(ur.role.key);
    for (const rp of ur.role.permissions) permissions.add(rp.permission.key);
  }
  return {
    id: row.id,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    locale: row.locale,
    roles,
    permissions: [...permissions],
    twoFactorEnabled: row.twoFactorEnabled,
  };
}

/** Public-facing user shape returned by the API (never includes hashes / secrets). */
export function toUserDto(row: AuthUserRow) {
  const auth = toAuthUser(row);
  return {
    id: row.id,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    phone: row.phone,
    locale: row.locale,
    emailVerified: Boolean(row.emailVerifiedAt),
    twoFactorEnabled: row.twoFactorEnabled,
    marketingOptIn: row.marketingOptIn,
    roles: auth.roles,
    permissions: auth.permissions,
    isStaff: auth.permissions.length > 0,
    createdAt: row.createdAt,
  };
}
