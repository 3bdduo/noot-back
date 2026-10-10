import { Injectable } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { tap } from 'rxjs';
import type { Observable } from 'rxjs';
import type { Response } from 'express';
import { logEvent } from '../logger.js';
import type { AppRequest } from '../types.js';

/** One structured access-log line per request. Never logs bodies, headers or query secrets. */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<AppRequest>();
    const res = http.getResponse<Response>();
    const started = Date.now();
    const log = (status: number) =>
      logEvent(status >= 500 ? 'error' : 'info', 'http.request', {
        requestId: req.requestId,
        method: req.method,
        path: req.path,
        status,
        ms: Date.now() - started,
        userId: req.user?.id,
      });

    return next.handle().pipe(
      tap({
        next: () => log(res.statusCode),
        error: (err) => log(Number(err?.status ?? err?.getStatus?.() ?? 500)),
      }),
    );
  }
}
