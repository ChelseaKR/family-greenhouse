/**
 * Location metadata in a STORED plant photo: find it, and remove it.
 *
 * ## Why the backend needs this
 *
 * Until #849, two upload paths could put a photo in the images bucket with the
 * phone's metadata still in it. Every member upload fell back to the ORIGINAL
 * file when the browser's canvas re-encode failed, and the caretaker page never
 * re-encoded at all. A phone's EXIF block usually carries GPS coordinates, and
 * a plant photo is usually taken at home. Nothing on the server re-encodes a
 * photo: the object in S3 is exactly the bytes the client PUT, and CloudFront
 * serves those bytes unchanged. #849 strips metadata on the device from now on.
 * This module is the server-side half for photos that were already stored:
 * `inspectPhotoMetadata` says what a stored object carries, and
 * `stripPhotoMetadata` rewrites it without that. The backfill in
 * `storedPhotoMetadataBackfill.ts` uses both.
 *
 * It mirrors the removal rules of the device-side stripper #849 adds
 * (`frontend/src/utils/imageMetadata.ts`), with ONE deliberate difference: a
 * JPEG keeps its EXIF orientation. A device-side strip runs after the canvas
 * has already drawn the pixels upright. A stored original never went through
 * the canvas, so its pixels may be stored sideways with an Orientation tag
 * that puts them right. Dropping that tag would turn someone's photo on its
 * side. So a JPEG whose EXIF said anything other than "upright" gets back a
 * minimal EXIF block that holds the Orientation tag and nothing else. PNG and
 * WebP don't get that: cameras don't write them, and a PNG or WebP original
 * with a rotation tag loses it. The backfill's report keeps each object's
 * orientation, so an operator can see whether that ever happened.
 *
 * ## What counts as location
 *
 * - the EXIF GPS IFD (the GPSInfo pointer, tag 0x8825), in a JPEG, PNG `eXIf`
 *   or WebP `EXIF` block;
 * - an XMP packet or PNG text chunk naming a GPS or place property;
 * - IPTC place datasets (city, sublocation, state, country, location code);
 * - image data appended after a JPEG's end marker. MPF secondary images carry
 *   their own EXIF, GPS included.
 *
 * An EXIF block this cannot parse counts as location. It can't be ruled out,
 * and stripping it costs nothing.
 *
 * Nothing here ever returns a coordinate, a place name or a camera model. The
 * report is booleans, and the one number it keeps is the orientation.
 */
import { inflateSync } from 'node:zlib';

export class PhotoMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhotoMetadataError';
  }
}

export type PhotoFormat = 'image/jpeg' | 'image/png' | 'image/webp';

export interface PhotoMetadataReport {
  format: PhotoFormat;
  /** An EXIF block is present (JPEG APP1 `Exif`, PNG `eXIf`, WebP `EXIF`). */
  exif: boolean;
  /**
   * That EXIF block holds the Orientation tag and nothing else: exactly what
   * `stripPhotoMetadata` leaves in a JPEG. Not counted as metadata to remove.
   */
  exifOrientationOnly: boolean;
  /** The EXIF block has a GPS IFD, or could not be parsed. */
  gps: boolean;
  /** An XMP packet is present. */
  xmp: boolean;
  /** XMP or PNG text names a GPS or place property. */
  textLocation: boolean;
  /** A JPEG APP13 (Photoshop/IPTC) block is present. */
  iptc: boolean;
  /** IPTC carries a place dataset. */
  iptcLocation: boolean;
  /** Bytes after a JPEG's end-of-image marker that hold another image. */
  trailingImage: boolean;
  /** Any other metadata the strip removes: comments, other APPn, PNG time. */
  otherMetadata: boolean;
  /** EXIF Orientation (1–8) when present, else null. */
  orientation: number | null;
}

/** Does this photo carry anything that can place it on a map? */
export function carriesLocation(report: PhotoMetadataReport): boolean {
  return report.gps || report.textLocation || report.iptcLocation || report.trailingImage;
}

/** Does this photo carry ANY metadata the strip would remove? */
export function carriesMetadata(report: PhotoMetadataReport): boolean {
  return (
    (report.exif && !report.exifOrientationOnly) ||
    report.xmp ||
    report.iptc ||
    report.trailingImage ||
    report.otherMetadata ||
    carriesLocation(report)
  );
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = '';
  for (let index = start; index < start + length && index < bytes.length; index += 1) {
    out += String.fromCharCode(bytes[index]);
  }
  return out;
}

function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
}

/** The format the bytes actually are, or null. Never the key's extension. */
export function sniffPhotoFormat(bytes: Uint8Array): PhotoFormat | null {
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

// ---------------------------------------------------------------------------
// EXIF (TIFF) and the place-naming text formats
// ---------------------------------------------------------------------------

const TAG_ORIENTATION = 0x0112;
const TAG_GPS_IFD = 0x8825;
const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"

function startsWithExifHeader(bytes: Uint8Array): boolean {
  return EXIF_HEADER.every((value, index) => bytes[index] === value);
}

interface TiffFacts {
  gps: boolean;
  orientation: number | null;
  orientationOnly: boolean;
}

/** GPS and orientation from a TIFF structure. Unparseable counts as GPS. */
function readTiff(tiff: Uint8Array): TiffFacts {
  const unparsed = { gps: true, orientation: null, orientationOnly: false };
  try {
    const order = ascii(tiff, 0, 2);
    if (order !== 'II' && order !== 'MM') return unparsed;
    const little = order === 'II';
    const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
    const ifd0 = view.getUint32(4, little);
    const count = view.getUint16(ifd0, little);
    let gps = false;
    let orientation: number | null = null;
    for (let index = 0; index < count; index += 1) {
      const entry = ifd0 + 2 + index * 12;
      const tag = view.getUint16(entry, little);
      if (tag === TAG_GPS_IFD) gps = true;
      if (tag === TAG_ORIENTATION) {
        const value = view.getUint16(entry + 8, little);
        orientation = value >= 1 && value <= 8 ? value : null;
      }
    }
    const nextIfd = view.getUint32(ifd0 + 2 + count * 12, little);
    const orientationOnly = count === 1 && orientation !== null && nextIfd === 0;
    return { gps, orientation, orientationOnly };
  } catch {
    return unparsed;
  }
}

/** XMP / text properties that name a place. Matched on names, never read. */
const TEXT_LOCATION_RE =
  /GPS(?:Latitude|Longitude|Altitude|Position)|photoshop:(?:City|State|Country)|Iptc4xmp(?:Core|Ext):(?:Location|CountryCode|Sublocation)|LocationCreated|LocationShown/;

function textNamesLocation(text: string): boolean {
  return TEXT_LOCATION_RE.test(text);
}

/** IPTC record 2 datasets that name a place. */
const IPTC_LOCATION_DATASETS = new Set([26, 27, 90, 92, 95, 100, 101]);

/** Walk a Photoshop APP13 block's 8BIM resources to the IPTC-NAA record. */
function iptcHasLocation(payload: Uint8Array): boolean {
  const header = 'Photoshop 3.0\0';
  if (ascii(payload, 0, header.length) !== header) return false;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let position = header.length;
  while (position + 12 <= payload.length && ascii(payload, position, 4) === '8BIM') {
    const id = view.getUint16(position + 4);
    const nameLength = payload[position + 6];
    let cursor = position + 7 + nameLength;
    if ((nameLength + 1) % 2 === 1) cursor += 1; // Pascal name padded to even
    if (cursor + 4 > payload.length) return false;
    const size = view.getUint32(cursor);
    const dataStart = cursor + 4;
    const dataEnd = Math.min(dataStart + size, payload.length);
    if (id === 0x0404) {
      let at = dataStart;
      while (at + 5 <= dataEnd && payload[at] === 0x1c) {
        const record = payload[at + 1];
        const dataset = payload[at + 2];
        const length = view.getUint16(at + 3);
        if (record === 2 && IPTC_LOCATION_DATASETS.has(dataset)) return true;
        at += 5 + length;
      }
    }
    position = dataStart + size + (size % 2);
  }
  return false;
}

function emptyReport(format: PhotoFormat): PhotoMetadataReport {
  return {
    format,
    exif: false,
    exifOrientationOnly: false,
    gps: false,
    xmp: false,
    textLocation: false,
    iptc: false,
    iptcLocation: false,
    trailingImage: false,
    otherMetadata: false,
    orientation: null,
  };
}

/** Fold one EXIF (TIFF) block into the report. A second block is never "orientation only". */
function recordExif(report: PhotoMetadataReport, tiffBytes: Uint8Array): void {
  const tiff = readTiff(tiffBytes);
  report.exifOrientationOnly = !report.exif && tiff.orientationOnly;
  report.exif = true;
  report.gps ||= tiff.gps;
  report.orientation ??= tiff.orientation;
}

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------

const JPEG_SOS = 0xda;
const JPEG_EOI = 0xd9;
const XMP_HEADER = 'http://ns.adobe.com/xap/1.0/\0';

interface JpegSegment {
  marker: number;
  /** Offset of the 0xFF that starts the marker. */
  start: number;
  /** Offset just past the segment (and past the scan data, for SOS). */
  end: number;
  /** The segment payload, without marker and length. Empty for standalone. */
  payload: Uint8Array;
}

/**
 * Walk a JPEG to its end-of-image marker. Returns the segments in order and
 * where the primary image ends; anything after that is trailing data.
 */
function walkJpeg(bytes: Uint8Array): { segments: JpegSegment[]; imageEnd: number } {
  const segments: JpegSegment[] = [];
  let position = 2;
  while (position < bytes.length) {
    if (bytes[position] !== 0xff) {
      throw new PhotoMetadataError('JPEG segment does not start with a marker');
    }
    const start = position;
    while (position < bytes.length && bytes[position] === 0xff) position += 1; // fill bytes
    const marker = bytes[position];
    position += 1;

    if (marker === JPEG_EOI) {
      segments.push({ marker, start, end: position, payload: new Uint8Array(0) });
      return { segments, imageEnd: position };
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      segments.push({ marker, start, end: position, payload: new Uint8Array(0) });
      continue;
    }
    if (position + 2 > bytes.length) throw new PhotoMetadataError('JPEG segment is truncated');
    const length = (bytes[position] << 8) | bytes[position + 1];
    if (length < 2 || position + length > bytes.length) {
      throw new PhotoMetadataError('JPEG segment length runs past the file');
    }
    const payload = bytes.subarray(position + 2, position + length);
    position += length;

    if (marker === JPEG_SOS) {
      // Entropy-coded data runs until a marker that is not a stuffed 0x00, a
      // restart marker or a fill byte.
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
    }
    segments.push({ marker, start, end: position, payload });
  }
  // Truncated after the scan: there is no trailing data to speak of.
  return { segments, imageEnd: bytes.length };
}

/** Is this APPn/COM segment metadata the strip removes? (JFIF, ICC, Adobe stay.) */
function isRemovableJpegSegment(marker: number, payload: Uint8Array): boolean {
  if (marker === 0xfe) return true; // COM
  if (marker < 0xe0 || marker > 0xef) return false; // not APPn: image data
  if (marker === 0xe0) return false; // APP0 JFIF/JFXX
  if (marker === 0xe2) return ascii(payload, 0, 12) !== 'ICC_PROFILE\0';
  if (marker === 0xee) return ascii(payload, 0, 5) !== 'Adobe';
  return true; // APP1 EXIF/XMP, APP3–APP13 incl. IPTC, APP15
}

function hasTrailingImage(bytes: Uint8Array, imageEnd: number): boolean {
  for (let index = imageEnd; index + 2 < bytes.length; index += 1) {
    if (bytes[index] === 0xff && bytes[index + 1] === 0xd8 && bytes[index + 2] === 0xff) {
      return true;
    }
  }
  return false;
}

function inspectJpeg(bytes: Uint8Array): PhotoMetadataReport {
  const report = emptyReport('image/jpeg');
  const { segments, imageEnd } = walkJpeg(bytes);
  for (const { marker, payload } of segments) {
    if (marker === 0xe1 && startsWithExifHeader(payload)) {
      recordExif(report, payload.subarray(EXIF_HEADER.length));
    } else if (marker === 0xe1 && ascii(payload, 0, XMP_HEADER.length) === XMP_HEADER) {
      report.xmp = true;
      report.textLocation ||= textNamesLocation(latin1(payload));
    } else if (marker === 0xed) {
      report.iptc = true;
      report.iptcLocation ||= iptcHasLocation(payload);
    } else if (isRemovableJpegSegment(marker, payload)) {
      report.otherMetadata = true;
      // An APP1 that is neither EXIF nor standard XMP (extended XMP, say) is
      // still searched for place names.
      if (marker === 0xe1) report.textLocation ||= textNamesLocation(latin1(payload));
    }
  }
  report.trailingImage = hasTrailingImage(bytes, imageEnd);
  if (imageEnd < bytes.length && !report.trailingImage) {
    report.otherMetadata ||= bytes.subarray(imageEnd).some((value) => value !== 0x00);
  }
  return report;
}

/** A minimal EXIF APP1 segment holding only the Orientation tag. */
function orientationOnlyExif(orientation: number): Uint8Array {
  // "Exif\0\0" + big-endian TIFF header + IFD0 with one SHORT entry + no next IFD.
  // prettier-ignore
  const tiff = [
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // MM, 42, IFD0 at 8
    0x00, 0x01, // one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, // Orientation, SHORT, count 1
    0x00, orientation, 0x00, 0x00, // value, padded
    0x00, 0x00, 0x00, 0x00, // no next IFD
  ];
  const payload = [...EXIF_HEADER, ...tiff];
  const length = payload.length + 2;
  return new Uint8Array([0xff, 0xe1, length >> 8, length & 0xff, ...payload]);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function stripJpeg(bytes: Uint8Array): Uint8Array {
  const { orientation } = inspectJpeg(bytes);
  const { segments } = walkJpeg(bytes);
  const out: Uint8Array[] = [bytes.subarray(0, 2)]; // SOI
  let orientationWritten = orientation === null || orientation === 1;
  let sawEoi = false;
  for (const segment of segments) {
    // The orientation block goes after JFIF (if any), before anything else.
    if (!orientationWritten && segment.marker !== 0xe0) {
      out.push(orientationOnlyExif(orientation!));
      orientationWritten = true;
    }
    if (segment.marker === JPEG_EOI) sawEoi = true;
    if (!isRemovableJpegSegment(segment.marker, segment.payload)) {
      out.push(bytes.subarray(segment.start, segment.end));
    }
  }
  // Anything after the primary image's end marker is dropped. A truncated
  // file is closed properly so a decoder shows what it can.
  if (!sawEoi) out.push(new Uint8Array([0xff, JPEG_EOI]));
  return concat(out);
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

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

interface PngChunk {
  type: string;
  start: number;
  end: number;
  data: Uint8Array;
}

function walkPng(bytes: Uint8Array): PngChunk[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: PngChunk[] = [];
  let position = 8;
  while (position + 12 <= bytes.length) {
    const length = view.getUint32(position);
    const type = ascii(bytes, position + 4, 4);
    const end = position + 12 + length;
    if (end > bytes.length) throw new PhotoMetadataError('PNG chunk runs past the file');
    chunks.push({ type, start: position, end, data: bytes.subarray(position + 8, end - 4) });
    position = end;
    if (type === 'IEND') return chunks;
  }
  throw new PhotoMetadataError('PNG has no IEND chunk');
}

function isCriticalPngChunk(type: string): boolean {
  return type.charCodeAt(0) >= 0x41 && type.charCodeAt(0) <= 0x5a;
}

/** The readable text of a tEXt / zTXt / iTXt chunk (keyword included). */
function pngText(type: string, data: Uint8Array): string {
  try {
    if (type === 'tEXt') return latin1(data);
    const keywordEnd = data.indexOf(0);
    if (keywordEnd < 0) return latin1(data);
    const keyword = latin1(data.subarray(0, keywordEnd));
    if (type === 'zTXt') return keyword + latin1(inflateSync(data.subarray(keywordEnd + 2)));
    // iTXt: keyword\0 flag method language\0 translated\0 text
    const compressed = data[keywordEnd + 1] === 1;
    let cursor = keywordEnd + 3;
    cursor = data.indexOf(0, cursor) + 1; // past language tag
    cursor = data.indexOf(0, cursor) + 1; // past translated keyword
    const body = data.subarray(cursor);
    return keyword + latin1(compressed ? inflateSync(body) : body);
  } catch {
    // Unreadable text cannot be ruled out; the caller treats it as a place.
    return 'GPSLatitude';
  }
}

function inspectPng(bytes: Uint8Array): PhotoMetadataReport {
  const report = emptyReport('image/png');
  for (const { type, data } of walkPng(bytes)) {
    if (type === 'eXIf') {
      recordExif(report, startsWithExifHeader(data) ? data.subarray(6) : data);
    } else if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      const text = pngText(type, data);
      if (text.startsWith('XML:com.adobe.xmp')) report.xmp = true;
      else report.otherMetadata = true;
      report.textLocation ||= textNamesLocation(text);
    } else if (!isCriticalPngChunk(type) && !PNG_KEPT_ANCILLARY.has(type)) {
      report.otherMetadata = true;
    }
  }
  return report;
}

function stripPng(bytes: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [bytes.subarray(0, 8)];
  for (const { type, start, end } of walkPng(bytes)) {
    if (isCriticalPngChunk(type) || PNG_KEPT_ANCILLARY.has(type)) {
      out.push(bytes.subarray(start, end));
    }
  }
  return concat(out);
}

// ---------------------------------------------------------------------------
// WebP
// ---------------------------------------------------------------------------

const WEBP_FLAG_EXIF = 0x08;
const WEBP_FLAG_XMP = 0x04;

interface WebpChunk {
  fourcc: string;
  start: number;
  end: number;
  data: Uint8Array;
}

function walkWebp(bytes: Uint8Array): WebpChunk[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: WebpChunk[] = [];
  let position = 12;
  while (position + 8 <= bytes.length) {
    const fourcc = ascii(bytes, position, 4);
    const size = view.getUint32(position + 4, true);
    if (position + 8 + size > bytes.length) {
      throw new PhotoMetadataError('WebP chunk runs past the file');
    }
    const end = Math.min(position + 8 + size + (size % 2), bytes.length);
    chunks.push({
      fourcc,
      start: position,
      end,
      data: bytes.subarray(position + 8, position + 8 + size),
    });
    position = end;
  }
  return chunks;
}

function inspectWebp(bytes: Uint8Array): PhotoMetadataReport {
  const report = emptyReport('image/webp');
  for (const { fourcc, data } of walkWebp(bytes)) {
    if (fourcc === 'EXIF') {
      recordExif(report, startsWithExifHeader(data) ? data.subarray(6) : data);
    } else if (fourcc === 'XMP ') {
      report.xmp = true;
      report.textLocation ||= textNamesLocation(latin1(data));
    }
  }
  return report;
}

function stripWebp(bytes: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [new Uint8Array(bytes.subarray(0, 12))];
  for (const { fourcc, start, end } of walkWebp(bytes)) {
    if (fourcc === 'EXIF' || fourcc === 'XMP ') continue;
    const chunk = new Uint8Array(bytes.subarray(start, end));
    if (fourcc === 'VP8X' && chunk.length > 8) chunk[8] &= ~(WEBP_FLAG_EXIF | WEBP_FLAG_XMP);
    out.push(chunk);
  }
  const result = concat(out);
  new DataView(result.buffer).setUint32(4, result.length - 8, true);
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * What metadata a stored photo carries. Throws `PhotoMetadataError` for bytes
 * that are not a well-formed JPEG, PNG or WebP.
 */
export function inspectPhotoMetadata(bytes: Uint8Array): PhotoMetadataReport {
  const format = sniffPhotoFormat(bytes);
  if (format === 'image/jpeg') return inspectJpeg(bytes);
  if (format === 'image/png') return inspectPng(bytes);
  if (format === 'image/webp') return inspectWebp(bytes);
  throw new PhotoMetadataError('Not a JPEG, PNG or WebP image');
}

/**
 * The same photo without its metadata. A JPEG keeps its orientation (see the
 * header). Image data is copied byte for byte, never re-encoded. Throws
 * `PhotoMetadataError` for anything it cannot parse.
 */
export function stripPhotoMetadata(bytes: Uint8Array): { bytes: Uint8Array; format: PhotoFormat } {
  const format = sniffPhotoFormat(bytes);
  if (format === 'image/jpeg') return { bytes: stripJpeg(bytes), format };
  if (format === 'image/png') return { bytes: stripPng(bytes), format };
  if (format === 'image/webp') return { bytes: stripWebp(bytes), format };
  throw new PhotoMetadataError('Not a JPEG, PNG or WebP image');
}
