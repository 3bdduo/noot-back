import { describe, expect, it } from 'vitest';
import { signJwt, verifyJwt } from '../src/common/crypto/jwt.js';
import { base32Decode, base32Encode, generateTotpSecret, totpAt, verifyTotp } from '../src/common/crypto/totp.js';
import { checkPasswordPolicy, hashPassword, verifyPassword } from '../src/common/crypto/password.js';
import { safeEqual, sha256Hex } from '../src/common/crypto/tokens.js';
import { sanitizeRichText } from '../src/common/utils/sanitize.js';
import { detectType, pdfLooksUnsafe, safeFileStem } from '../src/modules/uploads/file-checks.js';

const SECRET = 'x'.repeat(40);

describe('jwt', () => {
  it('round-trips and rejects tampering, wrong secret, expiry and alg=none', () => {
    const t = signJwt({ sub: 'u1', typ: 'access' }, SECRET, 60, 1000);
    expect(verifyJwt(t, SECRET, 1010)?.sub).toBe('u1');
    expect(verifyJwt(t, 'y'.repeat(40), 1010)).toBeNull();
    expect(verifyJwt(t, SECRET, 1061)).toBeNull();
    const [h, p, s] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), sub: 'admin' })).toString('base64url');
    expect(verifyJwt(`${h}.${forged}.${s}`, SECRET, 1010)).toBeNull();
    const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    expect(verifyJwt(`${none}.${p}.`, SECRET, 1010)).toBeNull();
  });
});

describe('totp', () => {
  it('matches the RFC 6238 SHA1 test vector', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(totpAt(secret, 59_000, 30, 8)).toBe('94287082');
    expect(totpAt(secret, 1111111109_000, 30, 8)).toBe('07081804');
  });
  it('verifies within the window only', () => {
    const s = generateTotpSecret();
    const now = 1_700_000_000_000;
    expect(verifyTotp(s, totpAt(s, now), now)).toBe(true);
    expect(verifyTotp(s, totpAt(s, now - 30_000), now)).toBe(true);
    expect(verifyTotp(s, totpAt(s, now - 120_000), now)).toBe(false);
    expect(base32Decode(base32Encode(Buffer.from('hello'))).toString()).toBe('hello');
  });
});

describe('passwords', () => {
  it('hash / verify / policy', async () => {
    const h = await hashPassword('Correct-Horse-9');
    expect(h).not.toContain('Correct');
    expect(await verifyPassword('Correct-Horse-9', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
    expect(await verifyPassword('x', null)).toBe(false);
    expect(checkPasswordPolicy('short').ok).toBe(false);
    expect(checkPasswordPolicy('Correct-Horse-9').ok).toBe(true);
  });
  it('safeEqual / sha256', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(sha256Hex('a')).toHaveLength(64);
  });
});

describe('rich text sanitiser', () => {
  it('removes scripts, handlers and javascript: URLs', () => {
    const out = sanitizeRichText('<p onclick="x()">hi</p><script>alert(1)</script><a href="javascript:alert(1)">x</a><img src=x onerror=alert(1)><iframe src="//e"></iframe>');
    expect(out).not.toMatch(/script|onclick|onerror|javascript:|iframe/i);
    expect(out).toContain('<p>hi</p>');
  });
});

describe('upload checks', () => {
  it('detects real types from bytes, not names', () => {
    expect(detectType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(detectType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(detectType(Buffer.from('%PDF-1.7\n'))).toBe('application/pdf');
    expect(detectType(Buffer.from('<?php echo 1;'))).toBeNull();
    expect(detectType(Buffer.from('MZ\x90\x00'))).toBeNull();
  });
  it('flags active PDF content but not look-alike names', () => {
    expect(pdfLooksUnsafe(Buffer.from('%PDF-1.4 /OpenAction << /S /JavaScript /JS (app.alert(1)) >>'))).toBe(true);
    expect(pdfLooksUnsafe(Buffer.from('%PDF-1.4 /J#61vaScript'))).toBe(true);
    expect(pdfLooksUnsafe(Buffer.from('%PDF-1.4 /Type /Page /JSON /AAPL'))).toBe(false);
  });
  it('safeFileStem strips path tricks', () => {
    expect(safeFileStem('../../etc/passwd.png')).toBe('etc-passwd');
    expect(safeFileStem('تصميم.png')).toBe('file');
  });
});
