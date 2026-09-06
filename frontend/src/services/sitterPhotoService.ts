/**
 * Client for the PUBLIC sitter photo-back endpoints (Away Kit):
 *   GET  /sitter/{token}/photos   — is photo-back on, how much of the cap is left
 *   POST /sitter/{token}/photos   — send one photo of a plant back
 *
 * Unauthenticated by design, exactly like sitterService: bare `fetch`, no
 * auth interceptors, the 256-bit token in the path is the only credential.
 * The server re-validates the link window on every call and enforces every
 * limit itself (300 KB, 60 per link, image magic bytes, rate limits) — the
 * client-side downscale is a courtesy to the sitter's data plan, not a
 * guard.
 */
import { SitterLinkInactiveError } from './sitterService';

export interface SitterPhotoStatus {
  enabled: boolean;
  max: number;
  /** Null when the server could not read the count — render as unknown,
   *  never as "0 used". */
  used: number | null;
  remaining: number | null;
}

/** What the sitter gets back — no stored URL (its path names the household),
 *  so the page shows the sitter their own local preview instead. */
export interface SitterPhotoReceipt {
  photoId: string;
  plantName: string;
  caption: string | null;
  uploadedAt: string;
  used: number;
  remaining: number;
}

export interface SitterPhotoUpload {
  taskId: string;
  /** Data URL or bare base64. */
  image: string;
  caption?: string;
}

/** A refusal the sitter can act on: over the cap (409), too large (413),
 *  not an image (400), too fast (429), not included in the plan (402). */
export class SitterPhotoRefusedError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'SitterPhotoRefusedError';
  }
}

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

async function refusalMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === 'string' && body.message.trim()) return body.message;
  } catch {
    // Non-JSON body — fall through to the generic message.
  }
  return fallback;
}

export const sitterPhotoService = {
  async getStatus(token: string, signal?: AbortSignal): Promise<SitterPhotoStatus> {
    const response = await fetch(`${API_URL}/sitter/${encodeURIComponent(token)}/photos`, {
      signal,
      headers: { Accept: 'application/json' },
    });
    if (response.status === 404 || response.status === 410) {
      throw new SitterLinkInactiveError();
    }
    if (!response.ok) {
      throw new Error(`Sitter photo status failed (${response.status})`);
    }
    return (await response.json()) as SitterPhotoStatus;
  },

  async upload(token: string, input: SitterPhotoUpload): Promise<SitterPhotoReceipt> {
    const response = await fetch(`${API_URL}/sitter/${encodeURIComponent(token)}/photos`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (response.status === 404 || response.status === 410) {
      // The link itself is gone/closed (a missing TASK is also a 404, but the
      // page only ever offers tasks it was just handed by the same link).
      throw new SitterLinkInactiveError();
    }
    if (!response.ok) {
      throw new SitterPhotoRefusedError(
        response.status,
        await refusalMessage(response, `Sitter photo upload failed (${response.status})`)
      );
    }
    return (await response.json()) as SitterPhotoReceipt;
  },
};
