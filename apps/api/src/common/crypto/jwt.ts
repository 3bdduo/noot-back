import { createHmac, timingSafeEqual } from 'node:crypto';

/** Minimal HS256 JWT (sign + verify). Only HS256 is accepted on verification. */
export interface JwtPayload {
  sub: string;
  typ: 'access' | '2fa';
  iat: number;
  exp: number;
  [key: string]: unknown;
}

const b64url = (input: Buffer | string): string =>
  Buffer.from(input).toString('base64url');

export function signJwt(
  claims: Omit<JwtPayload, 'iat' | 'exp'>,
  secret: string,
  ttlSeconds: number,
  now: number = Math.floor(Date.now() / 1000),
): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ ...claims, iat: now, exp: now + ttlSeconds }));
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest();
  return `${header}.${payload}.${b64url(signature)}`;
}

export function verifyJwt(
  token: string,
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  try {
    const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    if (header.alg !== 'HS256') return null;
    const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest();
    const given = Buffer.from(s, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as JwtPayload;
    if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
    if (typeof payload.sub !== 'string') return null;
    return payload;
  } catch {
    return null;
  }
}
