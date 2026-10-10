import { Global, Module } from '@nestjs/common';
import { ContentController } from './content.controller.js';
import { ContentService } from './content.service.js';

@Global()
@Module({ controllers: [ContentController], providers: [ContentService], exports: [ContentService] })
export class ContentModule {}
