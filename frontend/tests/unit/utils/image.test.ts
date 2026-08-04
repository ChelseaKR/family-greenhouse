/**
 * Client-side downscaling before a plant photo is presigned and PUT. Every
 * failure path here has to return `null` (never throw), because the caller's
 * contract is "fall back to uploading the original".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downscaleImage, ENCODE_QUALITY, MAX_LONG_EDGE } from '@/utils/image';

type ToBlobArgs = { type: string; quality: number; width: number; height: number };

const drawImage = vi.fn();
let toBlobCalls: ToBlobArgs[] = [];
let encoded: Record<string, Blob | null>;

function file(): File {
  return new File([new Uint8Array([1, 2, 3])], 'plant.jpg', { type: 'image/jpeg' });
}

function bitmap(width: number, height: number) {
  return { width, height, close: vi.fn() };
}

/** Install a canvas whose encoder only knows the types in `encoded`. */
function installCanvas(options?: { context?: unknown; toBlobThrows?: boolean }) {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    (options && 'context' in options ? options.context : { drawImage }) as never
  );
  HTMLCanvasElement.prototype.toBlob = function (
    callback: BlobCallback,
    type?: string,
    quality?: number
  ) {
    if (options?.toBlobThrows) throw new Error('canvas is tainted');
    toBlobCalls.push({
      type: type ?? '',
      quality: quality ?? 0,
      width: this.width,
      height: this.height,
    });
    callback(encoded[type ?? ''] ?? null);
  };
}

beforeEach(() => {
  toBlobCalls = [];
  drawImage.mockClear();
  encoded = {
    'image/webp': new Blob(['webp'], { type: 'image/webp' }),
    'image/jpeg': new Blob(['jpeg'], { type: 'image/jpeg' }),
  };
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn().mockResolvedValue(bitmap(4000, 3000)) as unknown as typeof createImageBitmap
  );
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:fake'),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('downscaleImage', () => {
  it('scales the long edge down to the budget and prefers WebP', async () => {
    installCanvas();

    const blob = await downscaleImage(file());

    expect(blob?.type).toBe('image/webp');
    expect(toBlobCalls).toEqual([
      { type: 'image/webp', quality: ENCODE_QUALITY, width: MAX_LONG_EDGE, height: 1200 },
    ]);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, MAX_LONG_EDGE, 1200);
  });

  it('never upscales an image that is already small', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockResolvedValue(bitmap(320, 240)) as unknown as typeof createImageBitmap
    );
    installCanvas();

    await downscaleImage(file());

    expect(toBlobCalls[0]).toMatchObject({ width: 320, height: 240 });
  });

  it('keeps at least one pixel on an extreme aspect ratio', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockResolvedValue(bitmap(9000, 2)) as unknown as typeof createImageBitmap
    );
    installCanvas();

    await downscaleImage(file(), 100);

    expect(toBlobCalls[0]).toMatchObject({ width: 100, height: 1 });
  });

  it('honors caller-supplied edge and quality overrides', async () => {
    installCanvas();

    await downscaleImage(file(), 800, 0.5);

    expect(toBlobCalls[0]).toMatchObject({ width: 800, height: 600, quality: 0.5 });
  });

  it('falls back to JPEG when the browser cannot encode WebP', async () => {
    encoded['image/webp'] = null;
    installCanvas();

    const blob = await downscaleImage(file());

    expect(blob?.type).toBe('image/jpeg');
    expect(toBlobCalls.map((call) => call.type)).toEqual(['image/webp', 'image/jpeg']);
  });

  it('rejects a browser that silently encodes PNG for a WebP request', async () => {
    encoded['image/webp'] = new Blob(['png'], { type: 'image/png' });
    installCanvas();

    const blob = await downscaleImage(file());

    expect(blob?.type).toBe('image/jpeg');
  });

  it('returns null when neither encoder produces a usable blob', async () => {
    encoded = {};
    installCanvas();

    await expect(downscaleImage(file())).resolves.toBeNull();
  });

  it('returns null when toBlob throws instead of calling back', async () => {
    installCanvas({ toBlobThrows: true });

    await expect(downscaleImage(file())).resolves.toBeNull();
  });

  it('returns null when the 2d context is unavailable', async () => {
    installCanvas({ context: null });

    await expect(downscaleImage(file())).resolves.toBeNull();
  });

  it('returns null for a zero-dimension decode', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockResolvedValue(bitmap(0, 0)) as unknown as typeof createImageBitmap
    );
    installCanvas();

    await expect(downscaleImage(file())).resolves.toBeNull();
  });

  it('falls back to the <img> decoder when bitmap decoding fails', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockRejectedValue(new Error('unsupported container'))
    );
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 2000;
      naturalHeight = 1000;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal('Image', FakeImage);
    installCanvas();

    const blob = await downscaleImage(file());

    expect(blob?.type).toBe('image/webp');
    expect(toBlobCalls[0]).toMatchObject({ width: MAX_LONG_EDGE, height: 800 });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake');
  });

  it('returns null when the <img> decoder also fails', async () => {
    vi.stubGlobal('createImageBitmap', undefined);
    class FailingImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal('Image', FailingImage);
    installCanvas();

    await expect(downscaleImage(file())).resolves.toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake');
  });
});
