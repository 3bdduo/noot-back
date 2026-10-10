/**
 * Pure checks on uploaded bytes. Never trust the declared MIME type: the content decides.
 */

export type DetectedType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/avif' | 'application/pdf' | null;

export function detectType(buf: Buffer): DetectedType {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp' && ['avif', 'avis'].includes(buf.toString('ascii', 8, 12))) return 'image/avif';
  if (buf.length >= 5 && buf.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

/** Active content that has no business inside a print artwork PDF. */
const PDF_RED_FLAGS = ['/JavaScript', '/JS', '/Launch', '/EmbeddedFile', '/OpenAction', '/AA', '/RichMedia', '/SubmitForm'];

export function pdfLooksUnsafe(buf: Buffer): boolean {
  // Names may be hex-escaped (/J#61vaScript); decode the simple #xx form before scanning.
  const text = buf.toString('latin1').replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return PDF_RED_FLAGS.some((flag) => {
    const idx = text.indexOf(flag);
    if (idx < 0) return false;
    // '/JS' and '/AA' are prefixes of other legitimate names; require a delimiter after the token.
    const next = text.charAt(idx + flag.length);
    return !/[A-Za-z0-9]/.test(next);
  });
}

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'application/pdf': 'pdf',
};

export function extensionFor(mime: string): string {
  return EXT[mime] ?? 'bin';
}

/** Keeps only safe characters; the extension always comes from the verified MIME type. */
export function safeFileStem(name: string): string {
  const stem = name.replace(/\.[^.]*$/, '');
  const cleaned = stem.normalize('NFKD').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
  return cleaned || 'file';
}
