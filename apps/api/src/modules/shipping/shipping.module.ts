import { Global, Module } from '@nestjs/common';
import { ShippingController } from './shipping.controller.js';
import { ShippingService } from './shipping.service.js';

@Global()
@Module({
  controllers: [ShippingController],
  providers: [ShippingService],
  exports: [ShippingService],
})
export class ShippingModule {}
