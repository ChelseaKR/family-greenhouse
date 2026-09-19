/**
 * Upload-shaped fixtures for the server's photo strip, alongside the metadata
 * fixtures in photoFixtures.ts.
 */
import { phoneTiff, TINY_JPEG } from './photoFixtures.js';

/**
 * A HEIC file the way an iPhone stores a photo: an ISO base media file whose
 * `ftyp` names the `heic` brand, and whose `meta` box lists an `Exif` item
 * holding the phone's EXIF, GPS included, in the `mdat`. The image item itself
 * is left out — nothing here decodes HEVC, and the server refuses a HEIC
 * before it would get that far — so this is exactly the part that matters:
 * the container, and the location inside it.
 */
function u16(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}
function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}
function box(type: string, body: number[]): number[] {
  return [...u32(8 + body.length), ...Buffer.from(type), ...body];
}
function fullBox(type: string, version: number, body: number[]): number[] {
  return box(type, [version, 0, 0, 0, ...body]);
}

export function iphoneHeicWithGps(): Uint8Array {
  const ftyp = box('ftyp', [
    ...Buffer.from('heic'),
    ...u32(0),
    ...Buffer.from('mif1'),
    ...Buffer.from('heic'),
  ]);
  // The Exif item's payload: a 4-byte offset to the TIFF header, then
  // "Exif\0\0" and the TIFF structure (ISO/IEC 23008-12, Annex A).
  const exifItem = [...u32(6), ...Buffer.from('Exif\0\0'), ...phoneTiff()];

  const hdlr = fullBox('hdlr', 0, [
    ...u32(0),
    ...Buffer.from('pict'),
    ...u32(0),
    ...u32(0),
    ...u32(0),
    0,
  ]);
  const infe = fullBox('infe', 2, [...u16(1), ...u16(0), ...Buffer.from('Exif'), 0]);
  const iinf = fullBox('iinf', 0, [...u16(1), ...infe]);
  // iloc v0: offset_size 4, length_size 4, base_offset_size 0; one item, one
  // extent. The offset is patched in below, once the mdat position is known.
  const ilocBody = [0x44, 0x00, ...u16(1), ...u16(1), ...u16(0), ...u16(1), 0, 0, 0, 0];
  ilocBody.push(...u32(exifItem.length));
  const iloc = fullBox('iloc', 0, ilocBody);
  const meta = fullBox('meta', 0, [...hdlr, ...iinf, ...iloc]);
  const mdatHeader = [...u32(8 + exifItem.length), ...Buffer.from('mdat')];

  const file = [...ftyp, ...meta, ...mdatHeader, ...exifItem];
  const dataOffset = ftyp.length + meta.length + mdatHeader.length;
  // The extent offset sits 8 bytes before the extent length, at the end of iloc.
  const extentOffsetAt = ftyp.length + meta.length - 8;
  file.splice(extentOffsetAt, 4, ...u32(dataOffset));
  return new Uint8Array(file);
}

/**
 * A real JPEG of exactly `size` bytes: the tiny JPEG with comment segments
 * after its start marker to make up the length. A comment is metadata, so
 * the server strip takes it out again; what goes in is still `size` bytes,
 * which is what a size cap is measured on.
 */
export function jpegOfExactly(size: number): Buffer {
  const soi = TINY_JPEG.subarray(0, 2);
  const rest = TINY_JPEG.subarray(2);
  let remaining = size - TINY_JPEG.length;
  if (remaining !== 0 && remaining < 4) throw new Error(`cannot pad a JPEG by ${remaining} bytes`);
  const segments: Buffer[] = [];
  while (remaining > 0) {
    let segment = Math.min(remaining, 4 + 65533);
    if (remaining - segment > 0 && remaining - segment < 4) segment -= 4;
    const payload = segment - 4;
    const header = Buffer.from([0xff, 0xfe, ((payload + 2) >> 8) & 0xff, (payload + 2) & 0xff]);
    segments.push(header, Buffer.alloc(payload, 0x20));
    remaining -= segment;
  }
  return Buffer.concat([soi, ...segments, rest]);
}
