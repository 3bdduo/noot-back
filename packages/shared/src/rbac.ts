/**
 * Permission keys follow `resource.action`.
 * Enforced on the server (PermissionsGuard). The same matrix is exported so the
 * admin frontend can hide actions the current user cannot perform.
 */
export const PERMISSIONS = [
  'products.read', 'products.create', 'products.update', 'products.delete',
  'categories.read', 'categories.create', 'categories.update', 'categories.delete',
  'collections.read', 'collections.create', 'collections.update', 'collections.delete',
  'customizations.read', 'customizations.create', 'customizations.update', 'customizations.delete',
  'customizations.review',
  'orders.read', 'orders.update', 'orders.cancel',
  'customers.read', 'customers.update',
  'inventory.read', 'inventory.update',
  'payments.read', 'payments.refund', 'payments.settings',
  'shipping.read', 'shipping.update',
  'coupons.read', 'coupons.create', 'coupons.update', 'coupons.delete',
  'reviews.read', 'reviews.moderate',
  'content.read', 'content.create', 'content.update', 'content.delete',
  'analytics.read',
  'admins.read', 'admins.create', 'admins.update', 'admins.delete',
  'roles.read', 'roles.update',
  'settings.read', 'settings.update',
  'audit.read',
] as const;
export type PermissionKey = (typeof PERMISSIONS)[number];

export const ROLE_KEYS = ['customer', 'admin', 'staff', 'content_manager', 'super_admin'] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

const all = [...PERMISSIONS] as PermissionKey[];

export const ROLE_PERMISSIONS: Record<RoleKey, PermissionKey[]> = {
  // Customers act only on their own data (ownership checks), no admin permissions.
  customer: [],
  super_admin: all,
  admin: all.filter(
    (p) => !['roles.update', 'settings.update', 'audit.read'].includes(p),
  ),
  staff: [
    'orders.read',
    'orders.update',
    'customizations.read',
    'customizations.review',
    'inventory.read',
    'shipping.read',
    'shipping.update',
    'products.read',
  ],
  content_manager: [
    'content.read', 'content.create', 'content.update', 'content.delete',
    'collections.read', 'collections.create', 'collections.update', 'collections.delete',
    'categories.read',
    'products.read',
  ],
};

export const ROLE_LABELS: Record<RoleKey, { ar: string; en: string }> = {
  customer: { ar: 'عميل', en: 'Customer' },
  admin: { ar: 'مدير', en: 'Admin' },
  staff: { ar: 'موظف طلبات', en: 'Staff / Order Manager' },
  content_manager: { ar: 'مدير محتوى', en: 'Content Manager' },
  super_admin: { ar: 'مدير عام', en: 'Super Admin' },
};
