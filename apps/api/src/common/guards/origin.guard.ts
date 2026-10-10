import { Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { corsOrigins } from '../../config/env.js';
import { AppError } from '../errors/app-error.js';
import type { AppRequest } from '../types.js';

/**
 * CSRF defence for the endpoints that rely on the httpOnly refresh cookie (/auth/refresh, /auth/logout).
 *  1. If the browser sent an Origin (or Referer) it MUST be an allowed frontend origin.
 *  2. A custom header (`x-nb-client`) is required: cross-site forms cannot set custom headers,
 *     and cross-site fetches would need a CORS preflight that our CORS policy rejects.
 * All other state-changing routes use the Authorization header, which is not sent automatically by browsers.
 */
@Injectable()
export class OriginGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AppRequest>();

    const origin = (req.headers.origin as string | undefined) ?? this.originOf(req.headers.referer as string | undefined);
    if (origin && !corsOrigins.includes(origin)) throw AppError.forbidden('INVALID_ORIGIN');

    if (!req.headers['x-nb-client']) throw AppError.forbidden('INVALID_ORIGIN');
    return true;
  }

  private originOf(url: string | undefined): string | undefined {
    if (!url) return undefined;
    try {
      return new URL(url).origin;
    } catch {
      return undefined;
    }
  }
}
