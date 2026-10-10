import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { GOVERNORATE_CODES, customizationInputSchema } from '@nb/shared';
import type { Locale } from '@nb/shared';
import { CurrentActor, CurrentUser, Public, RateLimit, ReqLocale } from '../../common/decorators.js';
import { guestHashFrom } from '../../common/http.js';
import { randomToken } from '../../common/crypto/tokens.js';
import { ZodPipe } from '../../common/pipes/zod.pipe.js';
import type { Actor, AppRequest, AuthUser } from '../../common/types.js';
import { MAX_LINE_QUANTITY, CartService } from './cart.service.js';

const viewQuery = z.object({ governorate: z.enum(GOVERNORATE_CODES).optional() });
const addSchema = z.object({
  productId: z.string().min(1).max(64),
  variantId: z.string().min(1).max(64).optional(),
  quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY),
  customization: customizationInputSchema.optional(),
});
const patchSchema = z
  .object({
    quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY).optional(),
    savedForLater: z.boolean().optional(),
  })
  .refine((v) => v.quantity !== undefined || v.savedForLater !== undefined, { message: 'VALIDATION_ERROR' });
const couponSchema = z.object({ code: z.string().trim().min(1).max(40) });
const giftSchema = z.object({
  recipientName: z.string().trim().max(80).optional(),
  senderName: z.string().trim().max(80).optional(),
  message: z.string().trim().min(1).max(500),
  hidePrices: z.boolean().optional(),
});

@Controller('cart')
export class CartController {
  constructor(private readonly cart: CartService) {}

  /**
   * Issues an anonymous visitor token. The frontend stores it and sends it as `x-guest-token`
   * on every cart/checkout/upload request. Only its hash is ever stored server-side.
   */
  @Public()
  @RateLimit(30, 60)
  @HttpCode(201)
  @Post('session')
  session() {
    return { guestToken: randomToken(32) };
  }

  @Public()
  @Get()
  view(@CurrentActor() actor: Actor, @ReqLocale() locale: Locale, @Query(new ZodPipe(viewQuery)) q: z.infer<typeof viewQuery>) {
    return this.cart.view(actor, locale, q);
  }

  @Public()
  @RateLimit(60, 60)
  @HttpCode(201)
  @Post('items')
  add(@CurrentActor() actor: Actor, @ReqLocale() locale: Locale, @Body(new ZodPipe(addSchema)) body: z.infer<typeof addSchema>) {
    return this.cart.addItem(actor, body, locale);
  }

  @Public()
  @Patch('items/:id')
  update(
    @CurrentActor() actor: Actor,
    @ReqLocale() locale: Locale,
    @Param('id') id: string,
    @Body(new ZodPipe(patchSchema)) body: z.infer<typeof patchSchema>,
  ) {
    return this.cart.updateItem(actor, id, body, locale);
  }

  @Public()
  @Delete('items/:id')
  remove(@CurrentActor() actor: Actor, @ReqLocale() locale: Locale, @Param('id') id: string) {
    return this.cart.removeItem(actor, id, locale);
  }

  @Public()
  @Delete()
  clear(@CurrentActor() actor: Actor, @ReqLocale() locale: Locale) {
    return this.cart.clear(actor, locale);
  }

  @Public()
  @RateLimit(20, 60)
  @Post('coupon')
  applyCoupon(@CurrentActor() actor: Actor, @ReqLocale() locale: Locale, @Body(new ZodPipe(couponSchema)) body: z.infer<typeof couponSchema>) {
    return this.cart.applyCoupon(actor, body.code, locale);
  }

  @Public()
  @Delete('coupon')
  removeCoupon(@CurrentActor() actor: Actor, @ReqLocale() locale: Locale) {
    return this.cart.removeCoupon(actor, locale);
  }

  @Public()
  @Put('gift')
  setGift(@CurrentActor() actor: Actor, @ReqLocale() locale: Locale, @Body(new ZodPipe(giftSchema)) body: z.infer<typeof giftSchema>) {
    return this.cart.setGift(actor, body, locale);
  }

  @Public()
  @Delete('gift')
  removeGift(@CurrentActor() actor: Actor, @ReqLocale() locale: Locale) {
    return this.cart.removeGift(actor, locale);
  }

  /** Call right after login/registration: folds the guest cart (from `x-guest-token`) into the account cart. */
  @Post('merge')
  merge(@CurrentUser() user: AuthUser, @Req() req: AppRequest, @ReqLocale() locale: Locale) {
    return this.cart.mergeGuestCart(user.id, guestHashFrom(req), locale);
  }
}
