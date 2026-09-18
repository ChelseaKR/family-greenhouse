/**
 * Byte-level image fixtures carrying a location, built by hand so the tests
 * know exactly which bytes are metadata and which are image data.
 *
 * The GPS block is a real EXIF structure: a big-endian TIFF header, IFD0 with
 * a GPSInfo (0x8825) pointer, and a GPS IFD holding GPSLatitudeRef "N" and
 * GPSLatitude 37/1 46/1 30/1 — the shape a phone writes. `exifGpsPresent()`
 * walks it the way a reader would, so "no GPS after stripping" is asserted by
 * parsing, not by hoping a byte pattern is absent.
 */

const be16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];
const be32 = (value: number) => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];
const le32 = (value: number) => [
  value & 0xff,
  (value >>> 8) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 24) & 0xff,
];
const text = (value: string) => [...value].map((character) => character.charCodeAt(0));

/** TIFF (big-endian) with IFD0 → GPS IFD. */
export function tiffWithGps(): number[] {
  const gpsIfdOffset = 26;
  const rationalsOffset = gpsIfdOffset + 2 + 2 * 12 + 4; // 56
  return [
    ...text('MM'),
    ...be16(42),
    ...be32(8),
    // IFD0: one entry, GPSInfo → gpsIfdOffset
    ...be16(1),
    ...be16(0x8825),
    ...be16(4),
    ...be32(1),
    ...be32(gpsIfdOffset),
    ...be32(0),
    // GPS IFD: GPSLatitudeRef, GPSLatitude
    ...be16(2),
    ...be16(0x0001),
    ...be16(2),
    ...be32(2),
    ...text('N'),
    0,
    0,
    0,
    ...be16(0x0002),
    ...be16(5),
    ...be32(3),
    ...be32(rationalsOffset),
    ...be32(0),
    // 37/1, 46/1, 30/1
    ...be32(37),
    ...be32(1),
    ...be32(46),
    ...be32(1),
    ...be32(30),
    ...be32(1),
  ];
}

/** Does this TIFF block have a GPS IFD pointer in IFD0? Big- or little-endian. */
export function tiffHasGps(tiff: Uint8Array): boolean {
  if (tiff.length < 8) return false;
  const little = tiff[0] === 0x49;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const ifd0 = view.getUint32(4, little);
  if (ifd0 + 2 > tiff.length) return false;
  const count = view.getUint16(ifd0, little);
  for (let entry = 0; entry < count; entry += 1) {
    const at = ifd0 + 2 + entry * 12;
    if (at + 2 > tiff.length) return false;
    if (view.getUint16(at, little) === 0x8825) return true;
  }
  return false;
}

function jpegSegment(marker: number, payload: number[]): number[] {
  return [0xff, marker, ...be16(payload.length + 2), ...payload];
}

/** The scan: SOS header, then entropy data with a stuffed 0xFF00 and a restart marker. */
export const JPEG_SCAN = [
  ...jpegSegment(0xda, [1, 1, 0, 0, 0x3f, 0]),
  0x12,
  0x34,
  0xff,
  0x00,
  0x56,
  0xff,
  0xd0,
  0x78,
];

export const ICC_PAYLOAD = [...text('ICC_PROFILE'), 0, 1, 1, 0xaa, 0xbb];
const XMP_GPS = '<x:xmpmeta><exif:GPSLatitude>37,46.5N</exif:GPSLatitude></x:xmpmeta>';

/**
 * A JPEG the way a phone writes one: JFIF, EXIF with GPS, XMP with GPS, an
 * ICC profile, an MPF index, a comment, the image, and a second image with
 * its own EXIF appended after the first image's end marker.
 */
export function jpegWithGps(): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    ...jpegSegment(0xe0, [...text('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...jpegSegment(0xe1, [...text('Exif'), 0, 0, ...tiffWithGps()]),
    ...jpegSegment(0xe1, [...text('http://ns.adobe.com/xap/1.0/'), 0, ...text(XMP_GPS)]),
    ...jpegSegment(0xe2, ICC_PAYLOAD),
    ...jpegSegment(0xe2, [...text('MPF'), 0, 0x4d, 0x4d, 0, 0x2a]),
    ...jpegSegment(0xfe, text('shot at home')),
    ...jpegSegment(0xdb, [0, ...new Array(64).fill(1)]),
    ...jpegSegment(0xc0, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]),
    ...JPEG_SCAN,
    0xff,
    0xd9,
    // MPF secondary image, with its own GPS
    0xff,
    0xd8,
    ...jpegSegment(0xe1, [...text('Exif'), 0, 0, ...tiffWithGps()]),
    0xff,
    0xd9,
  ]);
}

/** Does any APP1 EXIF block in this JPEG carry a GPS pointer? Scans the whole file. */
export function jpegExifGpsPresent(bytes: Uint8Array): boolean {
  for (let index = 0; index + 10 < bytes.length; index += 1) {
    if (bytes[index] !== 0xff || bytes[index + 1] !== 0xe1) continue;
    const length = (bytes[index + 2] << 8) | bytes[index + 3];
    const payload = bytes.subarray(index + 4, index + 2 + length);
    if (String.fromCharCode(...payload.subarray(0, 4)) !== 'Exif') continue;
    if (tiffHasGps(payload.subarray(6))) return true;
  }
  return false;
}

export function containsText(bytes: Uint8Array, value: string): boolean {
  const needle = text(value);
  outer: for (let index = 0; index + needle.length <= bytes.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (bytes[index + offset] !== needle[offset]) continue outer;
    }
    return true;
  }
  return false;
}

export function indexOfBytes(bytes: Uint8Array, needle: number[]): number {
  outer: for (let index = 0; index + needle.length <= bytes.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (bytes[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

function crc32(bytes: number[]): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: number[]): number[] {
  const body = [...text(type), ...data];
  return [...be32(data.length), ...body, ...be32(crc32(body))];
}

export const PNG_IDAT = pngChunk('IDAT', [0x78, 0x9c, 0x63, 0x60, 0, 0, 0, 2, 0, 1]);

/** A PNG with an eXIf chunk (GPS), a tEXt comment and a tIME stamp. */
export function pngWithGps(): Uint8Array {
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...pngChunk('IHDR', [...be32(1), ...be32(1), 8, 0, 0, 0, 0]),
    ...pngChunk('eXIf', tiffWithGps()),
    ...pngChunk('tEXt', [...text('Comment'), 0, ...text('shot at home')]),
    ...pngChunk('tIME', [0x07, 0xea, 9, 18, 12, 0, 0]),
    ...PNG_IDAT,
    ...pngChunk('IEND', []),
  ]);
}

function riffChunk(fourcc: string, data: number[]): number[] {
  return [...text(fourcc), ...le32(data.length), ...data, ...(data.length % 2 ? [0] : [])];
}

export const WEBP_IMAGE_CHUNK = riffChunk('VP8L', [0x2f, 0, 0, 0, 0x10, 0x07, 0x10, 0x11, 0x11]);

/** An extended WebP with EXIF (GPS) and XMP chunks, flags set for both. */
export function webpWithGps(): Uint8Array {
  const body = [
    ...text('WEBP'),
    // VP8X: flags = EXIF (0x08) | XMP (0x04), canvas 1x1
    ...riffChunk('VP8X', [0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    ...WEBP_IMAGE_CHUNK,
    ...riffChunk('EXIF', tiffWithGps()),
    ...riffChunk('XMP ', text(XMP_GPS)),
  ];
  return new Uint8Array([...text('RIFF'), ...le32(body.length), ...body]);
}
