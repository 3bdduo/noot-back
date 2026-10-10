import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { z } from 'zod';
import { RequirePermissions } from '../../common/decorators.js';
import { ZodPipe } from '../../common/pipes/zod.pipe.js';
import { paginationSchema } from '../../common/utils/pagination.js';
import { CustomersService } from './customers.service.js';

const listSchema = paginationSchema.extend({
  search: z.string().trim().max(100).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
});
const statusSchema = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']) });

@Controller('admin/customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @RequirePermissions('customers.read')
  @Get()
  list(@Query(new ZodPipe(listSchema)) q: z.infer<typeof listSchema>) {
    const { page, pageSize, ...filters } = q;
    return this.customers.list(filters, { page, pageSize });
  }

  @RequirePermissions('customers.read')
  @Get(':id')
  detail(@Param('id') id: string) {
    return this.customers.detail(id);
  }

  @RequirePermissions('customers.update')
  @Patch(':id/status')
  setStatus(@Param('id') id: string, @Body(new ZodPipe(statusSchema)) body: z.infer<typeof statusSchema>) {
    return this.customers.setStatus(id, body.status);
  }
}
