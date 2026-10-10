import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** AES-256-GCM helper used to keep secrets (e.g. TOTP seeds) encrypted at rest. */
function keyFrom(secret: string): Buffer {
  return createHash('sha256').update(`${secret}:secretbox:v1`).digest();
}

export function encryptSecret(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptSecret(payload: string, secret: string): string {
  const [version, iv, tag, ct] = payload.split('.');
  if (version !== 'v1' || !iv || !tag || !ct) throw new Error('Invalid secret payload');
  const decipher = createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}
