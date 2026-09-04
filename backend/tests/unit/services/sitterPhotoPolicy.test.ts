/**
 * Sitter photo-back admission policy — the pure limits that bound the one
 * unauthenticated write surface the Away Kit adds. Every branch here is a
 * refusal the Lambda handler and the mock dev server both rely on.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  SITTER_PHOTO_MAX_BASE64_CHARS,
  SITTER_PHOTO_MAX_BYTES,
  SITTER_PHOTO_UPLOADS_PER_MINUTE,
  __resetSitterPhotoLimiterForTests,
  admitSitterPhoto,
  decodeImagePayload,
  sitterActorId,
  sitterPhotoUploadSchema,
  sniffImageContentType,
  takeSitterPhotoToken,
} from '../../../src/services/sitterPhotoPolicy.js';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff, 0xe0];

function bytesWith(prefix: number[], total = 64): Buffer {
  const buf = Buffer.alloc(total);
  Buffer.from(prefix).copy(buf);
  return buf;
}

function webpBytes(total = 64): Buffer {
  const buf = Buffer.alloc(total);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(total - 8, 4);
  buf.write('WEBP', 8, 'ascii');
  return buf;
}

describe('sniffImageContentType', () => {
  it('recognises JPEG, PNG and WebP by their magic bytes', () => {
    expect(sniffImageContentType(bytesWith(JPEG_MAGIC))).toBe('image/jpeg');
    expect(sniffImageContentType(bytesWith(PNG_MAGIC))).toBe('image/png');
    expect(sniffImageContentType(webpBytes())).toBe('image/webp');
  });

  it('returns null for anything else — including an HTML file renamed .jpg', () => {
    expect(sniffImageContentType(Buffer.from('<html><script>alert(1)</script>'))).toBeNull();
    // RIFF container that is NOT WebP (a .wav) is refused too.
    const wav = webpBytes();
    wav.write('WAVE', 8, 'ascii');
    expect(sniffImageContentType(wav)).toBeNull();
    // GIF / BMP / SVG are not in the plant-photo allowlist.
    expect(sniffImageContentType(Buffer.from('GIF89a......'))).toBeNull();
    expect(
      sniffImageContentType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))
    ).toBeNull();
    expect(sniffImageContentType(Buffer.alloc(0))).toBeNull();
  });
});

describe('decodeImagePayload', () => {
  it('decodes bare base64 and data URLs to the same bytes', () => {
    const bytes = bytesWith(PNG_MAGIC);
    const b64 = bytes.toString('base64');
    expect(decodeImagePayload(b64)).toEqual(bytes);
    expect(decodeImagePayload(`data:image/png;base64,${b64}`)).toEqual(bytes);
  });

  it('is strict: whitespace, url-safe alphabet, or bad padding is null, not garbage', () => {
    const b64 = bytesWith(PNG_MAGIC).toString('base64');
    expect(decodeImagePayload(`${b64.slice(0, 10)}\n${b64.slice(10)}`)).toBeNull();
    expect(decodeImagePayload(b64.replace('/', '_').replace('+', '-') + 'x')).toBeNull();
    expect(decodeImagePayload(b64.slice(1))).toBeNull(); // length % 4 !== 0
    expect(decodeImagePayload('')).toBeNull();
    expect(decodeImagePayload('data:image/png;base64,')).toBeNull();
  });
});

describe('admitSitterPhoto', () => {
  it('admits an in-spec image with its sniffed content type', () => {
    const result = admitSitterPhoto(bytesWith(JPEG_MAGIC).toString('base64'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contentType).toBe('image/jpeg');
      expect(result.bytes.length).toBe(64);
    }
  });

  it('refuses undecodable or empty payloads with a 400', () => {
    expect(admitSitterPhoto('not base64!!')).toEqual({
      ok: false,
      status: 400,
      message: 'Photo must be a base64-encoded image',
    });
  });

  it('refuses a payload over the 300 KB DECODED cap with a 413 — measured on the bytes, not the text', () => {
    const tooBig = bytesWith(PNG_MAGIC, SITTER_PHOTO_MAX_BYTES + 1);
    const result = admitSitterPhoto(tooBig.toString('base64'));
    expect(result).toEqual({ ok: false, status: 413, message: 'Photo exceeds the 300 KB limit' });
    // Exactly at the cap is fine.
    const atCap = bytesWith(PNG_MAGIC, SITTER_PHOTO_MAX_BYTES);
    expect(admitSitterPhoto(atCap.toString('base64')).ok).toBe(true);
  });

  it('refuses bytes that are not a JPEG/PNG/WebP even when the caller claims otherwise', () => {
    const html = Buffer.from('<!doctype html><html><body>hi</body></html>'.padEnd(64, ' '));
    expect(admitSitterPhoto(`data:image/jpeg;base64,${html.toString('base64')}`)).toEqual({
      ok: false,
      status: 400,
      message: 'Photo is not a JPEG, PNG, or WebP image',
    });
  });
});

describe('sitterPhotoUploadSchema', () => {
  it('caps the base64 text so an oversize body is a readable 400, and trims captions', () => {
    const ok = sitterPhotoUploadSchema.safeParse({
      taskId: 't1',
      image: 'a'.repeat(64),
      caption: '  looking good  ',
    });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.caption).toBe('looking good');

    const tooLong = sitterPhotoUploadSchema.safeParse({
      taskId: 't1',
      image: 'a'.repeat(SITTER_PHOTO_MAX_BASE64_CHARS + 64),
    });
    expect(tooLong.success).toBe(false);

    const longCaption = sitterPhotoUploadSchema.safeParse({
      taskId: 't1',
      image: 'a'.repeat(64),
      caption: 'x'.repeat(201),
    });
    expect(longCaption.success).toBe(false);

    expect(sitterPhotoUploadSchema.safeParse({ image: 'a'.repeat(64) }).success).toBe(false);
  });
});

describe('takeSitterPhotoToken (per-token brake)', () => {
  beforeEach(() => __resetSitterPhotoLimiterForTests());

  it('allows N uploads per minute per token, then refuses until the window resets', () => {
    const token = 'a'.repeat(64);
    const t0 = 1_000_000;
    for (let i = 0; i < SITTER_PHOTO_UPLOADS_PER_MINUTE; i++) {
      expect(takeSitterPhotoToken(token, undefined, t0 + i)).toBe(true);
    }
    expect(takeSitterPhotoToken(token, undefined, t0 + 500)).toBe(false);
    // A different token has its own window.
    expect(takeSitterPhotoToken('b'.repeat(64), undefined, t0 + 500)).toBe(true);
    // The window resets after a minute.
    expect(takeSitterPhotoToken(token, undefined, t0 + 60_001)).toBe(true);
  });
});

describe('sitterActorId', () => {
  it('matches the actor the completion route stamps, so one recap query finds both', () => {
    expect(sitterActorId('link-1')).toBe('sitter:link-1');
  });
});
