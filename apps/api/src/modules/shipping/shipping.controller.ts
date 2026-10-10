import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { GOVERNORATE_CODES } from '@nb/shared';
import type { Locale } from '@nb/shared';
import { Public, ReqLocale, RequirePermissions } from '../../common/decorators.js';
import { ZodPipe } from '../../common/pipes/zod.pipe.js';
import { ShippingService } from './shipping.service.js';

const quoteQuery = z.object({
  governorate: z.enum(GOVERNORATE_CODES),
  /** subtotal after discounts, piasters (used for the free-shipping threshold) */
  subtotal: z.coerce.number().int().min(0).default(0),
});
const zoneCreate = z.object({
  nameAr: z.string().trim().min(1).max(100),
  nameEn: z.string().trim().min(1).max(100),
  estimatedDaysMin: z.number().int().min(0).max(60).optional(),
  estimatedDaysMax: z.number().int().min(0).max(60).optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});
const zoneUpdate = zoneCreate.partial();
const govSchema = z.object({ codes: z.array(z.string().max(5)).max(27) });
const rateCreate = z.object({
  name: z.string().trim().min(1).max(100),
  baseFee: z.number().int().min(0).max(10_000_000),
  freeOverSubtotal: z.number().int().min(0).nullable().optional(),
  codAvailable: z.boolean().optional(),
  active: z.boolean().optional(),
});
const rateUpdate = rateCreate.partial();

@Controller()
export class ShippingController {
  constructor(private readonly shipping: ShippingService) {}

  @Public()
  @Get('shipping/governorates')
  governorates(@ReqLocale() locale: Locale) {
    return this.shipping.governorates(locale);
  }

  @Public()
  @Get('shipping/quote')
  quote(@Query(new ZodPipe(quoteQuery)) q: z.infer<typeof quoteQuery>) {
    return this.shipping.quote(q.governorate, q.subtotal);
  }

  @RequirePermissions('shipping.read')
  @Get('admin/shipping/zones')
  zones() {
    return this.shipping.listZones();
  }

  @RequirePermissions('shipping.update')
  @Post('admin/shipping/zones')
  createZone(@Body(new ZodPipe(zoneCreate)) body: z.infer<typeof zoneCreate>) {
    return this.shipping.createZone(body);
  }

  @RequirePermissions('shipping.update')
  @Patch('admin/shipping/zones/:id')
  updateZone(@Param('id') id: string, @Body(new ZodPipe(zoneUpdate)) body: z.infer<typeof zoneUpdate>) {
    return this.shipping.updateZone(id, body);
  }

  @RequirePermissions('shipping.update')
  @Delete('admin/shipping/zones/:id')
  deleteZone(@Param('id') id: string) {
    return this.shipping.deleteZone(id);
  }

  @RequirePermissions('shipping.update')
  @Put('admin/shipping/zones/:id/governorates')
  setGovernorates(@Param('id') id: string, @Body(new ZodPipe(govSchema)) body: z.infer<typeof govSchema>) {
    return this.shipping.setZoneGovernorates(id, body.codes);
  }

  @RequirePermissions('shipping.update')
  @HttpCode(201)
  @Post('admin/shipping/zones/:id/rates')
  createRate(@Param('id') id: string, @Body(new ZodPipe(rateCreate)) body: z.infer<typeof rateCreate>) {
    return this.shipping.createRate(id, body);
  }

  @RequirePermissions('shipping.update')
  @Patch('admin/shipping/rates/:id')
  updateRate(@Param('id') id: string, @Body(new ZodPipe(rateUpdate)) body: z.infer<typeof rateUpdate>) {
    return this.shipping.updateRate(id, body);
  }

  @RequirePermissions('shipping.update')
  @Delete('admin/shipping/rates/:id')
  deleteRate(@Param('id') id: string) {
    return this.shipping.deleteRate(id);
  }
}
