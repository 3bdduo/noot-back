import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../../config/env.js';
import { hmacHex, safeEqual } from '../../common/crypto/tokens.js';

export const STORAGE_DRIVER = Symbol('STORAGE_DRIVER');

export interface PresignedUpload {
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
}

export interface StorageDriver {
  readonly kind: 'r2' | 'local';
  presignPut(key: string, contentType: string, sizeBytes: number): Promise<PresignedUpload>;
  head(key: string): Promise<{ size: number } | null>;
  get(key: string): Promise<Buffer>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Short-lived private link (customer artwork, production files). */
  signedGetUrl(key: string, ttlSec: number, downloadName?: string): Promise<string>;
  /** Permanent link for public media (product photos, option images, CMS). */
  publicUrl(key: string): string;
}

// ------------------------------------------------------------------------------------ Cloudflare R2

export class R2Driver implements StorageDriver {
  readonly kind = 'r2' as const;
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    this.bucket = env.STORAGE_BUCKET!;
    this.client = new S3Client({
      region: 'auto',
      endpoint: env.STORAGE_ENDPOINT || `https://${env.STORAGE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: env.STORAGE_ACCESS_KEY_ID!, secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY! },
      // R2 does not support the newer default checksum behaviour of the SDK on presigned URLs.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async presignPut(key: string, contentType: string, sizeBytes: number): Promise<PresignedUpload> {
    // ContentLength is part of the signature, so the browser cannot upload more than it declared.
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType, ContentLength: sizeBytes }),
      { expiresIn: 600 },
    );
    return { method: 'PUT', url, headers: { 'Content-Type': contentType } };
  }

  async head(key: string) {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: Number(res.ContentLength ?? 0) };
    } catch (e: any) {
      if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NotFound') return null;
      throw e;
    }
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const bytes = await res.Body!.transformToByteArray();
    return Buffer.from(bytes);
  }

  async put(key: string, body: Buffer, contentType: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  signedGetUrl(key: string, ttlSec: number, downloadName?: string) {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: downloadName ? `attachment; filename="${downloadName.replace(/[^\w.\-]/g, '_')}"` : undefined,
      }),
      { expiresIn: ttlSec },
    );
  }

  publicUrl(key: string) {
    const base = (env.STORAGE_PUBLIC_URL ?? '').replace(/\/$/, '');
    return `${base}/${key}`;
  }
}

// ------------------------------------------------------------------------------------ local (dev only)

const LOCAL_ROOT = resolve(process.cwd(), '.uploads');

export function localPath(key: string): string {
  const full = resolve(join(LOCAL_ROOT, key));
  if (!full.startsWith(LOCAL_ROOT + sep)) throw new Error('Invalid storage key');
  return full;
}

/** HMAC-signed URLs served by this API itself. Used only when no R2 credentials are configured. */
export function signLocal(op: 'put' | 'get', key: string, expSec: number): { exp: number; sig: string } {
  const exp = Math.floor(Date.now() / 1000) + expSec;
  return { exp, sig: hmacHex(env.AUTH_SECRET, `${op}:${key}:${exp}`) };
}

export function verifyLocal(op: 'put' | 'get', key: string, exp: number, sig: string): boolean {
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  return safeEqual(hmacHex(env.AUTH_SECRET, `${op}:${key}:${exp}`), sig);
}

export class LocalDriver implements StorageDriver {
  readonly kind = 'local' as const;
  private readonly base = `${env.APP_URL.replace(/\/$/, '')}/api/v1/uploads`;

  private url(op: 'put' | 'get', key: string, ttl: number) {
    const { exp, sig } = signLocal(op, key, ttl);
    return `${this.base}/local/${op}?key=${encodeURIComponent(key)}&exp=${exp}&sig=${sig}`;
  }

  async presignPut(key: string, contentType: string): Promise<PresignedUpload> {
    return { method: 'PUT', url: this.url('put', key, 600), headers: { 'Content-Type': contentType } };
  }

  async head(key: string) {
    try {
      return { size: (await stat(localPath(key))).size };
    } catch {
      return null;
    }
  }

  get(key: string) {
    return readFile(localPath(key));
  }

  async put(key: string, body: Buffer) {
    const p = localPath(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
  }

  async delete(key: string) {
    await rm(localPath(key), { force: true });
  }

  async signedGetUrl(key: string, ttlSec: number) {
    return this.url('get', key, ttlSec);
  }

  publicUrl(key: string) {
    return this.url('get', key, 60 * 60 * 24 * 365);
  }
}

export function createStorageDriver(): StorageDriver {
  const configured = env.STORAGE_BUCKET && env.STORAGE_ACCESS_KEY_ID && env.STORAGE_SECRET_ACCESS_KEY && (env.STORAGE_ACCOUNT_ID || env.STORAGE_ENDPOINT);
  if (configured) return new R2Driver();
  if (env.NODE_ENV === 'production') {
    throw new Error('Storage is not configured: set STORAGE_* variables (Cloudflare R2) in production.');
  }
  return new LocalDriver();
}
