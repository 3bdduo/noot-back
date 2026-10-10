import { Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { RATE_LIMIT_KEY } from '../decorators.js';
import type { RateLimitMeta } from '../decorators.js';
import { AppError } from '../errors/app-error.js';
import { clientIp } from '../http.js';
import type { AppRequest } from '../types.js';
import { MemoryRateLimiter } from './memory-rate-limiter.js';

export { MemoryRateLimiter };

const limiter = new MemoryRateLimiter();
const GLOBAL_LIMIT = 600; // requests / minute / IP

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const req = http.getRequest<AppRequest>();
    const res = http.getResponse<Response>();
    const ip = clientIp(req) || 'unknown';

    const globalHit = limiter.hit(`g:${ip}`, GLOBAL_LIMIT, 60);
    if (!globalHit.allowed) return this.reject(res, globalHit.retryAfterSec);

    const meta = this.reflector.getAllAndOverride<RateLimitMeta | undefined>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (meta) {
      const key = `r:${context.getClass().name}.${context.getHandler().name}:${ip}`;
      const hit = limiter.hit(key, meta.limit, meta.windowSec);
      if (!hit.allowed) return this.reject(res, hit.retryAfterSec);
    }
    return true;
  }

  private reject(res: Response, retryAfter: number): never {
    res.setHeader('Retry-After', String(retryAfter));
    throw AppError.tooMany();
  }
}
