import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { Public, RequirePermissions } from '../../common/decorators.js';
import { SettingsService } from './settings.service.js';

@Controller()
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Public()
  @Get('settings/public')
  publicSettings() {
    return this.settings.publicSettings();
  }

  @RequirePermissions('settings.read')
  @Get('admin/settings')
  all() {
    return this.settings.all();
  }

  @RequirePermissions('settings.update')
  @Put('admin/settings/:key')
  async update(@Param('key') key: string, @Body() body: unknown) {
    return { key, value: await this.settings.set(key, body) };
  }
}
