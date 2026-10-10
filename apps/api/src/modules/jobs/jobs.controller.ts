import { Controller, Get, Headers, Post } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error.js';
import { Public, RateLimit } from '../../common/decorators.js';
import { safeEqual } from '../../common/crypto/tokens.js';
import { env } from '../../config/env.js';
import { JobsService } from './jobs.service.js';

@Controller('internal/cron')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  /**
   * Vercel Cron calls GET with `Authorization: Bearer $CRON_SECRET`; external pingers can use POST or GET with the same header.
   */
  @Public()
  @RateLimit(30, 60)
  @Get('tick')
  tickGet(@Headers('authorization') auth?: string) {
    return this.run(auth);
  }

  @Public()
  @RateLimit(30, 60)
  @Post('tick')
  tickPost(@Headers('authorization') auth?: string) {
    return this.run(auth);
  }

  private async run(auth?: string) {
    if (!env.CRON_SECRET) throw AppError.notFound(); // endpoint does not exist until a secret is configured
    const given = (auth ?? '').replace(/^Bearer\s+/i, '');
    if (!given || !safeEqual(given, env.CRON_SECRET)) throw AppError.unauthorized();
    return { ranAt: new Date().toISOString(), tasks: await this.jobs.tick() };
  }
}
