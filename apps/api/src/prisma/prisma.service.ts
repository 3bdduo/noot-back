import { Injectable } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { logEvent } from '../common/logger.js';

/** Transaction client handed to `prisma.$transaction(async (tx) => ...)`. */
export type Tx = Prisma.TransactionClient;
/** Either the root client or a transaction client: lets services run inside or outside a transaction. */
export type Db = PrismaService | Tx;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({ log: [{ level: 'warn', emit: 'stdout' }, { level: 'error', emit: 'stdout' }] });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
    } catch (err) {
      // Do not crash the whole process: /health/ready reports the problem and Prisma reconnects lazily.
      logEvent('error', 'prisma.connect_failed', { message: (err as Error).message });
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Interactive transaction with sane timeouts for serverless.
   * MongoDB aborts a transaction with a "write conflict" (Prisma P2034) when two transactions touch the
   * same document at once. The loser is safe to run again from scratch, so it is retried a few times.
   * Keep `fn` free of side effects outside the database (emails etc. go through the after-commit list).
   */
  async tx<T>(fn: (tx: Tx) => Promise<T>, opts: { timeoutMs?: number; retries?: number } = {}): Promise<T> {
    const retries = opts.retries ?? 3;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.$transaction(fn, { maxWait: 10_000, timeout: opts.timeoutMs ?? 20_000 });
      } catch (err) {
        const code = (err as { code?: string } | null)?.code;
        if (code === 'P2034' && attempt < retries) {
          await new Promise((r) => setTimeout(r, 30 * (attempt + 1) + Math.floor(Math.random() * 40)));
          continue;
        }
        throw err;
      }
    }
  }
}
