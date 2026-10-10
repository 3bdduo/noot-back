import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { egyptianPhoneSchema, ORDER_STATUSES, PAYMENT_METHODS, PAYMENT_STATUSES } from '@nb/shared';
import type { Locale } from '@nb/shared';
import { CurrentUser, ReqLocale, RequirePermissions } from '../../common/decorators.js';
import { AppError } from '../../common/errors/app-error.js';
import { ZodPipe } from '../../common/pipes/zod.pipe.js';
import { paginationSchema } from '../../common/utils/pagination.js';
import type { AuthUser } from '../../common/types.js';
import { CustomizationReviewService } from './customization-review.service.js';
import { DocumentsService } from './documents.service.js';
import { OrdersAdminService } from './orders-admin.service.js';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const listSchema = paginationSchema.extend({
  status: z.enum(ORDER_STATUSES).optional(),
  paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  governorate: z.string().max(5).optional(),
  hasCustomization: bool.optional(),
  q: z.string().trim().max(80).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
const statusSchema = z.object({ status: z.enum(ORDER_STATUSES), note: z.string().trim().max(500).optional() });
const shipSchema = z.object({
  carrier: z.string().trim().min(1).max(40).default('manual'),
  trackingNumber: z.string().trim().max(80).nullable().optional(),
  trackingUrl: z.string().trim().url().max(500).nullable().optional(),
  items: z.array(z.object({ orderItemId: z.string().min(1).max(64), quantity: z.number().int().min(1) })).max(100).optional(),
});
const noteSchema = z.object({ body: z.string().trim().min(1).max(1000) });
const eventSchema = z.object({
  status: z.enum(['PENDING', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED', 'RETURNED']),
  description: z.string().trim().max(300).optional(),
  location: z.string().trim().max(120).optional(),
});
const reviewListSchema = paginationSchema.extend({
  status: z.enum(['PENDING_REVIEW', 'APPROVED', 'NEEDS_CHANGES', 'REJECTED', 'SENT_TO_PRODUCTION']).optional(),
  q: z.string().trim().max(60).optional(),
});
const reviewSchema = z.object({ action: z.enum(['approve', 'request_changes', 'reject']), note: z.string().trim().max(1000).optional() });
const blockSchema = z.object({ phone: egyptianPhoneSchema, reason: z.string().trim().max(200).optional() });

@Controller('admin')
export class OrdersAdminController {
  constructor(
    private readonly admin: OrdersAdminService,
    private readonly review: CustomizationReviewService,
    private readonly documents: DocumentsService,
  ) {}

  @RequirePermissions('orders.read')
  @Get('orders')
  list(@Query(new ZodPipe(listSchema)) q: z.infer<typeof listSchema>) {
    const { page, pageSize, ...filters } = q;
    return this.admin.list(filters, { page, pageSize });
  }

  @RequirePermissions('orders.read')
  @Get('orders/counts')
  counts() {
    return this.admin.counts();
  }

  @RequirePermissions('orders.read')
  @Get('orders/:id')
  get(@Param('id') id: string, @ReqLocale() locale: Locale) {
    return this.admin.get(id, locale);
  }

  /** Generic status change. Cancelling additionally requires `orders.cancel`; shipping has its own endpoint. */
  @RequirePermissions('orders.update')
  @Post('orders/:id/status')
  status(@CurrentUser() u: AuthUser, @ReqLocale() locale: Locale, @Param('id') id: string, @Body(new ZodPipe(statusSchema)) body: z.infer<typeof statusSchema>) {
    if (body.status === 'CANCELLED' && !u.permissions.includes('orders.cancel')) throw AppError.forbidden();
    return this.admin.transition(id, body.status, { type: 'ADMIN', id: u.id }, body.note, locale);
  }

  @RequirePermissions('orders.update')
  @Post('orders/:id/ship')
  ship(@CurrentUser() u: AuthUser, @ReqLocale() locale: Locale, @Param('id') id: string, @Body(new ZodPipe(shipSchema)) body: z.infer<typeof shipSchema>) {
    return this.admin.ship(id, body, { type: 'ADMIN', id: u.id }, locale);
  }

  @RequirePermissions('orders.update')
  @HttpCode(201)
  @Post('orders/:id/notes')
  note(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(noteSchema)) body: z.infer<typeof noteSchema>) {
    return this.admin.addNote(id, body.body, u.id);
  }

  @RequirePermissions('orders.update')
  @Post('shipments/:id/events')
  shipmentEvent(@Param('id') id: string, @Body(new ZodPipe(eventSchema)) body: z.infer<typeof eventSchema>) {
    return this.admin.addShipmentEvent(id, body);
  }

  @RequirePermissions('orders.read')
  @Get('orders/:id/invoice')
  async invoice(@Param('id') id: string, @ReqLocale() locale: Locale, @Res() res: Response) {
    res.type('html').setHeader('Cache-Control', 'private, no-store');
    res.send(await this.documents.invoiceHtml(id, locale));
  }

  @RequirePermissions('orders.read')
  @Get('orders/:id/production-sheet')
  async productionSheet(@Param('id') id: string, @ReqLocale() locale: Locale, @Res() res: Response) {
    res.type('html').setHeader('Cache-Control', 'private, no-store');
    res.send(await this.documents.productionSheetHtml(id, locale));
  }

  // ---------------- customization review queue

  @RequirePermissions('customizations.read')
  @Get('customizations')
  reviewList(@ReqLocale() locale: Locale, @Query(new ZodPipe(reviewListSchema)) q: z.infer<typeof reviewListSchema>) {
    const { page, pageSize, ...filters } = q;
    return this.review.list(filters, { page, pageSize }, locale);
  }

  @RequirePermissions('customizations.read')
  @Get('customizations/:itemId')
  reviewGet(@Param('itemId') itemId: string, @ReqLocale() locale: Locale) {
    return this.review.get(itemId, locale);
  }

  @RequirePermissions('customizations.review')
  @Post('customizations/:itemId/review')
  reviewDo(@CurrentUser() u: AuthUser, @Param('itemId') itemId: string, @Body(new ZodPipe(reviewSchema)) body: z.infer<typeof reviewSchema>) {
    return this.review.review(itemId, body.action, body.note, { type: 'ADMIN', id: u.id });
  }

  // ---------------- COD abuse protection

  @RequirePermissions('customers.read')
  @Get('blocked-phones')
  blocked() {
    return this.admin.listBlockedPhones();
  }

  @RequirePermissions('customers.update')
  @HttpCode(201)
  @Post('blocked-phones')
  block(@Body(new ZodPipe(blockSchema)) body: z.infer<typeof blockSchema>) {
    return this.admin.blockPhone(body.phone, body.reason);
  }

  @RequirePermissions('customers.update')
  @Delete('blocked-phones/:id')
  unblock(@Param('id') id: string) {
    return this.admin.unblockPhone(id);
  }
}
