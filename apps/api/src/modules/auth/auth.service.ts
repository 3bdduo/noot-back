import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { env } from '../../config/env.js';
import { AppError } from '../../common/errors/app-error.js';
import { signJwt, verifyJwt } from '../../common/crypto/jwt.js';
import { dummyVerify, hashPassword, verifyPassword } from '../../common/crypto/password.js';
import { decryptSecret, encryptSecret } from '../../common/crypto/secretbox.js';
import { randomToken, sha256Hex } from '../../common/crypto/tokens.js';
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../../common/crypto/totp.js';
import { AUTH_USER_SELECT, toAuthUser, toUserDto } from '../../common/auth-user.js';
import type { AuthUserRow } from '../../common/auth-user.js';
import { logEvent, maskEmail } from '../../common/logger.js';
import type { RequestMeta } from '../../common/types.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type { LoginInput, RegisterInput } from './auth.schemas.js';
import type { Locale } from '@nb/shared';

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const REFRESH_GRACE_MS = 10_000;
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

export interface SessionResult {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
  user: ReturnType<typeof toUserDto>;
}

export type LoginResult =
  | { kind: 'session'; session: SessionResult }
  | { kind: 'two_factor'; challengeToken: string };

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------------------------------------------------------------- register / verify

  async register(input: RegisterInput): Promise<{ requiresVerification: true }> {
    const existing = await this.prisma.user.findUnique({ where: { email: input.email }, select: { id: true } });
    if (existing) throw AppError.conflict('EMAIL_ALREADY_REGISTERED');

    const role = await this.prisma.role.findUnique({ where: { key: 'customer' }, select: { id: true } });
    if (!role) throw new Error('Role "customer" is missing: run `npm run db:seed`');

    const passwordHash = await hashPassword(input.password);
    const locale: Locale = input.locale ?? 'ar';
    const user = await this.prisma.user.create({
      data: {
        email: input.email,
        passwordHash,
        firstName: input.firstName,
        lastName: input.lastName,
        phone: input.phone ?? null,
        locale,
        marketingOptIn: input.marketingOptIn ?? false,
        roles: { create: { roleId: role.id } },
      },
      select: { id: true, email: true, firstName: true, locale: true },
    });

    await this.sendVerification(user.id, user.email, user.firstName, user.locale);
    return { requiresVerification: true };
  }

  async resendVerification(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, firstName: true, locale: true, emailVerifiedAt: true, deletedAt: true },
    });
    if (!user || user.deletedAt || user.emailVerifiedAt) return; // silent: never reveals account state
    const recent = await this.prisma.emailToken.findFirst({
      where: { userId: user.id, type: 'VERIFY_EMAIL', createdAt: { gt: new Date(Date.now() - 60_000) } },
      select: { id: true },
    });
    if (recent) return;
    await this.sendVerification(user.id, user.email, user.firstName, user.locale);
  }

  private async sendVerification(userId: string, email: string, firstName: string, locale: Locale): Promise<void> {
    const raw = randomToken(32);
    await this.prisma.emailToken.create({
      data: { userId, type: 'VERIFY_EMAIL', tokenHash: sha256Hex(raw), expiresAt: new Date(Date.now() + VERIFY_TTL_MS) },
    });
    await this.notifications.notify({
      event: 'verify_email',
      locale,
      email,
      data: { name: firstName, url: `${env.APP_URL.replace(/\/$/, '')}/verify-email?token=${raw}` },
    });
  }

  async verifyEmail(rawToken: string): Promise<void> {
    const token = await this.prisma.emailToken.findUnique({ where: { tokenHash: sha256Hex(rawToken) } });
    if (!token || token.type !== 'VERIFY_EMAIL' || token.usedAt) throw AppError.badRequest('INVALID_TOKEN');
    if (token.expiresAt < new Date()) throw AppError.badRequest('TOKEN_EXPIRED');

    const user = await this.prisma.$transaction(async (tx) => {
      await tx.emailToken.update({ where: { id: token.id }, data: { usedAt: new Date() } });
      return tx.user.update({
        where: { id: token.userId },
        data: { emailVerifiedAt: new Date() },
        select: { email: true, firstName: true, locale: true },
      });
    });
    await this.notifications.notify({ event: 'welcome', locale: user.locale, email: user.email, data: { name: user.firstName } });
  }

  // ---------------------------------------------------------------- login

  async login(input: LoginInput, meta: RequestMeta): Promise<LoginResult> {
    const user = await this.prisma.user.findUnique({ where: { email: input.email }, select: { ...AUTH_USER_SELECT, passwordHash: true, failedLoginCount: true, lockedUntil: true } });

    if (!user || user.deletedAt) {
      await dummyVerify(input.password);
      logEvent('warn', 'auth.login_failed', { email: maskEmail(input.email), ip: meta.ip, reason: 'unknown_user' });
      throw AppError.unauthorized('INVALID_CREDENTIALS');
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      logEvent('warn', 'auth.login_blocked', { userId: user.id, ip: meta.ip });
      throw AppError.tooMany('ACCOUNT_LOCKED');
    }

    const valid = await verifyPassword(input.password, user.passwordHash);
    if (!valid) {
      await this.registerFailedAttempt(user.id, user.failedLoginCount, meta);
      throw AppError.unauthorized('INVALID_CREDENTIALS');
    }
    if (user.status === 'SUSPENDED') throw AppError.forbidden('ACCOUNT_SUSPENDED');
    if (!user.emailVerifiedAt) throw AppError.forbidden('EMAIL_NOT_VERIFIED');

    await this.prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });
    return this.afterPrimaryAuth(user, meta);
  }

  private async registerFailedAttempt(userId: string, current: number, meta: RequestMeta): Promise<void> {
    const next = current + 1;
    const lock = next >= MAX_FAILED_LOGINS;
    await this.prisma.user.update({
      where: { id: userId },
      data: lock
        ? { failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) }
        : { failedLoginCount: next },
    });
    logEvent('warn', 'auth.login_failed', { userId, ip: meta.ip, attempts: next, locked: lock });
  }

  /** After the first factor succeeded: either a session or a 2FA challenge. */
  private async afterPrimaryAuth(user: AuthUserRow, meta: RequestMeta): Promise<LoginResult> {
    if (user.twoFactorEnabled) {
      const challengeToken = signJwt({ sub: user.id, typ: '2fa' }, env.AUTH_SECRET, 5 * 60);
      return { kind: 'two_factor', challengeToken };
    }
    return { kind: 'session', session: await this.issueSession(user, meta) };
  }

  async verifyTwoFactorLogin(challengeToken: string, code: string, meta: RequestMeta): Promise<SessionResult> {
    const payload = verifyJwt(challengeToken, env.AUTH_SECRET);
    if (!payload || payload.typ !== '2fa') throw AppError.unauthorized('INVALID_TOKEN');

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { ...AUTH_USER_SELECT, twoFactorSecret: true, failedLoginCount: true, lockedUntil: true },
    });
    if (!user || user.deletedAt || !user.twoFactorSecret) throw AppError.unauthorized('INVALID_TOKEN');
    if (user.lockedUntil && user.lockedUntil > new Date()) throw AppError.tooMany('ACCOUNT_LOCKED');
    if (user.status === 'SUSPENDED') throw AppError.forbidden('ACCOUNT_SUSPENDED');

    const secret = decryptSecret(user.twoFactorSecret, env.AUTH_SECRET);
    if (!verifyTotp(secret, code)) {
      await this.registerFailedAttempt(user.id, user.failedLoginCount, meta);
      throw AppError.unauthorized('TWO_FACTOR_INVALID');
    }
    await this.prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });
    return this.issueSession(user, meta);
  }

  // ---------------------------------------------------------------- Google

  async loginWithGoogle(idToken: string, locale: Locale | undefined, meta: RequestMeta): Promise<LoginResult> {
    if (!env.GOOGLE_CLIENT_ID) throw AppError.badRequest('GOOGLE_LOGIN_DISABLED');

    const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`, {
      signal: AbortSignal.timeout(6000),
    }).catch(() => null);
    if (!res || !res.ok) throw AppError.unauthorized('GOOGLE_TOKEN_INVALID');
    const info = (await res.json()) as Record<string, string>;

    const issuerOk = info.iss === 'accounts.google.com' || info.iss === 'https://accounts.google.com';
    if (info.aud !== env.GOOGLE_CLIENT_ID || !issuerOk || info.email_verified !== 'true' || !info.sub || !info.email) {
      throw AppError.unauthorized('GOOGLE_TOKEN_INVALID');
    }
    const email = info.email.toLowerCase();

    let user = await this.prisma.user.findFirst({
      where: { OR: [{ googleId: info.sub }, { email }] },
      select: AUTH_USER_SELECT,
    });

    if (user?.deletedAt) throw AppError.forbidden('ACCOUNT_SUSPENDED');
    if (!user) {
      const role = await this.prisma.role.findUnique({ where: { key: 'customer' }, select: { id: true } });
      if (!role) throw new Error('Role "customer" is missing: run `npm run db:seed`');
      user = await this.prisma.user.create({
        data: {
          email,
          googleId: info.sub,
          emailVerifiedAt: new Date(),
          firstName: (info.given_name || info.name || email.split('@')[0]).slice(0, 60),
          lastName: (info.family_name || '-').slice(0, 60),
          locale: locale ?? 'ar',
          roles: { create: { roleId: role.id } },
        },
        select: AUTH_USER_SELECT,
      });
      await this.notifications.notify({ event: 'welcome', locale: user.locale, email, data: { name: user.firstName } });
    } else {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { googleId: info.sub, emailVerifiedAt: user.emailVerifiedAt ?? new Date() },
      });
    }
    if (user.status === 'SUSPENDED') throw AppError.forbidden('ACCOUNT_SUSPENDED');
    return this.afterPrimaryAuth(user, meta);
  }

  // ---------------------------------------------------------------- sessions

  private async issueSession(user: AuthUserRow, meta: RequestMeta, familyId?: string): Promise<SessionResult> {
    const accessTtl = env.ACCESS_TOKEN_TTL_MIN * 60;
    const accessToken = signJwt({ sub: user.id, typ: 'access' }, env.AUTH_SECRET, accessTtl);
    const refreshToken = randomToken(48);
    const refreshExpiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);

    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256Hex(refreshToken),
        familyId: familyId ?? randomToken(12),
        expiresAt: refreshExpiresAt,
        userAgent: meta.userAgent || null,
        ip: meta.ip || null,
      },
    });
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    return { accessToken, expiresIn: accessTtl, refreshToken, refreshExpiresAt, user: toUserDto(user) };
  }

  /** Refresh-token rotation with reuse detection (a replayed token revokes the whole family). */
  async refresh(rawToken: string | undefined, meta: RequestMeta): Promise<SessionResult> {
    if (!rawToken) throw AppError.unauthorized('REFRESH_TOKEN_INVALID');
    const record = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256Hex(rawToken) } });
    if (!record) throw AppError.unauthorized('REFRESH_TOKEN_INVALID');

    if (record.revokedAt) {
      const withinGrace = Date.now() - record.revokedAt.getTime() < REFRESH_GRACE_MS && Boolean(record.replacedById);
      if (!withinGrace) {
        await this.prisma.refreshToken.updateMany({ where: { familyId: record.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
        logEvent('warn', 'auth.refresh_reuse_detected', { userId: record.userId, familyId: record.familyId, ip: meta.ip });
        throw AppError.unauthorized('REFRESH_TOKEN_INVALID');
      }
    }
    if (record.expiresAt < new Date()) throw AppError.unauthorized('REFRESH_TOKEN_INVALID');

    const user = await this.prisma.user.findUnique({ where: { id: record.userId }, select: AUTH_USER_SELECT });
    if (!user || user.deletedAt || user.status === 'SUSPENDED') throw AppError.unauthorized('REFRESH_TOKEN_INVALID');

    const session = await this.issueSession(user, meta, record.familyId);
    if (!record.revokedAt) {
      const created = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256Hex(session.refreshToken) }, select: { id: true } });
      await this.prisma.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date(), replacedById: created?.id ?? null } });
    }
    return session;
  }

  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken) return;
    const record = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256Hex(rawToken) }, select: { familyId: true } });
    if (record) {
      await this.prisma.refreshToken.updateMany({ where: { familyId: record.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
    }
  }

  async logoutAll(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  async listSessions(userId: string) {
    return this.prisma.refreshToken.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, userAgent: true, ip: true, createdAt: true, expiresAt: true },
    });
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const record = await this.prisma.refreshToken.findFirst({ where: { id: sessionId, userId }, select: { familyId: true } });
    if (!record) throw AppError.notFound();
    await this.prisma.refreshToken.updateMany({ where: { familyId: record.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  async me(userId: string) {
    const row = await this.prisma.user.findUnique({ where: { id: userId }, select: AUTH_USER_SELECT });
    if (!row || row.deletedAt) throw AppError.unauthorized();
    return toUserDto(row);
  }

  // ---------------------------------------------------------------- passwords

  async forgotPassword(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, firstName: true, locale: true, deletedAt: true, status: true },
    });
    if (!user || user.deletedAt || user.status === 'SUSPENDED') return; // identical response either way

    await this.prisma.emailToken.updateMany({
      where: { userId: user.id, type: 'RESET_PASSWORD', usedAt: null },
      data: { usedAt: new Date() },
    });
    const raw = randomToken(32);
    await this.prisma.emailToken.create({
      data: { userId: user.id, type: 'RESET_PASSWORD', tokenHash: sha256Hex(raw), expiresAt: new Date(Date.now() + RESET_TTL_MS) },
    });
    await this.notifications.notify({
      event: 'reset_password',
      locale: user.locale,
      email: user.email,
      data: { name: user.firstName, url: `${env.APP_URL.replace(/\/$/, '')}/reset-password?token=${raw}` },
    });
  }

  async resetPassword(rawToken: string, newPassword: string): Promise<void> {
    const token = await this.prisma.emailToken.findUnique({ where: { tokenHash: sha256Hex(rawToken) } });
    if (!token || token.type !== 'RESET_PASSWORD' || token.usedAt) throw AppError.badRequest('INVALID_TOKEN');
    if (token.expiresAt < new Date()) throw AppError.badRequest('TOKEN_EXPIRED');

    const passwordHash = await hashPassword(newPassword);
    const user = await this.prisma.$transaction(async (tx) => {
      await tx.emailToken.update({ where: { id: token.id }, data: { usedAt: new Date() } });
      await tx.refreshToken.updateMany({ where: { userId: token.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      return tx.user.update({
        where: { id: token.userId },
        // a successful reset also proves ownership of the mailbox
        data: { passwordHash, failedLoginCount: 0, lockedUntil: null, emailVerifiedAt: new Date() },
        select: { email: true, firstName: true, locale: true },
      });
    });
    await this.notifications.notify({ event: 'password_changed', locale: user.locale, email: user.email, data: { name: user.firstName } });
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, passwordHash: true, email: true, firstName: true, locale: true },
    });
    if (!user) throw AppError.unauthorized();
    if (!(await verifyPassword(currentPassword, user.passwordHash))) throw AppError.badRequest('PASSWORD_INCORRECT');

    const passwordHash = await hashPassword(newPassword);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { passwordHash } });
      await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    });
    await this.notifications.notify({ event: 'password_changed', locale: user.locale, email: user.email, data: { name: user.firstName } });
  }

  // ---------------------------------------------------------------- two-factor (TOTP)

  async setupTwoFactor(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true, twoFactorEnabled: true } });
    if (!user) throw AppError.unauthorized();
    if (user.twoFactorEnabled) throw AppError.conflict('CONFLICT');
    const secret = generateTotpSecret();
    await this.prisma.user.update({ where: { id: userId }, data: { twoFactorSecret: encryptSecret(secret, env.AUTH_SECRET) } });
    return { secret, otpauthUrl: otpauthUrl(env.BRAND_NAME, user.email, secret) };
  }

  async enableTwoFactor(userId: string, code: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { twoFactorSecret: true } });
    if (!user?.twoFactorSecret) throw AppError.badRequest('TWO_FACTOR_INVALID');
    if (!verifyTotp(decryptSecret(user.twoFactorSecret, env.AUTH_SECRET), code)) throw AppError.badRequest('TWO_FACTOR_INVALID');
    await this.prisma.user.update({ where: { id: userId }, data: { twoFactorEnabled: true } });
  }

  async disableTwoFactor(userId: string, code: string, password?: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { twoFactorSecret: true, passwordHash: true, twoFactorEnabled: true } });
    if (!user?.twoFactorSecret || !user.twoFactorEnabled) throw AppError.badRequest('TWO_FACTOR_INVALID');
    if (user.passwordHash && !(await verifyPassword(password ?? '', user.passwordHash))) throw AppError.badRequest('PASSWORD_INCORRECT');
    if (!verifyTotp(decryptSecret(user.twoFactorSecret, env.AUTH_SECRET), code)) throw AppError.badRequest('TWO_FACTOR_INVALID');
    await this.prisma.user.update({ where: { id: userId }, data: { twoFactorEnabled: false, twoFactorSecret: null } });
  }

  /** Used by a Super Admin to unlock a colleague who lost the authenticator device. */
  async resetTwoFactorFor(userId: string): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { twoFactorEnabled: false, twoFactorSecret: null } });
    await this.logoutAll(userId);
  }
}
