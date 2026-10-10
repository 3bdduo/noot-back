import { Inject, Injectable } from '@nestjs/common';
import sharp from 'sharp';
import { ALLOWED_ARTWORK_MIME_TYPES } from '@nb/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AppError } from '../../common/errors/app-error.js';
import type { Actor } from '../../common/types.js';
import { randomToken } from '../../common/crypto/tokens.js';
import { logEvent } from '../../common/logger.js';
import { SettingsService } from '../settings/settings.service.js';
import { STORAGE_DRIVER } from './storage.driver.js';
import type { StorageDriver } from './storage.driver.js';
import { detectType, extensionFor, pdfLooksUnsafe, safeFileStem } from './file-checks.js';

export const MAX_ARTWORK_BYTES = 15 * 1024 * 1024;
export const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
const MEDIA_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/avif'];
const MAX_PIXELS = 100_000_000;
const MAX_PENDING_PER_HOUR = 30;
const DOWNLOAD_TTL_SEC = 600;

export interface PresignArtworkInput {
  groupCode?: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

@Injectable()
export class UploadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    @Inject(STORAGE_DRIVER) readonly storage: StorageDriver,
  ) {}

  // ---------------------------------------------------------------- customer artwork

  private ownerWhere(actor: Actor) {
    if (actor.userId) return { userId: actor.userId };
    if (actor.guestHash) return { guestToken: actor.guestHash };
    throw AppError.badRequest('CART_SESSION_REQUIRED');
  }

  async presignArtwork(actor: Actor, input: PresignArtworkInput) {
    const owner = this.ownerWhere(actor);

    const group = input.groupCode
      ? await this.prisma.customizationGroup.findFirst({ where: { code: input.groupCode, type: 'FILE', active: true, deletedAt: null } })
      : null;
    if (input.groupCode && !group) throw AppError.notFound('CUSTOM_UNKNOWN_GROUP');

    const allowed = group?.allowedMimeTypes?.length ? group.allowedMimeTypes : [...ALLOWED_ARTWORK_MIME_TYPES];
    if (!allowed.includes(input.mimeType)) throw AppError.unprocessable('UPLOAD_TYPE_NOT_ALLOWED', { allowed: allowed.join(', ') });
    const maxBytes = Math.min(group?.maxFileSizeBytes ?? MAX_ARTWORK_BYTES, MAX_ARTWORK_BYTES);
    if (input.sizeBytes > maxBytes) throw AppError.unprocessable('UPLOAD_TOO_LARGE', { maxMb: Math.floor(maxBytes / 1024 / 1024) });

    const pending = await this.prisma.artworkFile.count({
      where: { ...owner, status: 'PENDING_UPLOAD', createdAt: { gt: new Date(Date.now() - 3_600_000) } },
    });
    if (pending >= MAX_PENDING_PER_HOUR) throw AppError.tooMany();

    const retention = await this.settings.get('retention');
    const now = new Date();
    const key = `artwork/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomToken(12)}/${safeFileStem(input.fileName)}.${extensionFor(input.mimeType)}`;
    const retentionUntil = retention.artworkRetentionMonths
      ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + retention.artworkRetentionMonths, now.getUTCDate()))
      : null;

    const file = await this.prisma.artworkFile.create({
      data: {
        ...owner,
        groupId: group?.id ?? null,
        purpose: 'ARTWORK',
        storageKey: key,
        originalName: input.fileName.slice(0, 200),
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        retentionUntil,
      },
    });
    const upload = await this.storage.presignPut(key, input.mimeType, input.sizeBytes);
    return { id: file.id, upload, expiresInSec: 600 };
  }

  /** Called by the browser after the PUT finished: verifies the real bytes and produces a thumbnail. */
  async completeArtwork(actor: Actor, id: string) {
    const file = await this.prisma.artworkFile.findFirst({ where: { id, ...this.ownerWhere(actor) }, include: { group: true } });
    if (!file || file.status === 'DELETED') throw AppError.notFound('UPLOAD_NOT_FOUND');
    if (file.status === 'READY') return this.artworkView(file);
    if (file.status === 'REJECTED') throw AppError.unprocessable('UPLOAD_REJECTED');

    const reject = async (code: string, params: Record<string, unknown> = {}): Promise<never> => {
      await this.storage.delete(file.storageKey).catch(() => undefined);
      await this.prisma.artworkFile.update({ where: { id }, data: { status: 'REJECTED' } });
      logEvent('warn', 'upload.rejected', { id, code });
      throw AppError.unprocessable(code, params);
    };

    const head = await this.storage.head(file.storageKey);
    if (!head) throw AppError.unprocessable('UPLOAD_MISSING');
    const limit = Math.min(file.group?.maxFileSizeBytes ?? MAX_ARTWORK_BYTES, MAX_ARTWORK_BYTES);
    if (head.size > limit || head.size > file.sizeBytes) return reject('UPLOAD_TOO_LARGE', { maxMb: Math.floor(limit / 1024 / 1024) });

    const bytes = await this.storage.get(file.storageKey);
    const detected = detectType(bytes);
    if (!detected || detected !== file.mimeType) return reject('UPLOAD_TYPE_MISMATCH');

    let widthPx: number | null = null;
    let heightPx: number | null = null;
    let thumbnailKey: string | null = null;

    if (detected === 'application/pdf') {
      if (pdfLooksUnsafe(bytes)) return reject('UPLOAD_UNSAFE');
    } else {
      try {
        const img = sharp(bytes, { limitInputPixels: MAX_PIXELS });
        const meta = await img.metadata();
        widthPx = meta.width ?? null;
        heightPx = meta.height ?? null;
        if (!widthPx || !heightPx) return reject('UPLOAD_TYPE_MISMATCH');

        const thumb = await sharp(bytes, { limitInputPixels: MAX_PIXELS })
          .rotate()
          .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
          .flatten({ background: '#ffffff' })
          .jpeg({ quality: 78 })
          .toBuffer();
        thumbnailKey = file.storageKey.replace(/\.[^./]+$/, '') + '.thumb.jpg';
        await this.storage.put(thumbnailKey, thumb, 'image/jpeg');
      } catch (e) {
        if (e instanceof AppError) throw e;
        return reject('UPLOAD_TYPE_MISMATCH');
      }

      const g = file.group;
      if (g) {
        const tooSmall = (g.minWidthPx && widthPx < g.minWidthPx) || (g.minHeightPx && heightPx < g.minHeightPx);
        const tooBig = (g.maxWidthPx && widthPx > g.maxWidthPx) || (g.maxHeightPx && heightPx > g.maxHeightPx);
        if (tooSmall || tooBig) {
          return reject('UPLOAD_DIMENSIONS', { width: widthPx, height: heightPx, minWidth: g.minWidthPx, minHeight: g.minHeightPx, maxWidth: g.maxWidthPx, maxHeight: g.maxHeightPx });
        }
      }
    }

    const updated = await this.prisma.artworkFile.update({
      where: { id },
      data: { status: 'READY', sizeBytes: head.size, widthPx, heightPx, thumbnailKey },
    });
    return this.artworkView(updated);
  }

  async getArtwork(actor: Actor, id: string) {
    const file = await this.prisma.artworkFile.findFirst({ where: { id, ...this.ownerWhere(actor) } });
    if (!file || file.status === 'DELETED') throw AppError.notFound('UPLOAD_NOT_FOUND');
    return this.artworkView(file);
  }

  async deleteArtwork(actor: Actor, id: string) {
    const file = await this.prisma.artworkFile.findFirst({ where: { id, ...this.ownerWhere(actor) } });
    if (!file) throw AppError.notFound('UPLOAD_NOT_FOUND');
    const used = await this.prisma.customizationSelection.count({ where: { artworkFileId: id } });
    if (used > 0) throw AppError.conflict('UPLOAD_IN_USE');
    await this.removeFiles(file);
    return { ok: true };
  }

  private async artworkView(file: { id: string; status: string; originalName: string; mimeType: string; sizeBytes: number; widthPx: number | null; heightPx: number | null; thumbnailKey: string | null }) {
    return {
      id: file.id,
      status: file.status,
      originalName: file.originalName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      widthPx: file.widthPx,
      heightPx: file.heightPx,
      thumbnailUrl: file.thumbnailKey ? await this.storage.signedGetUrl(file.thumbnailKey, DOWNLOAD_TTL_SEC) : null,
    };
  }

  // ---------------------------------------------------------------- admin: customer artwork access

  /** Staff download of a customer's original (print production). */
  async adminArtworkLinks(id: string) {
    const file = await this.prisma.artworkFile.findUnique({ where: { id } });
    if (!file || file.status !== 'READY') throw AppError.notFound('UPLOAD_NOT_FOUND');
    return {
      id: file.id,
      originalName: file.originalName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      widthPx: file.widthPx,
      heightPx: file.heightPx,
      downloadUrl: await this.storage.signedGetUrl(file.storageKey, DOWNLOAD_TTL_SEC, file.originalName),
      thumbnailUrl: file.thumbnailKey ? await this.storage.signedGetUrl(file.thumbnailKey, DOWNLOAD_TTL_SEC) : null,
    };
  }

  // ---------------------------------------------------------------- admin: public media

  async presignMedia(input: { folder: 'products' | 'options' | 'content' | 'reviews'; fileName: string; mimeType: string; sizeBytes: number }) {
    if (!MEDIA_MIME_TYPES.includes(input.mimeType)) throw AppError.unprocessable('UPLOAD_TYPE_NOT_ALLOWED', { allowed: MEDIA_MIME_TYPES.join(', ') });
    if (input.sizeBytes > MAX_MEDIA_BYTES) throw AppError.unprocessable('UPLOAD_TOO_LARGE', { maxMb: 8 });
    const key = `media/${input.folder}/${randomToken(9)}-${safeFileStem(input.fileName)}.${extensionFor(input.mimeType)}`;
    const upload = await this.storage.presignPut(key, input.mimeType, input.sizeBytes);
    return { key, upload, publicUrl: this.storage.publicUrl(key) };
  }

  async completeMedia(key: string) {
    if (!/^media\/(products|options|content|reviews)\/[\w.-]+$/.test(key)) throw AppError.badRequest('UPLOAD_NOT_FOUND');
    const head = await this.storage.head(key);
    if (!head) throw AppError.unprocessable('UPLOAD_MISSING');
    if (head.size > MAX_MEDIA_BYTES) {
      await this.storage.delete(key).catch(() => undefined);
      throw AppError.unprocessable('UPLOAD_TOO_LARGE', { maxMb: 8 });
    }
    const bytes = await this.storage.get(key);
    const type = detectType(bytes);
    if (!type || !MEDIA_MIME_TYPES.includes(type)) {
      await this.storage.delete(key).catch(() => undefined);
      throw AppError.unprocessable('UPLOAD_TYPE_MISMATCH');
    }
    let width: number | null = null;
    let height: number | null = null;
    try {
      const meta = await sharp(bytes, { limitInputPixels: MAX_PIXELS }).metadata();
      width = meta.width ?? null;
      height = meta.height ?? null;
    } catch {
      await this.storage.delete(key).catch(() => undefined);
      throw AppError.unprocessable('UPLOAD_TYPE_MISMATCH');
    }
    return { key, url: this.storage.publicUrl(key), width, height, sizeBytes: head.size, mimeType: type };
  }

  // ---------------------------------------------------------------- cleanup (cron)

  private async removeFiles(file: { id: string; storageKey: string; thumbnailKey: string | null }) {
    await this.storage.delete(file.storageKey).catch(() => undefined);
    if (file.thumbnailKey) await this.storage.delete(file.thumbnailKey).catch(() => undefined);
    await this.prisma.artworkFile.update({ where: { id: file.id }, data: { status: 'DELETED', thumbnailKey: null } });
  }

  /**
   * - Uploads never completed (> 24h) and rejected files are removed.
   * - READY files that were never used in an order (> 30 days) are removed.
   * - Files past `retentionUntil` (only when the admin configured a retention period) are removed.
   * Files that belong to an order are kept forever unless a retention period is configured.
   */
  async cleanup(): Promise<{ abandoned: number; unused: number; expired: number }> {
    const day = 86_400_000;
    const now = Date.now();

    const abandonedRows = await this.prisma.artworkFile.findMany({
      where: { OR: [{ status: 'PENDING_UPLOAD', createdAt: { lt: new Date(now - day) } }, { status: 'REJECTED', createdAt: { lt: new Date(now - day) } }] },
      take: 200,
    });
    for (const f of abandonedRows) await this.removeFiles(f);

    const unusedRows = await this.prisma.artworkFile.findMany({
      where: { status: 'READY', createdAt: { lt: new Date(now - 30 * day) }, selections: { none: {} } },
      take: 200,
    });
    for (const f of unusedRows) await this.removeFiles(f);

    const expiredRows = await this.prisma.artworkFile.findMany({
      where: { status: 'READY', retentionUntil: { lt: new Date(now) } },
      take: 200,
    });
    for (const f of expiredRows) await this.removeFiles(f);

    return { abandoned: abandonedRows.length, unused: unusedRows.length, expired: expiredRows.length };
  }
}
