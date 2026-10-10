import { Global, Module } from '@nestjs/common';
import { PaymentsAdminController, PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';

@Global()
@Module({
  controllers: [PaymentsController, PaymentsAdminController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
