import { Body, Controller, Get, Headers, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { checkoutAddressSchema, checkoutRequestSchema, customizationInputSchema, egyptianPhoneSchema, GOVERNORATE_CODES, ORDER_STATUSES, PAYMENT_METHODS } from '@nb/shared';
import type { Locale, OrderStatus } from '@nb/shared';
import { CurrentActor, CurrentUser, Public, RateLimit, ReqLocale } from '../../common/decorators.js';
import { ZodPipe } from '../../common/pipes/zod.pipe.js';
import { paginationSchema } from '../../common/utils/pagination.js';
import type { Actor, AuthUser } from '../../common/types.js';
import { CheckoutService } from './checkout.service.js';
import { DocumentsService } from './documents.service.js';
import { OrdersService } from './orders.service.js';

const previewSchema = z.object({ governorate: z.enum(GOVERNORATE_CODES), paymentMethod: z.enum(PAYMENT_METHODS) });
const listSchema = paginationSchema.extend({ status: z.enum(ORDER_STATUSES).optional() });
const cancelSchema = z.object({ reason: z.string().trim().max(300).optional() });
const trackSchema = z
  .object({
    orderNumber: z.string().trim().min(6).max(40),
    email: z.string().trim().toLowerCase().email().optional(),
    phone: egyptianPhoneSchema.optional(),
  })
  .refine((v) => v.email || v.phone, { message: 'VALIDATION_ERROR' });
const trackCancelSchema = z.object({
  orderNumber: z.string().trim().min(6).max(40),
  email: z.string().trim().toLowerCase().email(),
  reason: z.string().trim().max(300).optional(),
});
const personalizationSchema = z.object({ selections: customizationInputSchema });

@Controller()
export class OrdersController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly orders: OrdersService,
    private readonly documents: DocumentsService,
  ) {}

  // ---------------- checkout (guest or signed-in)

  @Public()
  @RateLimit(30, 60)
  @Post('checkout/preview')
  preview(@CurrentActor() actor: Actor, @ReqLocale() locale: Locale, @Body(new ZodPipe(previewSchema)) body: z.infer<typeof previewSchema>) {
    return this.checkout.preview(actor, body.governorate, body.paymentMethod, locale);
  }

  /** Send a unique `Idempotency-Key` header per checkout attempt; retries return the same order. */
  @Public()
  @RateLimit(10, 60)
  @Post('checkout')
  place(
    @CurrentActor() actor: Actor,
    @ReqLocale() locale: Locale,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodPipe(checkoutRequestSchema)) body: z.infer<typeof checkoutRequestSchema>,
  ) {
    const key = idempotencyKey && idempotencyKey.length >= 8 && idempotencyKey.length <= 100 ? idempotencyKey : undefined;
    return this.checkout.placeOrder(actor, body, locale, key);
  }

  // ---------------- my orders

  @Get('orders')
  list(@CurrentUser() u: AuthUser, @ReqLocale() locale: Locale, @Query(new ZodPipe(listSchema)) q: z.infer<typeof listSchema>) {
    const { status, ...p } = q;
    return this.orders.listMine(u.id, p, locale, status as OrderStatus | undefined);
  }

  @Get('orders/:id')
  get(@CurrentUser() u: AuthUser, @ReqLocale() locale: Locale, @Param('id') id: string) {
    return this.orders.get(id, { userId: u.id }, locale);
  }

  @Post('orders/:id/cancel')
  cancel(@CurrentUser() u: AuthUser, @ReqLocale() locale: Locale, @Param('id') id: string, @Body(new ZodPipe(cancelSchema)) body: z.infer<typeof cancelSchema>) {
    return this.orders.cancelByCustomer(id, { userId: u.id }, body.reason, locale);
  }

  @Patch('orders/:id/address')
  address(@CurrentUser() u: AuthUser, @ReqLocale() locale: Locale, @Param('id') id: string, @Body(new ZodPipe(checkoutAddressSchema)) body: z.infer<typeof checkoutAddressSchema>) {
    return this.orders.updateAddress(id, { userId: u.id }, body, locale);
  }

  @Patch('orders/:id/items/:itemId/personalization')
  personalization(
    @CurrentUser() u: AuthUser,
    @CurrentActor() actor: Actor,
    @ReqLocale() locale: Locale,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body(new ZodPipe(personalizationSchema)) body: z.infer<typeof personalizationSchema>,
  ) {
    return this.orders.editPersonalization(id, { userId: u.id }, itemId, body.selections, actor, locale);
  }

  /** Printable HTML invoice. Fetch with the Authorization header and open the result in a new tab. */
  @Get('orders/:id/invoice')
  async invoice(@CurrentUser() u: AuthUser, @ReqLocale() locale: Locale, @Param('id') id: string, @Res() res: Response) {
    const html = await this.documents.invoiceHtml(id, locale, u.id);
    res.type('html').setHeader('Cache-Control', 'private, no-store');
    res.send(html);
  }

  // ---------------- guest tracking

  @Public()
  @RateLimit(10, 60)
  @Post('track-order')
  track(@ReqLocale() locale: Locale, @Body(new ZodPipe(trackSchema)) body: z.infer<typeof trackSchema>) {
    return this.orders.track(body.orderNumber, { email: body.email, phone: body.phone }, locale);
  }

  @Public()
  @RateLimit(5, 60)
  @Post('track-order/cancel')
  trackCancel(@ReqLocale() locale: Locale, @Body(new ZodPipe(trackCancelSchema)) body: z.infer<typeof trackCancelSchema>) {
    return this.orders.cancelByCustomer(body.orderNumber, { email: body.email }, body.reason, locale);
  }
}
