/**
 * Getting a phone photo down to something the sitter photo-back endpoint will
 * accept. Kept out of the component file so the component module exports
 * only a component (react-refresh) and so these two pure-ish helpers can be
 * tested directly.
 *
 * The server is the authority: it re-measures the DECODED bytes, sniffs the
 * magic bytes, and refuses anything over its own cap. This shrinks the photo
 * before it crosses a sitter's mobile connection — a courtesy, not a guard.
 */
import { downscaleImage } from '@/utils/image';

/** Decoded-byte cap the server enforces; we aim to land under it. */
export const MAX_UPLOAD_BYTES = 300 * 1024;
const TARGET_EDGES = [1200, 900, 640];
const TARGET_QUALITIES = [0.8, 0.6, 0.45];

export async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

/** Decoded size of a base64 data URL, without allocating the bytes. */
export function decodedBytes(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/**
 * Downscale until the encoded result fits the server's cap. Returns null when
 * even the smallest attempt is too large (or the canvas pipeline is
 * unavailable and the original overflows) — the caller then explains rather
 * than shipping a payload the server will refuse.
 */
export async function prepareSitterPhoto(file: File): Promise<string | null> {
  for (const edge of TARGET_EDGES) {
    for (const quality of TARGET_QUALITIES) {
      const blob = await downscaleImage(file, edge, quality);
      if (!blob) break;
      const dataUrl = await blobToDataUrl(blob);
      if (decodedBytes(dataUrl) <= MAX_UPLOAD_BYTES) return dataUrl;
    }
  }
  if (file.size <= MAX_UPLOAD_BYTES) {
    const dataUrl = await blobToDataUrl(file);
    if (decodedBytes(dataUrl) <= MAX_UPLOAD_BYTES) return dataUrl;
  }
  return null;
}
