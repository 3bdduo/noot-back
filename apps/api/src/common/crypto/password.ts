import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing with Node's built-in scrypt (no native dependency, safe on serverless).
 * Stored format: scrypt$N$r$p$<salt b64>$<hash b64>
 */
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 128 * 1024 * 1024;

function derive(password: string, salt: Buffer, n: number, r: number, p: number, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize('NFKC'), salt, keylen, { N: n, r, p, maxmem: MAXMEM }, (err, key) => {
      if (err) reject(err);
      else resolve(key as Buffer);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, N, R, P, KEYLEN);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  try {
    const actual = await derive(password, salt, n, r, p, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Burn comparable CPU time when the user does not exist, to avoid user-enumeration by timing. */
const DUMMY = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');
export async function dummyVerify(password: string): Promise<void> {
  await verifyPassword(password, DUMMY);
}

export interface PasswordPolicyResult {
  ok: boolean;
  reason?: string;
}

export function checkPasswordPolicy(password: string): PasswordPolicyResult {
  if (password.length < 10) return { ok: false, reason: 'at least 10 characters' };
  if (password.length > 128) return { ok: false, reason: 'at most 128 characters' };
  if (!/[a-zA-Z؀-ۿ]/.test(password)) return { ok: false, reason: 'must contain a letter' };
  if (!/\d/.test(password)) return { ok: false, reason: 'must contain a digit' };
  return { ok: true };
}
