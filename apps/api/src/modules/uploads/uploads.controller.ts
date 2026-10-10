import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentActor, Public, RateLimit, RequireAnyPermission } from '../../common/decorators.js';
import { AppError } from '../../common/errors/app-error.js';
import { ZodPipe } from '../../common/pipes/zod.pipe.js';
import type { Actor, AppRequest } from '../../common/types.js';
import { LocalDriver, localPath, verifyLocal } from './storage.driver.js';
import { MAX_ARTWORK_BYTES, UploadsService } from './uploads.service.js';
import { readFile } from 'node:fs/promises';
import { detectType } from './file-checks.js';

const presignSchema = z.object({
  groupCode: z.string().min(1).max(64).optional(),
  fileName: z.string().trim().min(1).max(200),
  mimeType: z.string().trim().min(3).max(100),
  sizeBytes: z.number().int().min(1).max(MAX_ARTWORK_BYTES),
});
const mediaPresignSchema = z.object({
  folder: z.enum(['products', 'options', 'content', 'reviews']),
  fileName: z.string().trim().min(1).max(200),
  mimeType: z.string().trim().min(3).max(100),
  sizeBytes: z.number().int().min(1).max(8 * 1024 * 1024),
});
const mediaCompleteSchema = z.object({ key: z.string().min(1).max(300) });
const localQuery = z.object({ key: z.string().min(1).max(400), exp: z.coerce.number(), sig: z.string().min(10).max(128) });

const MEDIA_PERMS = ['products.update', 'products.create', 'content.create', 'content.update', 'customizations.update', 'collections.update'] as const;

@Controller()
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  // ---------------- customer artwork

  @Public()
  @RateLimit(40, 60)
  @HttpCode(201)
  @Post('uploads/artwork/presign')
  presign(@CurrentActor() actor: Actor, @Body(new ZodPipe(presignSchema)) body: z.infer<typeof presignSchema>) {
    return this.uploads.presignArtwork(actor, body);
  }

  @Public()
  @RateLimit(40, 60)
  @Post('uploads/artwork/:id/complete')
  complete(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.uploads.completeArtwork(actor, id);
  }

  @Public()
  @Get('uploads/artwork/:id')
  get(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.uploads.getArtwork(actor, id);
  }

  @Public()
  @Delete('uploads/artwork/:id')
  remove(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.uploads.deleteArtwork(actor, id);
  }

  // ---------------- admin

  @RequireAnyPermission('orders.read', 'customizations.read')
  @Get('admin/artwork/:id')
  adminArtwork(@Param('id') id: string) {
    return this.uploads.adminArtworkLinks(id);
  }

  @RequireAnyPermission(...MEDIA_PERMS)
  @HttpCode(201)
  @Post('admin/uploads/media/presign')
  presignMedia(@Body(new ZodPipe(mediaPresignSchema)) body: z.infer<typeof mediaPresignSchema>) {
    return this.uploads.presignMedia(body);
  }

  @RequireAnyPermission(...MEDIA_PERMS)
  @Post('admin/uploads/media/complete')
  completeMedia(@Body(new ZodPipe(mediaCompleteSchema)) body: z.infer<typeof mediaCompleteSchema>) {
    return this.uploads.completeMedia(body.key);
  }

  // ---------------- local dev storage (only active when R2 is not configured)

  @Public()
  @Put('uploads/local/put')
  async localPut(@Query(new ZodPipe(localQuery)) q: z.infer<typeof localQuery>, @Req() req: AppRequest) {
    this.assertLocal();
    if (!verifyLocal('put', q.key, q.exp, q.sig)) throw AppError.forbidden();
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      total += (chunk as Buffer).length;
      if (total > MAX_ARTWORK_BYTES) throw new AppError(413, 'PAYLOAD_TOO_LARGE');
      chunks.push(chunk as Buffer);
    }
    await this.uploads.storage.put(q.key, Buffer.concat(chunks), 'application/octet-stream');
    return { ok: true };
  }

  @Public()
  @Get('uploads/local/get')
  async localGet(@Query(new ZodPipe(localQuery)) q: z.infer<typeof localQuery>, @Res() res: Response) {
    this.assertLocal();
    if (!verifyLocal('get', q.key, q.exp, q.sig)) throw AppError.forbidden();
    const bytes = await readFile(localPath(q.key)).catch(() => null);
    if (!bytes) throw AppError.notFound();
    res.setHeader('Content-Type', detectType(bytes) ?? 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.end(bytes);
  }

  private assertLocal() {
    if (!(this.uploads.storage instanceof LocalDriver)) throw AppError.notFound();
  }
}
