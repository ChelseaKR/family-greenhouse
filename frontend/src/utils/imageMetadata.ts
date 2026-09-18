/**
 * Remove every metadata block that can carry a location from a JPEG, PNG or
 * WebP before it leaves the device.
 *
 * ## Why this exists
 *
 * A phone photo's EXIF block usually carries GPS coordinates: where the plant
 * is, which is where the household lives. Plant photos are stored in S3 and
 * served from the site at unguessable URLs, sitter and caretaker photos travel
 * the same way, and identification photos go to a third party (Plant.id).
 *
 * The canvas re-encode in `downscaleImage()` already drops metadata, because a
 * canvas holds pixels and nothing else. But every caller fell back to the
 * ORIGINAL file when the canvas pipeline was unavailable, and the caretaker
 * photo path never downscaled at all, so the privacy of a photo depended on a
 * browser feature succeeding. This is the other half: the bytes are parsed and
 * rewritten without the metadata containers, and anything this cannot parse is
 * refused rather than uploaded as-is.
 *
 * ## What is removed
 *
 * - JPEG: APP1 (EXIF and XMP, both of which can hold GPS), APP2 unless it is
 *   an ICC colour profile (MPF points at secondary images that carry their own
 *   EXIF), APP3–APP13 (APP13 is IPTC, which has location text fields), APP15,
 *   comments, and everything after the primary image's end marker (where MPF
 *   and some phones append a second image with its own EXIF). APP0 (JFIF) and
 *   APP14 (Adobe colour transform) stay, because decoders need them.
 * - PNG: every ancillary chunk that is not about colour or transparency —
 *   `eXIf`, `tEXt`, `zTXt`, `iTXt`, `tIME` and anything unknown. Critical
 *   chunks and `tRNS`, `gAMA`, `cHRM`, `sRGB`, `iCCP`, `sBIT`, `pHYs`, `bKGD`
 *   and the APNG animation chunks stay.
 * - WebP: the `EXIF` and `XMP ` chunks, with the matching VP8X flags cleared
 *   and the RIFF size rewritten.
 *
 * The format is decided from the bytes, never from `Blob.type`, which is the
 * browser's guess from a file extension.
 */

export class ImageMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageMetadataError';
  }
}

type ImageFormat = 'image/jpeg' | 'image/png' | 'image/webp';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = '';
  for (let index = start; index < start + length && index < bytes.length; index += 1) {
    out += String.fromCharCode(bytes[index]);
  }
  return out;
}

/** The image format the bytes actually are, or null. */
export function sniffImageFormat(bytes: Uint8Array): ImageFormat | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 8 && PNG_SIGNATURE.every((value, index) => bytes[index] === value)) {
    return 'image/png';
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

class ByteWriter {
  private readonly chunks: Uint8Array[] = [];
  private length = 0;

  push(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

const JPEG_SOS = 0xda;
const JPEG_EOI = 0xd9;

/** Should this JPEG marker segment be dropped? `payload` excludes marker and length. */
function dropJpegSegment(marker: number, payload: Uint8Array): boolean {
  if (marker === 0xfe) return true; // COM
  if (marker < 0xe0 || marker > 0xef) return false; // not APPn: image data, keep
  if (marker === 0xe0) return false; // APP0 JFIF/JFXX
  if (marker === 0xe2) return ascii(payload, 0, 12) !== 'ICC_PROFILE\0';
  if (marker === 0xee) return ascii(payload, 0, 5) !== 'Adobe';
  return true; // APP1 EXIF/XMP, APP3–APP13 incl. IPTC, APP15
}

function stripJpeg(bytes: Uint8Array): Uint8Array {
  const out = new ByteWriter();
  out.push(bytes.subarray(0, 2)); // SOI
  let position = 2;

  while (position < bytes.length) {
    if (bytes[position] !== 0xff) {
      throw new ImageMetadataError('JPEG segment does not start with a marker');
    }
    while (bytes[position] === 0xff && position < bytes.length) position += 1; // fill bytes
    const marker = bytes[position];
    position += 1;

    if (marker === JPEG_EOI) {
      out.push(new Uint8Array([0xff, JPEG_EOI]));
      return out.bytes(); // anything after the primary image is dropped
    }
    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(new Uint8Array([0xff, marker]));
      continue;
    }
    if (position + 2 > bytes.length) throw new ImageMetadataError('JPEG segment is truncated');
    const length = (bytes[position] << 8) | bytes[position + 1];
    if (length < 2 || position + length > bytes.length) {
      throw new ImageMetadataError('JPEG segment length runs past the file');
    }
    const segmentEnd = position + length;
    const payload = bytes.subarray(position + 2, segmentEnd);

    if (!dropJpegSegment(marker, payload)) {
      out.push(new Uint8Array([0xff, marker]));
      out.push(bytes.subarray(position, segmentEnd));
    }
    position = segmentEnd;

    if (marker === JPEG_SOS) {
      // Entropy-coded data: runs until a marker that is not a stuffed 0x00, a
      // restart marker or a fill byte. Copied verbatim.
      const start = position;
      while (position < bytes.length) {
        if (bytes[position] === 0xff) {
          const next = bytes[position + 1];
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
            position += 2;
            continue;
          }
          if (next === 0xff) {
            position += 1;
            continue;
          }
          break;
        }
        position += 1;
      }
      out.push(bytes.subarray(start, position));
    }
  }
  // Truncated after the scan data: what was copied has no metadata segment in
  // it, and a decoder shows what it can. Close the image properly.
  out.push(new Uint8Array([0xff, JPEG_EOI]));
  return out.bytes();
}

const PNG_KEPT_ANCILLARY = new Set([
  'tRNS',
  'gAMA',
  'cHRM',
  'sRGB',
  'iCCP',
  'sBIT',
  'pHYs',
  'bKGD',
  'acTL',
  'fcTL',
  'fdAT',
]);

function stripPng(bytes: Uint8Array): Uint8Array {
  const out = new ByteWriter();
  out.push(bytes.subarray(0, 8));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let position = 8;
  while (position + 12 <= bytes.length) {
    const length = view.getUint32(position);
    const type = ascii(bytes, position + 4, 4);
    const end = position + 12 + length;
    if (end > bytes.length) throw new ImageMetadataError('PNG chunk runs past the file');
    const critical = type.charCodeAt(0) >= 0x41 && type.charCodeAt(0) <= 0x5a;
    if (critical || PNG_KEPT_ANCILLARY.has(type)) out.push(bytes.subarray(position, end));
    position = end;
    if (type === 'IEND') return out.bytes();
  }
  throw new ImageMetadataError('PNG has no IEND chunk');
}

const WEBP_FLAG_EXIF = 0x08;
const WEBP_FLAG_XMP = 0x04;

function stripWebp(bytes: Uint8Array): Uint8Array {
  const out = new ByteWriter();
  const header = new Uint8Array(bytes.subarray(0, 12));
  out.push(header);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let position = 12;
  while (position + 8 <= bytes.length) {
    const fourcc = ascii(bytes, position, 4);
    const size = view.getUint32(position + 4, true);
    const end = position + 8 + size + (size % 2);
    if (position + 8 + size > bytes.length) {
      throw new ImageMetadataError('WebP chunk runs past the file');
    }
    if (fourcc !== 'EXIF' && fourcc !== 'XMP ') {
      const chunk = new Uint8Array(bytes.subarray(position, Math.min(end, bytes.length)));
      if (fourcc === 'VP8X' && size >= 1) chunk[8] &= ~(WEBP_FLAG_EXIF | WEBP_FLAG_XMP);
      out.push(chunk);
    }
    position = end;
  }
  const result = out.bytes();
  new DataView(result.buffer).setUint32(4, result.length - 8, true);
  return result;
}

/**
 * The same image without its metadata blocks. Throws `ImageMetadataError`
 * for anything that is not a well-formed JPEG, PNG or WebP — a file this
 * cannot rewrite is a file whose metadata it cannot vouch for.
 */
export function stripImageMetadataBytes(bytes: Uint8Array): {
  bytes: Uint8Array;
  type: ImageFormat;
} {
  const type = sniffImageFormat(bytes);
  if (type === 'image/jpeg') return { bytes: stripJpeg(bytes), type };
  if (type === 'image/png') return { bytes: stripPng(bytes), type };
  if (type === 'image/webp') return { bytes: stripWebp(bytes), type };
  throw new ImageMetadataError('Not a JPEG, PNG or WebP image');
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsArrayBuffer(blob);
  });
}

/** `blob` rewritten without metadata, typed by what its bytes really are. */
export async function stripImageMetadata(blob: Blob): Promise<Blob> {
  const { bytes, type } = stripImageMetadataBytes(await blobBytes(blob));
  return new Blob([bytes as BlobPart], { type });
}
