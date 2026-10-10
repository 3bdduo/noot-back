import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../../common/decorators.js';
import { ZodPipe } from '../../common/pipes/zod.pipe.js';
import { paginationSchema } from '../../common/utils/pagination.js';
import type { AuthUser } from '../../common/types.js';
import { NotificationsService } from './notifications.service.js';

const readSchema = z.object({ ids: z.array(z.string().max(64)).max(100).optional() });

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query(new ZodPipe(paginationSchema)) q: z.infer<typeof paginationSchema>) {
    return this.notifications.listForUser(user.id, q);
  }

  @Post('read')
  async read(@CurrentUser() user: AuthUser, @Body(new ZodPipe(readSchema)) body: z.infer<typeof readSchema>) {
    await this.notifications.markRead(user.id, body.ids);
    return { ok: true };
  }
}
