import { Global, Module } from '@nestjs/common';
import { CheckoutService } from './checkout.service.js';
import { CustomizationReviewService } from './customization-review.service.js';
import { DocumentsService } from './documents.service.js';
import { OrdersAdminController } from './orders-admin.controller.js';
import { OrdersAdminService } from './orders-admin.service.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';

@Global()
@Module({
  controllers: [OrdersController, OrdersAdminController],
  providers: [OrdersService, CheckoutService, OrdersAdminService, CustomizationReviewService, DocumentsService],
  exports: [OrdersService, DocumentsService],
})
export class OrdersModule {}
