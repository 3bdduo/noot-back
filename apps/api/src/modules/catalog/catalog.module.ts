import { Global, Module } from '@nestjs/common';
import { AdminCatalogService } from './admin-catalog.service.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogService } from './catalog.service.js';

@Global()
@Module({
  controllers: [CatalogController],
  providers: [CatalogService, AdminCatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
