/**
 * services/photoMetadata.ts: find and remove location metadata in a stored
 * photo. Every "it is gone" assertion is paired with the same detector finding
 * it in the input first. A detector that sees nothing would pass every
 * absence test, so each test proves the detector works before it trusts it.
 */
import { describe, expect, it } from 'vitest';
import {
  PhotoMetadataError,
  carriesLocation,
  carriesMetadata,
  inspectPhotoMetadata,
  stripPhotoMetadata,
} from '../../../src/services/photoMetadata.js';
import {
  TINY_JPEG,
  TINY_PNG,
  TINY_WEBP,
  canvasJpegFromSafari,
  contains,
  jpegScan,
  jpegWithOrientation,
  latitudeBytes,
  phoneJpeg,
  phoneTiff,
  pngWithLocation,
  webpWithLocation,
} from './photoFixtures.js';

describe('inspectPhotoMetadata', () => {
  it('finds every place a phone JPEG keeps its location', () => {
    const report = inspectPhotoMetadata(phoneJpeg());
    expect(report).toMatchObject({
      format: 'image/jpeg',
      exif: true,
      gps: true,
      xmp: true,
      textLocation: true,
      iptc: true,
      iptcLocation: true,
      trailingImage: true,
      otherMetadata: true, // the comment
      orientation: 6,
    });
    expect(carriesLocation(report)).toBe(true);
    // The fixture really does hold the coordinates, as bytes.
    expect(contains(phoneJpeg(), latitudeBytes())).toBe(true);
  });

  it('finds GPS in a PNG eXIf chunk and in compressed XMP', () => {
    const report = inspectPhotoMetadata(pngWithLocation());
    expect(report).toMatchObject({
      format: 'image/png',
      exif: true,
      gps: true,
      xmp: true,
      textLocation: true,
    });
    expect(report.otherMetadata).toBe(true); // tIME
  });

  it('finds GPS in a WebP EXIF chunk and XMP chunk', () => {
    const report = inspectPhotoMetadata(webpWithLocation());
    expect(report).toMatchObject({
      format: 'image/webp',
      exif: true,
      gps: true,
      xmp: true,
      textLocation: true,
    });
  });

  it('reads the production canvas JPEG as metadata but NOT location', () => {
    // The shape of every JPEG the 2026-09-18 census found in production.
    const report = inspectPhotoMetadata(canvasJpegFromSafari());
    expect(report).toMatchObject({ exif: true, gps: false, iptc: true, iptcLocation: false });
    expect(carriesLocation(report)).toBe(false);
    expect(carriesMetadata(report)).toBe(true);
  });

  it('reads clean images as clean', () => {
    for (const bytes of [TINY_JPEG, TINY_PNG, TINY_WEBP]) {
      const report = inspectPhotoMetadata(bytes);
      expect(carriesMetadata(report)).toBe(false);
      expect(carriesLocation(report)).toBe(false);
    }
  });

  it('counts an EXIF block it cannot parse as location, since it cannot rule it out', () => {
    const tiff = phoneTiff();
    tiff[0] = 0x00; // not II or MM
    const bytes = new Uint8Array([
      ...TINY_JPEG.subarray(0, 2),
      0xff,
      0xe1,
      0x00,
      tiff.length + 8,
      ...Buffer.from('Exif\0\0'),
      ...tiff,
      ...TINY_JPEG.subarray(2),
    ]);
    expect(inspectPhotoMetadata(bytes).gps).toBe(true);
  });

  it('refuses bytes that are not a JPEG, PNG or WebP', () => {
    expect(() => inspectPhotoMetadata(Buffer.from('<html>not a photo</html>'))).toThrow(
      PhotoMetadataError
    );
  });

  it('refuses a JPEG whose segment runs past the end of the file', () => {
    const truncated = phoneJpeg().subarray(0, 40);
    expect(() => inspectPhotoMetadata(truncated)).toThrow(PhotoMetadataError);
  });
});

describe('stripPhotoMetadata', () => {
  it('removes every location from a phone JPEG and keeps the scan byte for byte', () => {
    const input = phoneJpeg();
    const { bytes, format } = stripPhotoMetadata(input);
    expect(format).toBe('image/jpeg');

    const after = inspectPhotoMetadata(bytes);
    expect(carriesLocation(after)).toBe(false);
    expect(after).toMatchObject({
      gps: false,
      xmp: false,
      iptc: false,
      trailingImage: false,
      otherMetadata: false,
    });
    expect(contains(bytes, latitudeBytes())).toBe(false);
    expect(contains(bytes, Buffer.from('taken at home'))).toBe(false);
    expect(contains(bytes, Buffer.from('Springfield'))).toBe(false);
    expect(contains(bytes, Buffer.from('PhoneCo'))).toBe(false);

    // Image data untouched, and the file still ends at the primary image.
    expect(Buffer.from(jpegScan(bytes)).equals(Buffer.from(jpegScan(TINY_JPEG)))).toBe(true);
    expect(Array.from(bytes.subarray(-2))).toEqual([0xff, 0xd9]);
    // JFIF stays: decoders need it.
    expect(contains(bytes, Buffer.from('JFIF'))).toBe(true);
  });

  it('keeps a sideways photo upright: Orientation survives, alone', () => {
    const { bytes } = stripPhotoMetadata(phoneJpeg());
    const after = inspectPhotoMetadata(bytes);
    expect(after).toMatchObject({
      exif: true,
      exifOrientationOnly: true,
      orientation: 6,
      gps: false,
    });
    // An orientation-only block is not metadata the backfill should chase.
    expect(carriesMetadata(after)).toBe(false);
  });

  it('adds no EXIF back when the photo was already upright', () => {
    const input = jpegWithOrientation(1);
    expect(inspectPhotoMetadata(input).exif).toBe(true);
    const after = inspectPhotoMetadata(stripPhotoMetadata(input).bytes);
    expect(after.exif).toBe(false);
    expect(after.orientation).toBeNull();
  });

  it('is idempotent', () => {
    const once = stripPhotoMetadata(phoneJpeg()).bytes;
    const twice = stripPhotoMetadata(once).bytes;
    expect(Buffer.from(twice).equals(Buffer.from(once))).toBe(true);
  });

  it('removes eXIf, text and time from a PNG and keeps the image chunks', () => {
    const input = pngWithLocation();
    const { bytes } = stripPhotoMetadata(input);
    const after = inspectPhotoMetadata(bytes);
    expect(carriesMetadata(after)).toBe(false);
    expect(contains(bytes, latitudeBytes())).toBe(false);
    for (const kept of ['IHDR', 'PLTE', 'IDAT', 'IEND', 'pHYs']) {
      expect(contains(bytes, Buffer.from(kept))).toBe(contains(input, Buffer.from(kept)));
    }
    expect(contains(bytes, Buffer.from('eXIf'))).toBe(false);
    expect(contains(bytes, Buffer.from('iTXt'))).toBe(false);
    expect(contains(bytes, Buffer.from('tIME'))).toBe(false);
  });

  it('removes EXIF and XMP from a WebP, clears the VP8X flags and fixes the RIFF size', () => {
    const input = webpWithLocation();
    expect(input[20] & 0x0c).toBe(0x0c); // the negative control: flags were set
    const { bytes } = stripPhotoMetadata(input);
    expect(carriesMetadata(inspectPhotoMetadata(bytes))).toBe(false);
    expect(contains(bytes, latitudeBytes())).toBe(false);
    expect(bytes[20] & 0x0c).toBe(0);
    const riffSize = Buffer.from(bytes).readUInt32LE(4);
    expect(riffSize).toBe(bytes.length - 8);
    // The image chunk is copied exactly.
    expect(contains(bytes, TINY_WEBP.subarray(12))).toBe(true);
  });

  it('leaves a clean image as it was', () => {
    for (const clean of [TINY_JPEG, TINY_PNG, TINY_WEBP]) {
      expect(Buffer.from(stripPhotoMetadata(clean).bytes).equals(clean)).toBe(true);
    }
  });

  it('refuses what it cannot parse rather than returning it as-is', () => {
    expect(() => stripPhotoMetadata(Buffer.from('GIF89a'))).toThrow(PhotoMetadataError);
  });
});
