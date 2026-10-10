import { Global, Module } from '@nestjs/common';
import { CartController } from './cart.controller.js';
import { CartService } from './cart.service.js';

@Global()
@Module({
  controllers: [CartController],
  providers: [CartService],
  exports: [CartService],
})
export class CartModule {}
