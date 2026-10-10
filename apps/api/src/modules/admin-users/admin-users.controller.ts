import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, RequirePermissions } from '../../common/decorators.js';
import { ZodPipe } from '../../common/pipes/zod.pipe.js';
import { paginationSchema } from '../../common/utils/pagination.js';
import type { AuthUser } from '../../common/types.js';
import { AdminUsersService } from './admin-users.service.js';

const createAdminSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().min(1).max(60),
  roleKeys: z.array(z.string().max(40)).min(1).max(5),
});
const updateAdminSchema = z.object({
  roleKeys: z.array(z.string().max(40)).min(1).max(5).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
});
const rolePermissionsSchema = z.object({ permissions: z.array(z.string().max(60)).max(200) });
const listSchema = paginationSchema.extend({ search: z.string().trim().max(100).optional() });

@Controller('admin')
export class AdminUsersController {
  constructor(private readonly service: AdminUsersService) {}

  @RequirePermissions('roles.read')
  @Get('roles')
  roles() {
    return this.service.listRoles();
  }

  @RequirePermissions('roles.read')
  @Get('permissions')
  permissions() {
    return this.service.listPermissions();
  }

  @RequirePermissions('roles.update')
  @Put('roles/:key/permissions')
  setPermissions(@Param('key') key: string, @Body(new ZodPipe(rolePermissionsSchema)) body: z.infer<typeof rolePermissionsSchema>) {
    return this.service.setRolePermissions(key, body.permissions);
  }

  @RequirePermissions('admins.read')
  @Get('admins')
  list(@Query(new ZodPipe(listSchema)) q: z.infer<typeof listSchema>) {
    const { search, page, pageSize } = q;
    return this.service.listAdmins({ search }, { page, pageSize });
  }

  @RequirePermissions('admins.create')
  @Post('admins')
  create(@CurrentUser() actor: AuthUser, @Body(new ZodPipe(createAdminSchema)) body: z.infer<typeof createAdminSchema>) {
    return this.service.createAdmin(actor, body);
  }

  @RequirePermissions('admins.update')
  @Patch('admins/:id')
  update(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body(new ZodPipe(updateAdminSchema)) body: z.infer<typeof updateAdminSchema>) {
    return this.service.updateAdmin(actor, id, body);
  }

  @RequirePermissions('admins.delete')
  @Delete('admins/:id')
  demote(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    return this.service.demoteAdmin(actor, id);
  }

  @RequirePermissions('roles.update')
  @HttpCode(200)
  @Post('admins/:id/2fa/reset')
  resetTwoFactor(@Param('id') id: string) {
    return this.service.resetTwoFactor(id);
  }
}
