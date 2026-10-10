import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hmacHex(secret: string, input: string): string {
  return createHmac('sha256', secret).update(input).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // still do a comparison so timing does not reveal the length mismatch
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Crockford-style base32 without ambiguous characters, used for order numbers. */
const READABLE = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function randomReadable(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += READABLE[bytes[i] % READABLE.length];
  return out;
}
