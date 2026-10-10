import { Global, Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller.js';
import { InventoryService } from './inventory.service.js';

@Global()
@Module({
  controllers: [InventoryController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
