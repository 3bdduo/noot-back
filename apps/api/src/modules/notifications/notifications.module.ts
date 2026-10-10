import { Global, Module } from '@nestjs/common';
import { EmailProvider } from './email.provider.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';

@Global()
@Module({
  controllers: [NotificationsController],
  providers: [EmailProvider, NotificationsService],
  exports: [NotificationsService, EmailProvider],
})
export class NotificationsModule {}
