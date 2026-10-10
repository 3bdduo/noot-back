import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { RequirePermissions } from '../../common/decorators.js';
import { ZodPipe } from '../../common/pipes/zod.pipe.js';
import { paginationSchema } from '../../common/utils/pagination.js';
import { CouponsService } from './coupons.service.js';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const listSchema = paginationSchema.extend({ q: z.string().trim().max(60).optional(), active: bool.optional() });

const createSchema = z.object({
  code: z.string().trim().min(3).max(40).regex(/^[A-Za-z0-9_-]+$/, { message: 'INVALID_CODE' }),
  type: z.enum(['PERCENTAGE', 'FIXED']),
  /** PERCENTAGE: basis points (1000 = 10%). FIXED: piasters. */
  value: z.number().int().min(1).max(100_000_000),
  minSubtotal: z.number().int().min(0).nullable().optional(),
  maxDiscount: z.number().int().min(0).nullable().optional(),
  startsAt: z.coerce.date().nullable().optional(),
  endsAt: z.coerce.date().nullable().optional(),
  usageLimit: z.number().int().min(1).nullable().optional(),
  perUserLimit: z.number().int().min(1).nullable().optional(),
  active: z.boolean().optional(),
  appliesToAll: z.boolean().optional(),
  description: z.string().trim().max(300).nullable().optional(),
  productIds: z.array(z.string().max(64)).max(500).optional(),
  collectionIds: z.array(z.string().max(64)).max(100).optional(),
});
const updateSchema = createSchema.omit({ code: true }).partial();

@Controller('admin/coupons')
export class CouponsController {
  constructor(private readonly coupons: CouponsService) {}

  @RequirePermissions('coupons.read')
  @Get()
  list(@Query(new ZodPipe(listSchema)) q: z.infer<typeof listSchema>) {
    const { page, pageSize, ...filters } = q;
    return this.coupons.list(filters, { page, pageSize });
  }

  @RequirePermissions('coupons.read')
  @Get(':id')
  get(@Param('id') id: string) {
    return this.coupons.get(id);
  }

  @RequirePermissions('coupons.read')
  @Get(':id/usages')
  usages(@Param('id') id: string, @Query(new ZodPipe(paginationSchema)) q: z.infer<typeof paginationSchema>) {
    return this.coupons.usages(id, q);
  }

  @RequirePermissions('coupons.create')
  @Post()
  create(@Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>) {
    return this.coupons.create(body);
  }

  @RequirePermissions('coupons.update')
  @Patch(':id')
  update(@Param('id') id: string, @Body(new ZodPipe(updateSchema)) body: z.infer<typeof updateSchema>) {
    return this.coupons.update(id, body);
  }

  @RequirePermissions('coupons.delete')
  @Delete(':id')
  deactivate(@Param('id') id: string) {
    return this.coupons.deactivate(id);
  }
}
