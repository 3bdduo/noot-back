import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import type { z } from 'zod';
import type { Locale } from '@nb/shared';
import { CurrentActor, CurrentUser, Public, RateLimit, ReqLocale, RequirePermissions } from '../../common/decorators.js';
import { ZodPipe } from '../../common/pipes/zod.pipe.js';
import type { Actor, AuthUser } from '../../common/types.js';
import { AdminCatalogService } from './admin-catalog.service.js';
import { CatalogService } from './catalog.service.js';
import {
  adminListProductsQuerySchema,
  categoryInputSchema,
  collectionInputSchema,
  createProductSchema,
  listProductsQuerySchema,
  quoteSchema,
  updateCategorySchema,
  updateCollectionSchema,
  updateProductSchema,
} from './catalog.schemas.js';

@Controller()
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly admin: AdminCatalogService,
  ) {}

  // ---------------------------------------------------------------- storefront

  @Public()
  @Get('products')
  products(@Query(new ZodPipe(listProductsQuerySchema)) q: z.infer<typeof listProductsQuerySchema>, @ReqLocale() locale: Locale) {
    return this.catalog.listProducts(q, locale);
  }

  @Public()
  @Get('products/:slug')
  product(@Param('slug') slug: string, @ReqLocale() locale: Locale) {
    return this.catalog.getProduct(slug, locale);
  }

  @Public()
  @RateLimit(120, 60)
  @HttpCode(200)
  @Post('products/:slug/quote')
  quote(@Param('slug') slug: string, @Body(new ZodPipe(quoteSchema)) body: z.infer<typeof quoteSchema>, @CurrentActor() actor: Actor) {
    return this.catalog.quote(slug, body, actor);
  }

  @Public()
  @Get('categories')
  categories(@ReqLocale() locale: Locale) {
    return this.catalog.listCategories(locale);
  }

  @Public()
  @Get('collections')
  collections(@ReqLocale() locale: Locale) {
    return this.catalog.listCollections(locale);
  }

  @Public()
  @Get('collections/:slug')
  collection(@Param('slug') slug: string, @ReqLocale() locale: Locale) {
    return this.catalog.getCollection(slug, locale);
  }

  @Public()
  @Get('shop/filters')
  filters(@ReqLocale() locale: Locale) {
    return this.catalog.shopFilters(locale);
  }

  // ---------------------------------------------------------------- admin: products

  @RequirePermissions('products.read')
  @Get('admin/products')
  adminProducts(@Query(new ZodPipe(adminListProductsQuerySchema)) q: z.infer<typeof adminListProductsQuerySchema>) {
    const { page, pageSize, ...filters } = q;
    return this.admin.listProducts(filters, { page, pageSize });
  }

  @RequirePermissions('products.read')
  @Get('admin/products/:id')
  adminProduct(@Param('id') id: string) {
    return this.admin.getProduct(id);
  }

  @RequirePermissions('products.create')
  @Post('admin/products')
  create(@Body(new ZodPipe(createProductSchema)) body: z.infer<typeof createProductSchema>, @CurrentUser() user: AuthUser) {
    return this.admin.createProduct(body, user.id);
  }

  @RequirePermissions('products.update')
  @Patch('admin/products/:id')
  update(@Param('id') id: string, @Body(new ZodPipe(updateProductSchema)) body: z.infer<typeof updateProductSchema>, @CurrentUser() user: AuthUser) {
    return this.admin.updateProduct(id, body, user.id);
  }

  @RequirePermissions('products.delete')
  @Delete('admin/products/:id')
  archive(@Param('id') id: string) {
    return this.admin.archiveProduct(id);
  }

  // ---------------------------------------------------------------- admin: categories & collections

  @RequirePermissions('categories.read')
  @Get('admin/categories')
  adminCategories() {
    return this.admin.listCategories();
  }

  @RequirePermissions('categories.create')
  @Post('admin/categories')
  createCategory(@Body(new ZodPipe(categoryInputSchema)) body: z.infer<typeof categoryInputSchema>) {
    return this.admin.createCategory(body);
  }

  @RequirePermissions('categories.update')
  @Patch('admin/categories/:id')
  updateCategory(@Param('id') id: string, @Body(new ZodPipe(updateCategorySchema)) body: z.infer<typeof updateCategorySchema>) {
    return this.admin.updateCategory(id, body);
  }

  @RequirePermissions('categories.delete')
  @Delete('admin/categories/:id')
  deleteCategory(@Param('id') id: string) {
    return this.admin.deleteCategory(id);
  }

  @RequirePermissions('collections.read')
  @Get('admin/collections')
  adminCollections() {
    return this.admin.listCollections();
  }

  @RequirePermissions('collections.create')
  @Post('admin/collections')
  createCollection(@Body(new ZodPipe(collectionInputSchema)) body: z.infer<typeof collectionInputSchema>) {
    return this.admin.createCollection(body);
  }

  @RequirePermissions('collections.update')
  @Patch('admin/collections/:id')
  updateCollection(@Param('id') id: string, @Body(new ZodPipe(updateCollectionSchema)) body: z.infer<typeof updateCollectionSchema>) {
    return this.admin.updateCollection(id, body);
  }

  @RequirePermissions('collections.delete')
  @Delete('admin/collections/:id')
  deleteCollection(@Param('id') id: string) {
    return this.admin.deleteCollection(id);
  }
}
