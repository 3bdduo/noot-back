import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { RequirePermissions } from '../../common/decorators.js';
import { ZodPipe } from '../../common/pipes/zod.pipe.js';
import { AnalyticsService } from './analytics.service.js';

const rangeSchema = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() });
type RangeQuery = z.infer<typeof rangeSchema>;

@Controller('admin/analytics')
@RequirePermissions('analytics.read')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('overview')
  overview(@Query(new ZodPipe(rangeSchema)) q: RangeQuery) {
    return this.analytics.overview(this.analytics.resolveRange(q.from, q.to));
  }

  @Get('sales-by-day')
  salesByDay(@Query(new ZodPipe(rangeSchema)) q: RangeQuery) {
    return this.analytics.salesByDay(this.analytics.resolveRange(q.from, q.to));
  }

  @Get('top-products')
  topProducts(@Query(new ZodPipe(rangeSchema)) q: RangeQuery) {
    return this.analytics.topProducts(this.analytics.resolveRange(q.from, q.to));
  }

  @Get('customization-popularity')
  customization(@Query(new ZodPipe(rangeSchema)) q: RangeQuery) {
    return this.analytics.customizationPopularity(this.analytics.resolveRange(q.from, q.to));
  }

  @Get('governorates')
  governorates(@Query(new ZodPipe(rangeSchema)) q: RangeQuery) {
    return this.analytics.byGovernorate(this.analytics.resolveRange(q.from, q.to));
  }

  @Get('payment-methods')
  paymentMethods(@Query(new ZodPipe(rangeSchema)) q: RangeQuery) {
    return this.analytics.byPaymentMethod(this.analytics.resolveRange(q.from, q.to));
  }

  @Get('coupons')
  coupons(@Query(new ZodPipe(rangeSchema)) q: RangeQuery) {
    return this.analytics.couponPerformance(this.analytics.resolveRange(q.from, q.to));
  }

  @Get('operations')
  operations() {
    return this.analytics.operations();
  }
}
