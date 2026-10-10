import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PERMISSIONS, ROLE_KEYS } from '@nb/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AppError } from '../../common/errors/app-error.js';
import { AuthService } from '../auth/auth.service.js';
import { paginationSchema, skipTake, toPage } from '../../common/utils/pagination.js';
import type { Pagination } from '../../common/utils/pagination.js';
import type { AuthUser } from '../../common/types.js';

const STAFF_ROLE_KEYS = ROLE_KEYS.filter((k) => k !== 'customer');

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  // ---------------------------------------------------------------- roles

  async listRoles() {
    const roles = await this.prisma.role.findMany({
      orderBy: { key: 'asc' },
      include: {
        permissions: { select: { permission: { select: { key: true } } } },
        _count: { select: { users: true } },
      },
    });
    return roles.map((r) => ({
      id: r.id,
      key: r.key,
      nameAr: r.nameAr,
      nameEn: r.nameEn,
      isSystem: r.isSystem,
      userCount: r._count.users,
      permissions: r.permissions.map((p) => p.permission.key).sort(),
    }));
  }

  listPermissions() {
    return PERMISSIONS;
  }

  async setRolePermissions(roleKey: string, permissionKeys: string[]) {
    if (roleKey === 'super_admin' || roleKey === 'customer') throw AppError.forbidden();
    const role = await this.prisma.role.findUnique({ where: { key: roleKey }, select: { id: true } });
    if (!role) throw AppError.notFound('ROLE_NOT_FOUND');

    const unknown = permissionKeys.filter((k) => !(PERMISSIONS as readonly string[]).includes(k));
    if (unknown.length) throw AppError.badRequest('VALIDATION_ERROR', {}, unknown.map((k) => ({ field: 'permissions', code: 'UNKNOWN_PERMISSION', message: k })));

    const perms = await this.prisma.permission.findMany({ where: { key: { in: permissionKeys } }, select: { id: true } });
    await this.prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId: role.id } });
      await tx.rolePermission.createMany({ data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })) });
    });
    return this.listRoles();
  }

  // ---------------------------------------------------------------- staff accounts

  async listAdmins(query: { search?: string }, pagination: Pagination = paginationSchema.parse({})) {
    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      roles: { some: { role: { key: { in: STAFF_ROLE_KEYS } } } },
      ...(query.search
        ? {
            OR: [
              { email: { contains: query.search, mode: 'insensitive' } },
              { firstName: { contains: query.search, mode: 'insensitive' } },
              { lastName: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...skipTake(pagination),
        select: {
          id: true, email: true, firstName: true, lastName: true, status: true, twoFactorEnabled: true, lastLoginAt: true, createdAt: true,
          roles: { select: { role: { select: { key: true } } } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);
    return toPage(rows.map((u) => ({ ...u, roles: u.roles.map((r) => r.role.key) })), total, pagination);
  }

  async createAdmin(actor: AuthUser, input: { email: string; firstName: string; lastName: string; roleKeys: string[] }) {
    this.assertCanGrant(actor, input.roleKeys);
    const roles = await this.resolveRoles(input.roleKeys);
    const existing = await this.prisma.user.findUnique({ where: { email: input.email }, select: { id: true } });
    if (existing) throw AppError.conflict('EMAIL_ALREADY_REGISTERED');

    const user = await this.prisma.user.create({
      data: {
        email: input.email,
        firstName: input.firstName,
        lastName: input.lastName,
        emailVerifiedAt: new Date(),
        roles: { create: roles.map((r) => ({ roleId: r.id })) },
      },
      select: { id: true, email: true },
    });
    // The new admin sets their own password through the standard reset-email flow.
    await this.auth.forgotPassword(user.email);
    return { id: user.id, email: user.email, invited: true };
  }

  async updateAdmin(actor: AuthUser, id: string, input: { roleKeys?: string[]; status?: 'ACTIVE' | 'SUSPENDED' }) {
    if (actor.id === id) throw AppError.forbidden('CANNOT_MODIFY_SELF');
    const target = await this.prisma.user.findFirst({ where: { id, deletedAt: null }, select: { id: true, roles: { select: { role: { select: { key: true } } } } } });
    if (!target) throw AppError.notFound('USER_NOT_FOUND');
    const currentKeys = target.roles.map((r) => r.role.key);

    // Touching a Super Admin always needs the actor to be one.
    if (currentKeys.includes('super_admin') && !actor.roles.includes('super_admin')) throw AppError.forbidden();

    await this.prisma.$transaction(async (tx) => {
      if (input.roleKeys) {
        this.assertCanGrant(actor, input.roleKeys);
        const roles = await this.resolveRoles(input.roleKeys, tx);
        if (currentKeys.includes('super_admin') && !input.roleKeys.includes('super_admin')) await this.assertNotLastSuperAdmin(tx);
        await tx.userRole.deleteMany({ where: { userId: id } });
        await tx.userRole.createMany({ data: roles.map((r) => ({ userId: id, roleId: r.id })) });
      }
      if (input.status) {
        if (input.status === 'SUSPENDED' && currentKeys.includes('super_admin')) await this.assertNotLastSuperAdmin(tx);
        await tx.user.update({ where: { id }, data: { status: input.status } });
        if (input.status === 'SUSPENDED') await tx.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      }
    });
    return { ok: true };
  }

  /** Removes all staff roles (the account stays as a normal customer). */
  async demoteAdmin(actor: AuthUser, id: string) {
    return this.updateAdmin(actor, id, { roleKeys: ['customer'] });
  }

  async resetTwoFactor(id: string) {
    const target = await this.prisma.user.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
    if (!target) throw AppError.notFound('USER_NOT_FOUND');
    await this.auth.resetTwoFactorFor(id);
    return { ok: true };
  }

  // ---------------------------------------------------------------- helpers

  /** Only users who can edit roles (Super Admin) may hand out the privileged roles. */
  private assertCanGrant(actor: AuthUser, roleKeys: string[]) {
    const privileged = roleKeys.some((k) => k === 'super_admin' || k === 'admin');
    if (privileged && !actor.permissions.includes('roles.update')) throw AppError.forbidden();
  }

  private async resolveRoles(roleKeys: string[], db: Pick<PrismaService, 'role'> = this.prisma) {
    const unique = [...new Set(roleKeys)];
    const roles = await db.role.findMany({ where: { key: { in: unique } }, select: { id: true, key: true } });
    if (roles.length !== unique.length) throw AppError.notFound('ROLE_NOT_FOUND');
    return roles;
  }

  private async assertNotLastSuperAdmin(tx: Pick<PrismaService, 'user'>) {
    const count = await tx.user.count({
      where: { deletedAt: null, status: 'ACTIVE', roles: { some: { role: { key: 'super_admin' } } } },
    });
    if (count <= 1) throw AppError.conflict('CANNOT_REMOVE_LAST_SUPER_ADMIN');
  }
}
