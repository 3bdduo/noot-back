import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Locale } from '@nb/shared';
import { CurrentUser, Public, RateLimit, ReqLocale, RequirePermissions } from '../../common/decorators.js';
import { ZodPipe } from '../../common/pipes/zod.pipe.js';
import { paginationSchema } from '../../common/utils/pagination.js';
import type { AuthUser } from '../../common/types.js';
import { UploadsService } from '../uploads/uploads.service.js';
import { ReviewsService } from './reviews.service.js';

const listSchema = paginationSchema.extend({ sort: z.enum(['recent', 'highest', 'lowest']).optional() });
const reviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  title: z.string().trim().max(120).optional(),
  body: z.string().trim().max(2000).optional(),
  imageKeys: z.array(z.string().max(300)).max(4).optional(),
});
const createSchema = reviewSchema.extend({ productId: z.string().min(1).max(64) });
const imagePresign = z.object({ fileName: z.string().trim().min(1).max(200), mimeType: z.string().min(3).max(100), sizeBytes: z.number().int().min(1).max(8 * 1024 * 1024) });
const imageComplete = z.object({ key: z.string().min(1).max(300) });
const adminList = paginationSchema.extend({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
  productId: z.string().max(64).optional(),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  q: z.string().trim().max(60).optional(),
});
const moderateSchema = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
  adminResponse: z.string().trim().max(1000).nullable().optional(),
});

@Controller()
export class ReviewsController {
  constructor(
    private readonly reviews: ReviewsService,
    private readonly uploads: UploadsService,
  ) {}

  @Public()
  @Get('products/:slug/reviews')
  list(@Param('slug') slug: string, @Query(new ZodPipe(listSchema)) q: z.infer<typeof listSchema>) {
    const { sort, ...p } = q;
    return this.reviews.listForProduct(slug, p, sort ?? 'recent');
  }

  @Get('account/reviews')
  mine(@CurrentUser() u: AuthUser, @ReqLocale() locale: Locale) {
    return this.reviews.mine(u.id, locale);
  }

  @Get('account/reviews/reviewable')
  reviewable(@CurrentUser() u: AuthUser, @ReqLocale() locale: Locale) {
    return this.reviews.reviewable(u.id, locale);
  }

  @RateLimit(10, 3600)
  @HttpCode(201)
  @Post('reviews')
  create(@CurrentUser() u: AuthUser, @Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>) {
    const { productId, ...input } = body;
    return this.reviews.create(u.id, productId, input);
  }

  @Patch('reviews/:id')
  update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(reviewSchema)) body: z.infer<typeof reviewSchema>) {
    return this.reviews.update(u.id, id, body);
  }

  @Delete('reviews/:id')
  remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.reviews.remove(u.id, id);
  }

  @RateLimit(20, 3600)
  @HttpCode(201)
  @Post('reviews/images/presign')
  presignImage(@Body(new ZodPipe(imagePresign)) body: z.infer<typeof imagePresign>) {
    return this.uploads.presignMedia({ folder: 'reviews', ...body });
  }

  @Post('reviews/images/complete')
  completeImage(@Body(new ZodPipe(imageComplete)) body: z.infer<typeof imageComplete>) {
    return this.uploads.completeMedia(body.key);
  }

  // ---------------- admin

  @RequirePermissions('reviews.read')
  @Get('admin/reviews')
  adminList(@Query(new ZodPipe(adminList)) q: z.infer<typeof adminList>) {
    const { page, pageSize, ...f } = q;
    return this.reviews.adminList(f, { page, pageSize });
  }

  @RequirePermissions('reviews.moderate')
  @Patch('admin/reviews/:id')
  moderate(@Param('id') id: string, @Body(new ZodPipe(moderateSchema)) body: z.infer<typeof moderateSchema>) {
    return this.reviews.moderate(id, body);
  }

  @RequirePermissions('reviews.moderate')
  @Delete('admin/reviews/:id')
  adminDelete(@Param('id') id: string) {
    return this.reviews.adminDelete(id);
  }
}
