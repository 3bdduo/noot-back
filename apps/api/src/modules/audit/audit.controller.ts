import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { RequirePermissions } from '../../common/decorators.js';
import { ZodPipe } from '../../common/pipes/zod.pipe.js';
import { paginationSchema } from '../../common/utils/pagination.js';
import { AuditService } from './audit.service.js';

const querySchema = paginationSchema.extend({
  actorId: z.string().max(64).optional(),
  entity: z.string().max(100).optional(),
  entityId: z.string().max(100).optional(),
  action: z.string().max(100).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

@Controller('admin/audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @RequirePermissions('audit.read')
  @Get()
  list(@Query(new ZodPipe(querySchema)) q: z.infer<typeof querySchema>) {
    const { page, pageSize, ...filters } = q;
    return this.audit.list(filters, { page, pageSize });
  }
}
