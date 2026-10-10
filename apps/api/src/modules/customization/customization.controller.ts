import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import type { z } from 'zod';
import { Public, RequirePermissions, ReqLocale } from '../../common/decorators.js';
import { ZodPipe } from '../../common/pipes/zod.pipe.js';
import { AppError } from '../../common/errors/app-error.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CustomizationService } from './customization.service.js';
import {
  createGroupSchema,
  createOptionSchema,
  listGroupsQuerySchema,
  productGroupsSchema,
  updateGroupSchema,
  updateOptionSchema,
} from './customization.schemas.js';
import type { Locale } from '@nb/shared';

@Controller()
export class CustomizationController {
  constructor(
    private readonly customization: CustomizationService,
    private readonly prisma: PrismaService,
  ) {}

  // ---------------------------------------------------------------- public

  /** Everything the customizer UI needs for a product: steps -> groups -> options (+ rules, prices, preview layers). */
  @Public()
  @Get('products/:slug/customizer')
  async config(@Param('slug') slug: string, @ReqLocale() locale: Locale) {
    const product = await this.prisma.product.findFirst({
      where: { slug, status: 'ACTIVE', deletedAt: null },
      select: { id: true, isCustomizable: true },
    });
    if (!product) throw AppError.notFound('PRODUCT_NOT_FOUND');
    return this.customization.publicConfig(product.id, locale);
  }

  // ---------------------------------------------------------------- admin: groups

  @RequirePermissions('customizations.read')
  @Get('admin/customization-groups')
  list(@Query(new ZodPipe(listGroupsQuerySchema)) q: z.infer<typeof listGroupsQuerySchema>) {
    return this.customization.listGroups(q);
  }

  @RequirePermissions('customizations.read')
  @Get('admin/customization-groups/:id')
  get(@Param('id') id: string) {
    return this.customization.getGroup(id);
  }

  @RequirePermissions('customizations.create')
  @Post('admin/customization-groups')
  create(@Body(new ZodPipe(createGroupSchema)) body: z.infer<typeof createGroupSchema>) {
    return this.customization.createGroup(body);
  }

  @RequirePermissions('customizations.update')
  @Patch('admin/customization-groups/:id')
  update(@Param('id') id: string, @Body(new ZodPipe(updateGroupSchema)) body: z.infer<typeof updateGroupSchema>) {
    return this.customization.updateGroup(id, body);
  }

  @RequirePermissions('customizations.delete')
  @Delete('admin/customization-groups/:id')
  remove(@Param('id') id: string) {
    return this.customization.deleteGroup(id);
  }

  // ---------------------------------------------------------------- admin: options

  @RequirePermissions('customizations.create')
  @Post('admin/customization-groups/:id/options')
  createOption(@Param('id') id: string, @Body(new ZodPipe(createOptionSchema)) body: z.infer<typeof createOptionSchema>) {
    return this.customization.createOption(id, body);
  }

  @RequirePermissions('customizations.update')
  @Patch('admin/customization-options/:id')
  updateOption(@Param('id') id: string, @Body(new ZodPipe(updateOptionSchema)) body: z.infer<typeof updateOptionSchema>) {
    return this.customization.updateOption(id, body);
  }

  @RequirePermissions('customizations.delete')
  @Delete('admin/customization-options/:id')
  removeOption(@Param('id') id: string) {
    return this.customization.deleteOption(id);
  }

  // ---------------------------------------------------------------- admin: product links

  @RequirePermissions('customizations.read')
  @Get('admin/products/:id/customization-groups')
  productGroups(@Param('id') id: string) {
    return this.customization.getProductGroups(id);
  }

  @RequirePermissions('customizations.update')
  @Put('admin/products/:id/customization-groups')
  setProductGroups(@Param('id') id: string, @Body(new ZodPipe(productGroupsSchema)) body: z.infer<typeof productGroupsSchema>) {
    return this.customization.setProductGroups(id, body);
  }
}
