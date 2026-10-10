import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { PAYMENT_METHODS, PAYMENT_STATUSES } from '@nb/shared';
import { CurrentUser, Public, RateLimit, RequirePermissions } from '../../common/decorators.js';
import { AppError } from '../../common/errors/app-error.js';
import { safeEqual } from '../../common/crypto/tokens.js';
import { ZodPipe } from '../../common/pipes/zod.pipe.js';
import { paginationSchema } from '../../common/utils/pagination.js';
import type { AppRequest, AuthUser } from '../../common/types.js';
import { env } from '../../config/env.js';
import { esc } from '../../common/utils/html.js';
import { MockProvider, mockSign } from './mock.provider.js';
import { PaymentsService } from './payments.service.js';

const accessSchema = z.object({ email: z.string().trim().toLowerCase().email().optional() });
const listSchema = paginationSchema.extend({
  status: z.enum(PAYMENT_STATUSES).optional(),
  method: z.enum(PAYMENT_METHODS).optional(),
  q: z.string().trim().max(60).optional(),
});
const refundListSchema = paginationSchema.extend({ status: z.enum(['PENDING', 'COMPLETED', 'FAILED']).optional() });
const webhookListSchema = paginationSchema.extend({ status: z.enum(['RECEIVED', 'PROCESSED', 'FAILED', 'IGNORED']).optional() });
const refundSchema = z.object({ amount: z.number().int().min(1), reason: z.string().trim().max(300).optional(), orderItemId: z.string().max(64).optional() });
const completeSchema = z.object({ manualReference: z.string().trim().min(1).max(200).optional() });
const mockQuery = z.object({ ref: z.string().min(5).max(80), sig: z.string().min(10).max(128), order: z.string().max(60).optional() });
const mockCompleteQuery = z.object({ ref: z.string().min(5).max(80), result: z.enum(['PAID', 'FAILED']), sig: z.string().min(10).max(128) });

@Controller()
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Public()
  @Get('payments/methods')
  methods() {
    return this.payments.availableMethods();
  }

  /** Starts the hosted payment for a PENDING_PAYMENT order. Guests prove ownership with their email. */
  @Public()
  @RateLimit(10, 60)
  @Post('orders/:id/pay')
  pay(@CurrentUser() u: AuthUser | undefined, @Param('id') id: string, @Body(new ZodPipe(accessSchema)) body: z.infer<typeof accessSchema>) {
    return this.payments.initiate(id, this.access(u, body.email));
  }

  @Public()
  @RateLimit(60, 60)
  @Post('orders/:id/payment-status')
  status(@CurrentUser() u: AuthUser | undefined, @Param('id') id: string, @Body(new ZodPipe(accessSchema)) body: z.infer<typeof accessSchema>) {
    return this.payments.status(id, this.access(u, body.email));
  }

  private access(u: AuthUser | undefined, email?: string) {
    if (u) return { userId: u.id };
    if (email) return { email };
    throw AppError.unauthorized();
  }

  // ---------------- provider webhooks (signature-verified over the raw body; no auth header)

  @Public()
  @HttpCode(200)
  @Post('payments/webhooks/:provider')
  webhook(@Param('provider') provider: string, @Req() req: AppRequest) {
    if (!req.rawBody) throw AppError.badRequest('MALFORMED_JSON');
    return this.payments.handleWebhook(provider, req.rawBody, req.headers);
  }

  // ---------------- mock hosted page (only when PAYMENT_PROVIDER=mock)

  @Public()
  @Get('payments/mock/checkout')
  async mockCheckout(@Query(new ZodPipe(mockQuery)) q: z.infer<typeof mockQuery>, @Res() res: Response) {
    this.assertMock();
    if (!safeEqual(q.sig, mockSign(`checkout:${q.ref}`))) throw AppError.forbidden();
    const link = (result: 'PAID' | 'FAILED') => `/api/v1/payments/mock/complete?ref=${encodeURIComponent(q.ref)}&result=${result}&sig=${mockSign(`complete:${q.ref}:${result}`)}`;
    res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Mock payment</title>
      <body style="font-family:sans-serif;max-width:420px;margin:60px auto;text-align:center">
      <h2>Mock payment gateway</h2><p>Order ${esc(q.order ?? '')}<br><small>Development only — no real money</small></p>
      <p><a href="${link('PAID')}" style="display:block;padding:14px;background:#1a7f37;color:#fff;border-radius:6px;text-decoration:none;margin:10px 0">Pay successfully</a>
      <a href="${link('FAILED')}" style="display:block;padding:14px;background:#b42318;color:#fff;border-radius:6px;text-decoration:none">Fail the payment</a></p></body>`);
  }

  @Public()
  @Get('payments/mock/complete')
  async mockComplete(@Query(new ZodPipe(mockCompleteQuery)) q: z.infer<typeof mockCompleteQuery>, @Res() res: Response) {
    this.assertMock();
    if (!safeEqual(q.sig, mockSign(`complete:${q.ref}:${q.result}`))) throw AppError.forbidden();
    const payment = await this.payments.findByProviderRef('mock', q.ref);
    if (!payment) throw AppError.notFound();
    const { raw, headers } = MockProvider.buildSignedEvent(q.ref, q.result, payment.amount);
    await this.payments.handleWebhook('mock', raw, headers);
    res.redirect(302, `${env.APP_URL.replace(/\/$/, '')}/checkout/result?order=${encodeURIComponent(payment.order.orderNumber)}&status=${q.result === 'PAID' ? 'success' : 'failed'}`);
  }

  private assertMock() {
    if (env.PAYMENT_PROVIDER !== 'mock' || env.NODE_ENV === 'production') throw AppError.notFound();
  }
}

@Controller('admin')
export class PaymentsAdminController {
  constructor(private readonly payments: PaymentsService) {}

  @RequirePermissions('payments.read')
  @Get('payments')
  list(@Query(new ZodPipe(listSchema)) q: z.infer<typeof listSchema>) {
    const { page, pageSize, ...f } = q;
    return this.payments.listPayments(f, { page, pageSize });
  }

  @RequirePermissions('payments.read')
  @Get('payments/webhooks')
  webhooks(@Query(new ZodPipe(webhookListSchema)) q: z.infer<typeof webhookListSchema>) {
    const { page, pageSize, ...f } = q;
    return this.payments.listWebhooks(f, { page, pageSize });
  }

  @RequirePermissions('payments.read')
  @Get('refunds')
  refunds(@Query(new ZodPipe(refundListSchema)) q: z.infer<typeof refundListSchema>) {
    const { page, pageSize, ...f } = q;
    return this.payments.listRefunds(f, { page, pageSize });
  }

  @RequirePermissions('payments.refund')
  @HttpCode(201)
  @Post('orders/:id/refunds')
  request(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(refundSchema)) body: z.infer<typeof refundSchema>) {
    return this.payments.requestRefund(id, body, { type: 'ADMIN', id: u.id });
  }

  @RequirePermissions('payments.refund')
  @Post('refunds/:id/complete')
  complete(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(completeSchema)) body: z.infer<typeof completeSchema>) {
    return this.payments.completeRefund(id, { type: 'ADMIN', id: u.id }, body.manualReference);
  }

  @RequirePermissions('payments.refund')
  @Post('refunds/:id/cancel')
  cancel(@Param('id') id: string) {
    return this.payments.cancelRefund(id);
  }
}
