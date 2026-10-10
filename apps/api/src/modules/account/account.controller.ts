import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import type { z } from 'zod';
import { CurrentUser } from '../../common/decorators.js';
import { ZodPipe } from '../../common/pipes/zod.pipe.js';
import type { AuthUser } from '../../common/types.js';
import { AccountService } from './account.service.js';
import { addressSchema, deleteAccountSchema, updateAddressSchema, updateProfileSchema } from './account.schemas.js';

@Controller('account')
export class AccountController {
  constructor(private readonly account: AccountService) {}

  @Get('profile')
  profile(@CurrentUser() user: AuthUser) {
    return this.account.getProfile(user.id);
  }

  @Patch('profile')
  updateProfile(@CurrentUser() user: AuthUser, @Body(new ZodPipe(updateProfileSchema)) body: z.infer<typeof updateProfileSchema>) {
    return this.account.updateProfile(user.id, body);
  }

  @Get('addresses')
  addresses(@CurrentUser() user: AuthUser) {
    return this.account.listAddresses(user.id);
  }

  @Post('addresses')
  createAddress(@CurrentUser() user: AuthUser, @Body(new ZodPipe(addressSchema)) body: z.infer<typeof addressSchema>) {
    return this.account.createAddress(user.id, body);
  }

  @Patch('addresses/:id')
  updateAddress(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodPipe(updateAddressSchema)) body: z.infer<typeof updateAddressSchema>,
  ) {
    return this.account.updateAddress(user.id, id, body);
  }

  @Delete('addresses/:id')
  async deleteAddress(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.account.deleteAddress(user.id, id);
    return { ok: true };
  }

  @HttpCode(200)
  @Post('export')
  exportData(@CurrentUser() user: AuthUser) {
    return this.account.exportData(user.id);
  }

  @HttpCode(200)
  @Post('delete')
  async deleteAccount(@CurrentUser() user: AuthUser, @Body(new ZodPipe(deleteAccountSchema)) body: z.infer<typeof deleteAccountSchema>) {
    await this.account.deleteAccount(user.id, body.password);
    return { ok: true };
  }
}
