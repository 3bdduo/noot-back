import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Locale } from '@nb/shared';
import { CurrentUser, Public, RateLimit, ReqLocale, RequirePermissions } from '../../common/decorators.js';
import { ZodPipe } from '../../common/pipes/zod.pipe.js';
import { paginationSchema } from '../../common/utils/pagination.js';
import type { AuthUser } from '../../common/types.js';
import { InventoryService } from './inventory.service.js';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const listSchema = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  lowStock: bool.optional(),
  kind: z.enum(['variant', 'option']).optional(),
});
const createSchema = z.object({
  variantId: z.string().max(64).optional(),
  optionId: z.string().max(64).optional(),
  quantity: z.number().int().min(0).max(1_000_000),
  lowStockThreshold: z.number().int().min(0).max(100_000).optional(),
  trackInventory: z.boolean().optional(),
  allowBackorder: z.boolean().optional(),
});
const adjustSchema = z.object({
  mode: z.enum(['SET', 'DELTA']),
  quantity: z.number().int().min(-1_000_000).max(1_000_000),
  reason: z.string().trim().min(2).max(200),
});
const settingsSchema = z.object({
  lowStockThreshold: z.number().int().min(0).max(100_000).optional(),
  trackInventory: z.boolean().optional(),
  allowBackorder: z.boolean().optional(),
});
const notifySchema = z.object({ email: z.string().trim().toLowerCase().email().max(254) });

@Controller()
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @RequirePermissions('inventory.read')
  @Get('admin/inventory')
  list(@Query(new ZodPipe(listSchema)) q: z.infer<typeof listSchema>) {
    const { page, pageSize, ...filters } = q;
    return this.inventory.list(filters, { page, pageSize });
  }

  @RequirePermissions('inventory.read')
  @Get('admin/inventory/:id/movements')
  movements(@Param('id') id: string, @Query(new ZodPipe(paginationSchema)) q: z.infer<typeof paginationSchema>) {
    return this.inventory.movements(id, q);
  }

  @RequirePermissions('inventory.update')
  @Post('admin/inventory')
  create(@Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>, @CurrentUser() user: AuthUser) {
    return this.inventory.createItem(body, user.id);
  }

  @RequirePermissions('inventory.update')
  @HttpCode(200)
  @Post('admin/inventory/:id/adjust')
  adjust(@Param('id') id: string, @Body(new ZodPipe(adjustSchema)) body: z.infer<typeof adjustSchema>, @CurrentUser() user: AuthUser) {
    return this.inventory.adjust(id, body, user.id);
  }

  @RequirePermissions('inventory.update')
  @Patch('admin/inventory/:id')
  settings(@Param('id') id: string, @Body(new ZodPipe(settingsSchema)) body: z.infer<typeof settingsSchema>) {
    return this.inventory.updateSettings(id, body);
  }

  /** "Notify me when it is back" for sold-out products (works for guests). */
  @Public()
  @RateLimit(10, 3600)
  @HttpCode(200)
  @Post('products/:slug/notify-me')
  notifyMe(@Param('slug') slug: string, @Body(new ZodPipe(notifySchema)) body: z.infer<typeof notifySchema>, @ReqLocale() locale: Locale) {
    return this.inventory.subscribeBackInStock(slug, body.email, locale);
  }
}
