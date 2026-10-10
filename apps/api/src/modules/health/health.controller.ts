import { Controller, Get } from '@nestjs/common';
import { Public } from '../../common/decorators.js';
import { AppError } from '../../common/errors/app-error.js';
import { PrismaService } from '../../prisma/prisma.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  live() {
    return { status: 'ok', time: new Date().toISOString() };
  }

  @Public()
  @Get('ready')
  async ready() {
    try {
      await this.prisma.$runCommandRaw({ ping: 1 });
      return { status: 'ok', database: 'up' };
    } catch {
      throw AppError.unavailable('SERVICE_UNAVAILABLE');
    }
  }
}
