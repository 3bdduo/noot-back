import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { customizationInputSchema } from '@nb/shared';
import type { Locale } from '@nb/shared';
import { CurrentActor, CurrentUser, ReqLocale } from '../../common/decorators.js';
import { ZodPipe } from '../../common/pipes/zod.pipe.js';
import type { Actor, AuthUser } from '../../common/types.js';
import { WishlistService } from './wishlist.service.js';

const designSchema = z.object({
  productId: z.string().min(1).max(64),
  variantId: z.string().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(80),
  selections: customizationInputSchema,
});
const qtySchema = z.object({ quantity: z.number().int().min(1).max(50).optional() });

@Controller()
export class WishlistController {
  constructor(private readonly wishlist: WishlistService) {}

  @Get('wishlist')
  list(@CurrentUser() u: AuthUser, @ReqLocale() locale: Locale) {
    return this.wishlist.list(u.id, locale);
  }

  @HttpCode(201)
  @Post('wishlist/:productId')
  add(@CurrentUser() u: AuthUser, @ReqLocale() locale: Locale, @Param('productId') productId: string) {
    return this.wishlist.add(u.id, productId, locale);
  }

  @Delete('wishlist/:productId')
  remove(@CurrentUser() u: AuthUser, @ReqLocale() locale: Locale, @Param('productId') productId: string) {
    return this.wishlist.remove(u.id, productId, locale);
  }

  @Post('wishlist/:productId/move-to-cart')
  moveToCart(@CurrentActor() actor: Actor, @ReqLocale() locale: Locale, @Param('productId') productId: string) {
    return this.wishlist.moveToCart(actor, productId, locale);
  }

  @Get('account/designs')
  designs(@CurrentUser() u: AuthUser, @ReqLocale() locale: Locale) {
    return this.wishlist.listDesigns(u.id, locale);
  }

  @HttpCode(201)
  @Post('account/designs')
  saveDesign(
    @CurrentUser() u: AuthUser,
    @CurrentActor() actor: Actor,
    @ReqLocale() locale: Locale,
    @Body(new ZodPipe(designSchema)) body: z.infer<typeof designSchema>,
  ) {
    return this.wishlist.saveDesign(u.id, body, actor, locale);
  }

  @Delete('account/designs/:id')
  deleteDesign(@CurrentUser() u: AuthUser, @ReqLocale() locale: Locale, @Param('id') id: string) {
    return this.wishlist.deleteDesign(u.id, id, locale);
  }

  @Post('account/designs/:id/add-to-cart')
  designToCart(
    @CurrentActor() actor: Actor,
    @ReqLocale() locale: Locale,
    @Param('id') id: string,
    @Body(new ZodPipe(qtySchema)) body: z.infer<typeof qtySchema>,
  ) {
    return this.wishlist.designToCart(actor, id, body.quantity ?? 1, locale);
  }
}
