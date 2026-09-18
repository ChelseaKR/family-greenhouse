/**
 * Photos leave the device without their location.
 *
 * `stripImageMetadata()` is what stands between a phone's EXIF GPS block and
 * a photo served from the site, handed to a sitter, or sent to Plant.id.
 * These tests build images that carry a location in every container a phone
 * uses (EXIF, XMP, an MPF second image, PNG eXIf, WebP EXIF/XMP), strip them,
 * and then PARSE the result to prove the GPS block is gone while the image
 * data is byte-for-byte intact.
 *
 * The last block runs the whole upload pipeline, `prepareImageForUpload()`,
 * down the path that used to leak: the canvas is unavailable, so the ORIGINAL
 * file is what gets uploaded.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ImageMetadataError,
  sniffImageFormat,
  stripImageMetadata,
  stripImageMetadataBytes,
} from '@/utils/imageMetadata';
import { prepareImageForUpload } from '@/utils/image';
import {
  ICC_PAYLOAD,
  JPEG_SCAN,
  PNG_IDAT,
  WEBP_IMAGE_CHUNK,
  containsText,
  indexOfBytes,
  jpegExifGpsPresent,
  jpegWithGps,
  pngWithGps,
  tiffHasGps,
  webpWithGps,
} from './imageFixtures';

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

describe('JPEG', () => {
  it('the fixture really carries GPS, so the assertions below can fail', () => {
    const original = jpegWithGps();
    expect(jpegExifGpsPresent(original)).toBe(true);
    expect(containsText(original, 'GPSLatitude')).toBe(true);
  });

  it('removes the EXIF GPS block, the XMP location and the appended second image', () => {
    const { bytes, type } = stripImageMetadataBytes(jpegWithGps());
    expect(type).toBe('image/jpeg');
    expect(jpegExifGpsPresent(bytes)).toBe(false);
    expect(containsText(bytes, 'Exif')).toBe(false);
    expect(containsText(bytes, 'GPSLatitude')).toBe(false);
    expect(containsText(bytes, 'MPF')).toBe(false);
    expect(containsText(bytes, 'shot at home')).toBe(false);
    // One image, ending at its own end marker.
    expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    expect([...bytes.subarray(-2)]).toEqual([0xff, 0xd9]);
    expect(indexOfBytes(bytes.subarray(2), [0xff, 0xd8])).toBe(-1);
  });

  it('keeps what a decoder needs: JFIF, the ICC profile and the scan, byte for byte', () => {
    const { bytes } = stripImageMetadataBytes(jpegWithGps());
    expect(containsText(bytes, 'JFIF')).toBe(true);
    expect(indexOfBytes(bytes, ICC_PAYLOAD)).toBeGreaterThan(0);
    expect(indexOfBytes(bytes, JPEG_SCAN)).toBeGreaterThan(0);
  });

  it('is a no-op on a JPEG that has no metadata', () => {
    const once = stripImageMetadataBytes(jpegWithGps()).bytes;
    expect([...stripImageMetadataBytes(once).bytes]).toEqual([...once]);
  });

  it('refuses a JPEG whose segment runs past the end, rather than passing it through', () => {
    const broken = jpegWithGps().subarray(0, 30);
    expect(() => stripImageMetadataBytes(broken)).toThrow(ImageMetadataError);
  });
});

describe('PNG', () => {
  it('removes eXIf, text and time chunks and keeps the image chunks', () => {
    const original = pngWithGps();
    expect(containsText(original, 'eXIf')).toBe(true);

    const { bytes, type } = stripImageMetadataBytes(original);
    expect(type).toBe('image/png');
    expect(containsText(bytes, 'eXIf')).toBe(false);
    expect(containsText(bytes, 'tEXt')).toBe(false);
    expect(containsText(bytes, 'tIME')).toBe(false);
    expect(containsText(bytes, 'shot at home')).toBe(false);
    expect(containsText(bytes, 'IHDR')).toBe(true);
    expect(indexOfBytes(bytes, PNG_IDAT)).toBeGreaterThan(0);
    expect(containsText(bytes, 'IEND')).toBe(true);
  });
});

describe('WebP', () => {
  it('removes the EXIF and XMP chunks, clears their flags and fixes the RIFF size', () => {
    const original = webpWithGps();
    const exifAt = indexOfBytes(original, [0x45, 0x58, 0x49, 0x46]); // "EXIF"
    expect(tiffHasGps(original.subarray(exifAt + 8))).toBe(true);

    const { bytes, type } = stripImageMetadataBytes(original);
    expect(type).toBe('image/webp');
    expect(containsText(bytes, 'EXIF')).toBe(false);
    expect(containsText(bytes, 'XMP ')).toBe(false);
    expect(containsText(bytes, 'GPSLatitude')).toBe(false);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(4, true)).toBe(bytes.length - 8);
    const vp8x = indexOfBytes(bytes, [0x56, 0x50, 0x38, 0x58]); // "VP8X"
    expect(bytes[vp8x + 8] & 0x0c).toBe(0);
    expect(indexOfBytes(bytes, WEBP_IMAGE_CHUNK)).toBeGreaterThan(0);
  });
});

describe('what it refuses', () => {
  it('decides the format from the bytes, not the file name', async () => {
    const mislabelled = new Blob([jpegWithGps() as BlobPart], { type: 'image/png' });
    const stripped = await stripImageMetadata(mislabelled);
    expect(stripped.type).toBe('image/jpeg');
    expect(jpegExifGpsPresent(await bytesOf(stripped))).toBe(false);
  });

  it('refuses anything that is not a JPEG, PNG or WebP', async () => {
    expect(sniffImageFormat(new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]))).toBeNull();
    await expect(stripImageMetadata(new Blob(['not an image']))).rejects.toThrow(
      ImageMetadataError
    );
  });
});

describe('prepareImageForUpload: the fallback that used to upload the original', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uploads the original without its GPS when the canvas pipeline is unavailable', async () => {
    // The decoder works but the canvas has no 2D context, which is exactly
    // when downscaleImage() gives up and the caller falls back to the file.
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockResolvedValue({ width: 4000, height: 3000, close: vi.fn() })
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);

    const original = new File([jpegWithGps() as BlobPart], 'IMG_0042.jpg', {
      type: 'image/jpeg',
    });
    const prepared = await prepareImageForUpload(original);

    expect(prepared.type).toBe('image/jpeg');
    const bytes = await bytesOf(prepared);
    expect(jpegExifGpsPresent(bytes)).toBe(false);
    expect(containsText(bytes, 'GPSLatitude')).toBe(false);
    expect(indexOfBytes(bytes, JPEG_SCAN)).toBeGreaterThan(0);
  });

  it('refuses to hand back a file whose metadata it cannot remove', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('no decoder')));
    // No <img> fallback either: make the element path fail immediately.
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      throw new Error('no object URLs');
    });
    const heic = new File([new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70])], 'a.heic', {
      type: 'image/heic',
    });
    await expect(prepareImageForUpload(heic)).rejects.toThrow(ImageMetadataError);
  });
});
