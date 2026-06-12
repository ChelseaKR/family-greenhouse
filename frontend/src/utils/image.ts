/**
 * Client-side image downscaling for plant-photo uploads.
 *
 * Phone cameras hand us 10–20 MP originals; the app renders nothing larger
 * than a card, and the backend confirm step rejects objects over 5 MiB. So
 * we downscale to a max long edge before upload: WebP at ~0.8 quality, with
 * a JPEG fallback where `canvas.toBlob('image/webp')` is unsupported
 * (Safari < 16). If anything in the canvas pipeline fails, callers degrade
 * gracefully by uploading the original.
 */

export const MAX_LONG_EDGE = 1600;
export const ENCODE_QUALITY = 0.8;

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number
): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), type, quality);
    } catch {
      resolve(null);
    }
  });
}

async function decodeImage(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      // Fall through to the <img> path (some browsers can't bitmap-decode
      // every container even when they can render it).
    }
  }
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not decode image'));
    };
    img.src = url;
  });
}

/**
 * Downscale `file` so its long edge is at most `maxEdge` px and re-encode as
 * WebP (preferred) or JPEG (fallback). Returns `null` when the canvas
 * pipeline is unavailable or fails — the caller should then fall back to
 * uploading the original file.
 */
export async function downscaleImage(
  file: File,
  maxEdge: number = MAX_LONG_EDGE,
  quality: number = ENCODE_QUALITY
): Promise<Blob | null> {
  try {
    const source = await decodeImage(file);
    const width = 'naturalWidth' in source ? source.naturalWidth : source.width;
    const height = 'naturalHeight' in source ? source.naturalHeight : source.height;
    if (!width || !height) return null;

    const scale = Math.min(1, maxEdge / Math.max(width, height));
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, targetWidth, targetHeight);
    if ('close' in source) source.close();

    // Prefer WebP; browsers that don't support encoding it either return
    // null or silently encode PNG, so verify the resulting type.
    const webp = await canvasToBlob(canvas, 'image/webp', quality);
    if (webp && webp.type === 'image/webp') return webp;

    const jpeg = await canvasToBlob(canvas, 'image/jpeg', quality);
    if (jpeg && jpeg.type === 'image/jpeg') return jpeg;

    return null;
  } catch {
    return null;
  }
}
