import { Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { env } from '../../config/env.js';
import { PERMISSIONS_KEY } from '../decorators.js';
import type { PermissionMeta } from '../decorators.js';
import { AppError } from '../errors/app-error.js';
import type { AppRequest } from '../types.js';

/**
 * RBAC enforcement on the server. Runs after AuthGuard (registration order in AppModule).
 * Routes without @RequirePermissions / @RequireAnyPermission are not permission-gated
 * (customer routes do ownership checks inside the services).
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const meta = this.reflector.getAllAndOverride<PermissionMeta | undefined>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!meta) return true;

    const req = context.switchToHttp().getRequest<AppRequest>();
    const user = req.user;
    if (!user) throw AppError.unauthorized();

    const owned = new Set(user.permissions);
    const okAll = (meta.all ?? []).every((p) => owned.has(p));
    const okAny = !meta.any || meta.any.some((p) => owned.has(p));
    if (!okAll || !okAny) throw AppError.forbidden();

    if (env.ADMIN_REQUIRE_2FA && !user.twoFactorEnabled) throw AppError.forbidden('TWO_FACTOR_REQUIRED');
    return true;
  }
}
