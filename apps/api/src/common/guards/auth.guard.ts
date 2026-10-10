import { Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { env } from '../../config/env.js';
import { verifyJwt } from '../crypto/jwt.js';
import { IS_PUBLIC_KEY } from '../decorators.js';
import { AppError } from '../errors/app-error.js';
import { AUTH_USER_SELECT, toAuthUser } from '../auth-user.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { AppRequest, AuthUser } from '../types.js';

/**
 * Global guard. Always tries to authenticate (Bearer access token) so public routes such as
 * cart / checkout can serve both guests and signed-in users. Non-public routes require a user.
 * The user + roles + permissions are loaded from the DB on every request, so suspensions and
 * permission changes take effect immediately even though access tokens are stateless.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AppRequest>();
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);

    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    const payload = token ? verifyJwt(token, env.AUTH_SECRET) : null;

    if (payload && payload.typ === 'access') {
      const user = await this.loadUser(payload.sub);
      if (user) req.user = user;
      else if (!isPublic) throw AppError.unauthorized();
    }

    if (!isPublic && !req.user) throw AppError.unauthorized();
    return true;
  }

  private async loadUser(id: string): Promise<AuthUser | null> {
    const row = await this.prisma.user.findUnique({ where: { id }, select: AUTH_USER_SELECT });
    if (!row || row.deletedAt) return null;
    if (row.status === 'SUSPENDED') throw AppError.forbidden('ACCOUNT_SUSPENDED');
    return toAuthUser(row);
  }
}
