import { Global, Module } from '@nestjs/common';
import { ReviewsController } from './reviews.controller.js';
import { ReviewsService } from './reviews.service.js';

@Global()
@Module({ controllers: [ReviewsController], providers: [ReviewsService], exports: [ReviewsService] })
export class ReviewsModule {}
