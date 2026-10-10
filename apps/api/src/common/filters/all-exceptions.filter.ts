import { Catch, HttpException } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { translate } from '../i18n/messages.js';
import { AppError } from '../errors/app-error.js';
import { logEvent } from '../logger.js';
import type { AppRequest } from '../types.js';

interface Mapped {
  status: number;
  code: string;
  params: Record<string, unknown>;
  details?: unknown;
}

const STATUS_TO_CODE: Record<number, string> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  429: 'TOO_MANY_REQUESTS',
};

const looksLikeCode = (s: string) => /^[A-Z][A-Z0-9_]+$/.test(s);

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<AppRequest>();
    const locale = req.locale ?? 'ar';
    const mapped = this.map(exception);

    if (mapped.status >= 500) {
      const err = exception as Error;
      logEvent('error', 'http.unhandled_exception', {
        requestId: req.requestId,
        method: req.method,
        path: req.path,
        userId: req.user?.id,
        name: err?.name,
        message: err?.message,
        stack: err?.stack?.split('\n').slice(0, 8).join('\n'),
      });
    }

    const message = translate(locale, mapped.code, mapped.params);
    const body = {
      error: {
        code: mapped.code,
        message,
        details: this.localizeDetails(mapped.details, locale),
        requestId: req.requestId,
      },
    };
    if (res.headersSent) return;
    res.status(mapped.status).json(body);
  }

  private localizeDetails(details: unknown, locale: 'ar' | 'en'): unknown {
    if (!Array.isArray(details)) return details;
    return details.map((d) => {
      if (d && typeof d === 'object' && typeof (d as any).code === 'string' && !(d as any).message) {
        return { ...(d as object), message: translate(locale, (d as any).code, (d as any).params ?? {}) };
      }
      return d;
    });
  }

  private map(exception: unknown): Mapped {
    if (exception instanceof AppError) {
      return { status: exception.getStatus(), code: exception.code, params: exception.params, details: exception.details };
    }

    if (exception instanceof ZodError) {
      const details = exception.issues.map((issue) => {
        const custom = looksLikeCode(issue.message) ? issue.message : undefined;
        return {
          field: issue.path.join('.'),
          code: custom ?? `invalid_${issue.code}`,
          message: custom ? undefined : issue.message,
        };
      });
      return { status: 400, code: 'VALIDATION_ERROR', params: {}, details };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return { status, code: STATUS_TO_CODE[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR'), params: {} };
    }

    const e = exception as any;
    if (e && typeof e === 'object') {
      // Prisma known request errors (checked by name so we do not import the runtime value).
      if (e.name === 'PrismaClientKnownRequestError') {
        if (e.code === 'P2002') return { status: 409, code: 'CONFLICT', params: {}, details: { target: e.meta?.target } };
        if (e.code === 'P2025') return { status: 404, code: 'NOT_FOUND', params: {} };
        // MongoDB: an id from the client that is not a valid ObjectId can never match a document.
        if (e.code === 'P2023') return { status: 404, code: 'NOT_FOUND', params: {} };
        if (e.code === 'P2003') return { status: 409, code: 'CONFLICT', params: {} };
        if (e.code === 'P2034') return { status: 409, code: 'CONFLICT', params: {} };
      }
      // body-parser errors (payload too large, malformed JSON)
      const st = Number(e.status ?? e.statusCode);
      if (Number.isInteger(st) && st >= 400 && st < 500) {
        if (e.type === 'entity.too.large') return { status: 413, code: 'PAYLOAD_TOO_LARGE', params: {} };
        if (e.type === 'entity.parse.failed') return { status: 400, code: 'MALFORMED_JSON', params: {} };
        return { status: st, code: STATUS_TO_CODE[st] ?? 'VALIDATION_ERROR', params: {} };
      }
    }

    return { status: 500, code: 'INTERNAL_ERROR', params: {} };
  }
}
