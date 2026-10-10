import { Module } from '@nestjs/common';
import { WishlistController } from './wishlist.controller.js';
import { WishlistService } from './wishlist.service.js';

@Module({
  controllers: [WishlistController],
  providers: [WishlistService],
  exports: [WishlistService],
})
export class WishlistModule {}
