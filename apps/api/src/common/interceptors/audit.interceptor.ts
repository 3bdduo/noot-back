import { Injectable } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { catchError, from, mergeMap, throwError } from 'rxjs';
import type { Observable } from 'rxjs';
import type { Response } from 'express';
import { AuditService } from '../../modules/audit/audit.service.js';
import { clientIp } from '../http.js';
import type { AppRequest } from '../types.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Records every mutating call made under /admin/* (who, what, which entity, from which IP, when).
 * Request bodies are redacted (passwords, tokens...) and size-capped by AuditService.
 * Awaited before the response completes so it survives serverless freezing.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<AppRequest>();
    const isAdminMutation = MUTATING.has(req.method) && /\/admin\//.test(req.path);
    if (!isAdminMutation || !req.user) return next.handle();

    const res = http.getResponse<Response>();
    const record = (outcome: 'ok' | 'failed', status: number) => {
      const segments = req.path.split('/').filter(Boolean);
      const adminIdx = segments.indexOf('admin');
      const entity = segments[adminIdx + 1] ?? 'unknown';
      const entityId = (req.params?.id as string | undefined) ?? undefined;
      return this.audit.log({
        actorId: req.user!.id,
        action: `${req.method} ${req.route?.path ?? req.path}`,
        entity,
        entityId,
        ip: clientIp(req),
        userAgent: String(req.headers['user-agent'] ?? ''),
        metadata: { outcome, status, requestId: req.requestId, params: req.params, body: this.safeBody(req.body) },
      });
    };

    return next.handle().pipe(
      mergeMap((data) => from(record('ok', res.statusCode).then(() => data))),
      catchError((err) =>
        from(record('failed', Number(err?.status ?? err?.getStatus?.() ?? 500)).catch(() => undefined)).pipe(
          mergeMap(() => throwError(() => err)),
        ),
      ),
    );
  }

  private safeBody(body: unknown): unknown {
    if (!body || typeof body !== 'object') return undefined;
    try {
      const json = JSON.stringify(body);
      if (json.length <= 4000) return body;
      return { _truncated: true, keys: Object.keys(body as object) };
    } catch {
      return undefined;
    }
  }
}
