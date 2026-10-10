import type { LoggerService } from '@nestjs/common';
import { env } from '../config/env.js';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE = /pass|secret|token|card|cvv|cvc|authorization|cookie|signature|api[-_]?key|otp|code$/i;

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 4) return '[depth]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 500) return value.slice(0, 500) + '…';
  return value;
}

export function maskEmail(email: string | null | undefined): string {
  if (!email) return '';
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local.slice(0, 1)}***@${domain}`;
}

function write(level: Level, msg: string, extra?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[env.LOG_LEVEL]) return;
  const line = JSON.stringify({ level, time: new Date().toISOString(), msg, ...(extra ? (redact(extra) as object) : {}) });
  (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
}

/** Structured domain event (payments, webhooks, auth failures...). Secrets are redacted automatically. */
export function logEvent(level: Level, event: string, data?: Record<string, unknown>): void {
  write(level, event, data);
}

export class AppLogger implements LoggerService {
  log(message: unknown, context?: string) {
    write('info', String(message), context ? { context } : undefined);
  }
  error(message: unknown, trace?: unknown, context?: string) {
    write('error', String(message), { context, trace: typeof trace === 'string' ? trace.slice(0, 2000) : undefined });
  }
  warn(message: unknown, context?: string) {
    write('warn', String(message), context ? { context } : undefined);
  }
  debug(message: unknown, context?: string) {
    write('debug', String(message), context ? { context } : undefined);
  }
  verbose(message: unknown, context?: string) {
    write('debug', String(message), context ? { context } : undefined);
  }
}
