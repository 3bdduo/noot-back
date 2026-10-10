import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AppError } from '../../common/errors/app-error.js';
import { AUTH_USER_SELECT, toUserDto } from '../../common/auth-user.js';
import { verifyPassword } from '../../common/crypto/password.js';
import type { AddressInput, UpdateAddressInput, UpdateProfileInput } from './account.schemas.js';

const MAX_ADDRESSES = 10;
const OPEN_ORDER_STATUSES = [
  'PENDING_PAYMENT', 'COD_PENDING', 'PAYMENT_CONFIRMED', 'CUSTOMIZATION_REVIEW', 'CUSTOMIZATION_APPROVED',
  'IN_PRODUCTION', 'QUALITY_CHECK', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'REFUND_REQUESTED',
] as const;

@Injectable()
export class AccountService {
  constructor(private readonly prisma: PrismaService) {}

  async getProfile(userId: string) {
    const row = await this.prisma.user.findUnique({ where: { id: userId }, select: AUTH_USER_SELECT });
    if (!row || row.deletedAt) throw AppError.notFound('USER_NOT_FOUND');
    return toUserDto(row);
  }

  async updateProfile(userId: string, input: UpdateProfileInput) {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        firstName: input.firstName,
        lastName: input.lastName,
        phone: input.phone,
        locale: input.locale,
        marketingOptIn: input.marketingOptIn,
      },
    });
    return this.getProfile(userId);
  }

  // ---------------------------------------------------------------- addresses

  listAddresses(userId: string) {
    return this.prisma.address.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async createAddress(userId: string, input: AddressInput) {
    const count = await this.prisma.address.count({ where: { userId, deletedAt: null } });
    if (count >= MAX_ADDRESSES) throw AppError.badRequest('VALIDATION_ERROR');
    const makeDefault = input.isDefault === true || count === 0;

    return this.prisma.$transaction(async (tx) => {
      if (makeDefault) await tx.address.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } });
      const { isDefault: _ignored, ...fields } = input;
      return tx.address.create({ data: { ...fields, userId, isDefault: makeDefault } });
    });
  }

  async updateAddress(userId: string, id: string, input: UpdateAddressInput) {
    const existing = await this.prisma.address.findFirst({ where: { id, userId, deletedAt: null }, select: { id: true } });
    if (!existing) throw AppError.notFound('ADDRESS_NOT_FOUND');

    return this.prisma.$transaction(async (tx) => {
      const { isDefault, ...fields } = input;
      if (isDefault === true) await tx.address.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } });
      return tx.address.update({ where: { id }, data: { ...fields, ...(isDefault === undefined ? {} : { isDefault }) } });
    });
  }

  async deleteAddress(userId: string, id: string): Promise<void> {
    const existing = await this.prisma.address.findFirst({ where: { id, userId, deletedAt: null } });
    if (!existing) throw AppError.notFound('ADDRESS_NOT_FOUND');
    await this.prisma.$transaction(async (tx) => {
      await tx.address.update({ where: { id }, data: { deletedAt: new Date(), isDefault: false } });
      if (existing.isDefault) {
        const next = await tx.address.findFirst({ where: { userId, deletedAt: null }, orderBy: { createdAt: 'desc' }, select: { id: true } });
        if (next) await tx.address.update({ where: { id: next.id }, data: { isDefault: true } });
      }
    });
  }

  // ---------------------------------------------------------------- privacy (Law 151/2020 style rights)

  /** Machine-readable copy of everything we hold about the customer. */
  async exportData(userId: string) {
    const [user, addresses, orders, reviews, wishlist, designs, notifications] = await Promise.all([
      this.getProfile(userId),
      this.prisma.address.findMany({ where: { userId } }),
      this.prisma.order.findMany({
        where: { userId },
        include: { items: { select: { productSnapshot: true, variantSnapshot: true, customizationSnapshot: true, quantity: true, unitPrice: true, totalPrice: true } } },
      }),
      this.prisma.review.findMany({ where: { userId } }),
      this.prisma.wishlist.findUnique({ where: { userId }, include: { items: true } }),
      this.prisma.savedDesign.findMany({ where: { userId } }),
      this.prisma.notification.findMany({ where: { userId, channel: 'IN_APP' }, take: 200, orderBy: { createdAt: 'desc' } }),
    ]);
    return { exportedAt: new Date().toISOString(), user, addresses, orders, reviews, wishlist, savedDesigns: designs, notifications };
  }

  /**
   * Anonymises the account. Orders are kept (accounting / legal obligations) but detached from login data.
   */
  async deleteAccount(userId: string, password?: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, passwordHash: true, roles: { select: { role: { select: { key: true } } } } },
    });
    if (!user) throw AppError.notFound('USER_NOT_FOUND');
    if (user.roles.some((r) => r.role.key !== 'customer')) throw AppError.forbidden();
    if (user.passwordHash && !(await verifyPassword(password ?? '', user.passwordHash))) throw AppError.badRequest('PASSWORD_INCORRECT');

    const open = await this.prisma.order.count({ where: { userId, status: { in: [...OPEN_ORDER_STATUSES] } } });
    if (open > 0) throw AppError.conflict('ACCOUNT_HAS_ACTIVE_ORDERS');

    await this.prisma.$transaction(async (tx) => {
      await tx.refreshToken.deleteMany({ where: { userId } });
      await tx.emailToken.deleteMany({ where: { userId } });
      await tx.address.deleteMany({ where: { userId } });
      await tx.cart.deleteMany({ where: { userId } });
      await tx.wishlist.deleteMany({ where: { userId } });
      await tx.savedDesign.deleteMany({ where: { userId } });
      await tx.notification.deleteMany({ where: { userId } });
      await tx.user.update({
        where: { id: userId },
        data: {
          email: `deleted+${userId}@deleted.invalid`,
          firstName: 'Deleted',
          lastName: 'User',
          phone: null,
          passwordHash: null,
          googleId: null,
          twoFactorEnabled: false,
          twoFactorSecret: null,
          marketingOptIn: false,
          deletedAt: new Date(),
        },
      });
    });
  }
}
