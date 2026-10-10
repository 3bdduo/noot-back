import { Global, Module } from '@nestjs/common';
import { STORAGE_DRIVER, createStorageDriver } from './storage.driver.js';
import { UploadsController } from './uploads.controller.js';
import { UploadsService } from './uploads.service.js';

@Global()
@Module({
  controllers: [UploadsController],
  providers: [{ provide: STORAGE_DRIVER, useFactory: createStorageDriver }, UploadsService],
  exports: [UploadsService, STORAGE_DRIVER],
})
export class UploadsModule {}
