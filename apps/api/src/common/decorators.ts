import { createParamDecorator, SetMetadata } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { PermissionKey } from '@nb/shared';
import type { Actor, AppRequest, AuthUser, RequestMeta } from './types.js';
import { actorFrom, requestMeta } from './http.js';

export const IS_PUBLIC_KEY = 'nb:isPublic';
export const PERMISSIONS_KEY = 'nb:permissions';
export const RATE_LIMIT_KEY = 'nb:rateLimit';

/** Route is reachable without signing in (a valid token, if sent, is still honoured). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export interface PermissionMeta {
  all?: PermissionKey[];
  any?: PermissionKey[];
}

/** User must hold ALL of the permissions. */
export const RequirePermissions = (...permissions: PermissionKey[]) =>
  SetMetadata(PERMISSIONS_KEY, { all: permissions } satisfies PermissionMeta);

/** User must hold AT LEAST ONE of the permissions. */
export const RequireAnyPermission = (...permissions: PermissionKey[]) =>
  SetMetadata(PERMISSIONS_KEY, { any: permissions } satisfies PermissionMeta);

export interface RateLimitMeta {
  limit: number;
  windowSec: number;
}
export const RateLimit = (limit: number, windowSec: number) =>
  SetMetadata(RATE_LIMIT_KEY, { limit, windowSec } satisfies RateLimitMeta);

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser | undefined => {
  return ctx.switchToHttp().getRequest<AppRequest>().user;
});

export const CurrentActor = createParamDecorator((_data: unknown, ctx: ExecutionContext): Actor => {
  return actorFrom(ctx.switchToHttp().getRequest<AppRequest>());
});

export const ReqLocale = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<AppRequest>().locale ?? 'ar';
});

export const ReqMeta = createParamDecorator((_data: unknown, ctx: ExecutionContext): RequestMeta => {
  return requestMeta(ctx.switchToHttp().getRequest<AppRequest>());
});
