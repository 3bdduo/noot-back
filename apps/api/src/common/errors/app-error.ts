import { HttpException } from '@nestjs/common';

/**
 * Domain error. `code` is a stable machine-readable identifier (also the key in the
 * i18n message catalogue); `params` fill placeholders in the localized message.
 */
export class AppError extends HttpException {
  readonly code: string;
  readonly params: Record<string, unknown>;
  readonly details?: unknown;

  constructor(status: number, code: string, params: Record<string, unknown> = {}, details?: unknown) {
    super({ code, params, details }, status);
    this.code = code;
    this.params = params;
    this.details = details;
  }

  static badRequest(code: string, params?: Record<string, unknown>, details?: unknown) {
    return new AppError(400, code, params, details);
  }
  static unauthorized(code = 'UNAUTHORIZED', params?: Record<string, unknown>) {
    return new AppError(401, code, params);
  }
  static forbidden(code = 'FORBIDDEN', params?: Record<string, unknown>) {
    return new AppError(403, code, params);
  }
  static notFound(code = 'NOT_FOUND', params?: Record<string, unknown>) {
    return new AppError(404, code, params);
  }
  static conflict(code: string, params?: Record<string, unknown>, details?: unknown) {
    return new AppError(409, code, params, details);
  }
  static unprocessable(code: string, params?: Record<string, unknown>, details?: unknown) {
    return new AppError(422, code, params, details);
  }
  static tooMany(code = 'TOO_MANY_REQUESTS', params?: Record<string, unknown>) {
    return new AppError(429, code, params);
  }
  static unavailable(code: string, params?: Record<string, unknown>) {
    return new AppError(503, code, params);
  }
}
