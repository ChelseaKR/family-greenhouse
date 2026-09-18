/**
 * Photo fixtures built the way the devices that took them write them, for the
 * stored-photo metadata tests. The pixels are tiny REAL images (an 8x8 JPEG, a
 * 4x4 PNG, a 4x4 lossless WebP) so a decoder could open every fixture. The
 * metadata around them is assembled by hand, byte for byte, so each test knows
 * exactly what went in.
 */
import { deflateSync } from 'node:zlib';

export const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAIAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABQb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCXAGJ5/9k=',
  'base64'
);
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAEAQMAAACTPww9AAAAA1BMVEU6fURlpt+uAAAAC0lEQVQI12NggAAAAAgAAS8g3TEAAAAASUVORK5CYII=',
  'base64'
);
/** RIFF / WEBP / VP8L: a simple-format WebP with no metadata chunks. */
export const TINY_WEBP = Buffer.from(
  'UklGRh4AAABXRUJQVlA4TBEAAAAvA8AAAAfQvuqUqP+BiOh/AAA=',
  'base64'
);

/** A made-up spot. The tests look for its bytes and must never find them. */
export const LATITUDE = [37, 1, 46, 1, 3012, 100] as const;
export const LONGITUDE = [122, 1, 25, 1, 1188, 100] as const;

function u16(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}
function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}
function entry(tag: number, type: number, count: number, value: number[]): number[] {
  return [...u16(tag), ...u16(type), ...u32(count), ...value];
}

/**
 * A big-endian TIFF/EXIF structure the way a phone writes one: IFD0 with Make,
 * Orientation and a GPSInfo pointer, and a GPS IFD with N/W references and the
 * latitude and longitude as three RATIONALs each.
 */
export function phoneTiff(options: { orientation?: number; gps?: boolean } = {}): Uint8Array {
  const orientation = options.orientation ?? 6;
  const gps = options.gps ?? true;
  const ifd0Count = gps ? 3 : 2;
  const ifd0Size = 2 + ifd0Count * 12 + 4;
  const makeOffset = 8 + ifd0Size;
  const make = [...Buffer.from('PhoneCo\0')];
  const gpsOffset = makeOffset + make.length;
  const gpsCount = 4;
  const gpsSize = 2 + gpsCount * 12 + 4;
  const latOffset = gpsOffset + gpsSize;
  const lonOffset = latOffset + 24;

  const out: number[] = [0x4d, 0x4d, 0x00, 0x2a, ...u32(8)];
  out.push(...u16(ifd0Count));
  out.push(...entry(0x010f, 2, make.length, u32(makeOffset))); // Make
  out.push(...entry(0x0112, 3, 1, [...u16(orientation), 0, 0])); // Orientation
  if (gps) out.push(...entry(0x8825, 4, 1, u32(gpsOffset))); // GPSInfo
  out.push(...u32(0));
  out.push(...make);
  if (gps) {
    out.push(...u16(gpsCount));
    out.push(...entry(0x0001, 2, 2, [0x4e, 0, 0, 0])); // GPSLatitudeRef "N"
    out.push(...entry(0x0002, 5, 3, u32(latOffset))); // GPSLatitude
    out.push(...entry(0x0003, 2, 2, [0x57, 0, 0, 0])); // GPSLongitudeRef "W"
    out.push(...entry(0x0004, 5, 3, u32(lonOffset))); // GPSLongitude
    out.push(...u32(0));
    for (const value of [...LATITUDE, ...LONGITUDE]) out.push(...u32(value));
  }
  return new Uint8Array(out);
}

/** The latitude as it sits in the file: the bytes a leak would carry. */
export function latitudeBytes(): Uint8Array {
  return new Uint8Array(LATITUDE.flatMap((value) => u32(value)));
}

export function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  return Buffer.from(haystack).indexOf(Buffer.from(needle)) >= 0;
}

function jpegSegment(marker: number, payload: Uint8Array | number[]): number[] {
  const body = [...payload];
  return [0xff, marker, ...u16(body.length + 2), ...body];
}

const EXIF = [...Buffer.from('Exif\0\0')];
const XMP_HEADER = [...Buffer.from('http://ns.adobe.com/xap/1.0/\0')];
const XMP_WITH_GPS = [
  ...XMP_HEADER,
  ...Buffer.from(
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description exif:GPSLatitude="37,1.7N" exif:GPSLongitude="122,25.2W"/></rdf:RDF></x:xmpmeta>'
  ),
];

/** A Photoshop APP13 block whose IPTC record names a city (2:90). */
function iptcWithCity(): number[] {
  const city = [...Buffer.from('Springfield')];
  const iptc = [0x1c, 0x02, 90, ...u16(city.length), ...city];
  return [
    ...Buffer.from('Photoshop 3.0\0'),
    ...Buffer.from('8BIM'),
    ...u16(0x0404),
    0,
    0, // empty Pascal name, padded to even
    ...u32(iptc.length),
    ...iptc,
    ...(iptc.length % 2 ? [0] : []),
  ];
}

/** The same with no datasets: what Apple's JPEG encoder writes from a canvas. */
function emptyIptc(): number[] {
  return [
    ...Buffer.from('Photoshop 3.0\0'),
    ...Buffer.from('8BIM'),
    ...u16(0x0404),
    0,
    0,
    ...u32(0),
  ];
}

/** TINY_JPEG split after SOI + APP0, so segments can go in where a phone puts them. */
function jpegWith(segments: number[][], trailing: Uint8Array = new Uint8Array(0)): Uint8Array {
  const soiApp0 = TINY_JPEG.subarray(0, 20); // SOI (2) + APP0 JFIF (18)
  const rest = TINY_JPEG.subarray(20);
  return new Uint8Array([...soiApp0, ...segments.flat(), ...rest, ...trailing]);
}

/**
 * A phone photo: EXIF with GPS and Orientation 6, XMP with GPS, IPTC with a
 * city, a comment, and an MPF-style second image after the end marker that
 * carries its own GPS EXIF.
 */
export function phoneJpeg(): Uint8Array {
  const secondary = jpegWith([jpegSegment(0xe1, [...EXIF, ...phoneTiff()])]);
  return jpegWith(
    [
      jpegSegment(0xe1, [...EXIF, ...phoneTiff()]),
      jpegSegment(0xe1, XMP_WITH_GPS),
      jpegSegment(0xed, iptcWithCity()),
      jpegSegment(0xfe, [...Buffer.from('taken at home')]),
    ],
    secondary
  );
}

/** A JPEG with EXIF (orientation `orientation`) and no location at all. */
export function jpegWithOrientation(orientation: number): Uint8Array {
  return jpegWith([jpegSegment(0xe1, [...EXIF, ...phoneTiff({ orientation, gps: false })])]);
}

/**
 * What production actually holds (census, 2026-09-18): Safari's canvas encoder
 * writes an EXIF block with only the Exif sub-IFD pointer, ColorSpace and the
 * pixel dimensions, plus an empty Photoshop/IPTC block. No location.
 */
export function canvasJpegFromSafari(): Uint8Array {
  // prettier-ignore
  const tiff = [
    0x4d, 0x4d, 0x00, 0x2a, ...u32(8),
    ...u16(1), ...entry(0x8769, 4, 1, u32(26)), ...u32(0), // IFD0: ExifIFD pointer
    ...u16(3),
    ...entry(0xa001, 3, 1, [...u16(1), 0, 0]), // ColorSpace sRGB
    ...entry(0xa002, 4, 1, u32(8)), // PixelXDimension
    ...entry(0xa003, 4, 1, u32(8)), // PixelYDimension
    ...u32(0),
  ];
  return jpegWith([jpegSegment(0xe1, [...EXIF, ...tiff]), jpegSegment(0xed, emptyIptc())]);
}

/** The scan: every byte from the first SOS marker to the end marker. */
export function jpegScan(bytes: Uint8Array): Uint8Array {
  const buffer = Buffer.from(bytes);
  const start = buffer.indexOf(Buffer.from([0xff, 0xda]));
  const end = buffer.indexOf(Buffer.from([0xff, 0xd9]), start) + 2;
  return bytes.subarray(start, end);
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array | number[]): number[] {
  const body = [...Buffer.from(type), ...data];
  return [...u32(data.length), ...body, ...u32(crc32(new Uint8Array(body)))];
}

/** A PNG a phone's screenshot tool or an editor might write: eXIf with GPS, compressed XMP, tIME. */
export function pngWithLocation(): Uint8Array {
  const afterIhdr = 8 + 25; // signature + IHDR; ancillary chunks go before PLTE/IDAT
  const xmp = deflateSync(
    Buffer.from('<x:xmpmeta><rdf:Description exif:GPSLatitude="37,1.7N"/></x:xmpmeta>')
  );
  const itxt = [...Buffer.from('XML:com.adobe.xmp\0'), 1, 0, 0, 0, ...xmp];
  return new Uint8Array([
    ...TINY_PNG.subarray(0, afterIhdr),
    ...pngChunk('pHYs', [...u32(2835), ...u32(2835), 1]),
    ...pngChunk('eXIf', phoneTiff()),
    ...pngChunk('iTXt', itxt),
    ...pngChunk('tIME', [0x07, 0xea, 9, 18, 12, 0, 0]),
    ...TINY_PNG.subarray(afterIhdr),
  ]);
}

// ---------------------------------------------------------------------------
// WebP
// ---------------------------------------------------------------------------

function webpChunk(fourcc: string, data: Uint8Array | number[]): number[] {
  const body = [...data];
  const size = body.length;
  const le = [size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >>> 24) & 0xff];
  return [...Buffer.from(fourcc), ...le, ...body, ...(size % 2 ? [0] : [])];
}

/** Extended-format WebP: VP8X with the EXIF and XMP flags set, the image, then both chunks. */
export function webpWithLocation(): Uint8Array {
  const image = TINY_WEBP.subarray(12); // the VP8L chunk
  const vp8x = [0x08 | 0x04, 0, 0, 0, 3, 0, 0, 3, 0, 0]; // flags; canvas 4x4 (minus one)
  const body = [
    ...Buffer.from('WEBP'),
    ...webpChunk('VP8X', vp8x),
    ...image,
    ...webpChunk('EXIF', [...Buffer.from('Exif\0\0'), ...phoneTiff()]),
    ...webpChunk('XMP ', [...Buffer.from('<x:xmpmeta exif:GPSLongitude="122,25.2W"/>')]),
  ];
  const size = body.length;
  const le = [size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >>> 24) & 0xff];
  return new Uint8Array([...Buffer.from('RIFF'), ...le, ...body]);
}
