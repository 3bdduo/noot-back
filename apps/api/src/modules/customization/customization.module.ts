import { Global, Module } from '@nestjs/common';
import { CustomizationController } from './customization.controller.js';
import { CustomizationService } from './customization.service.js';

@Global()
@Module({
  controllers: [CustomizationController],
  providers: [CustomizationService],
  exports: [CustomizationService],
})
export class CustomizationModule {}
