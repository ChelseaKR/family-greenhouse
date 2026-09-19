/**
 * The pure half of the server's photo strip (services/photoIntake.ts has the
 * reasons): given a photo's bytes, return them without their metadata, or
 * say why not. No AWS, no environment, so the sitter photo-back policy (and
 * the dev server that shares it) can use it without loading the S3 client.
 */
import {
  carriesLocation,
  carriesMetadata,
  inspectPhotoMetadata,
  PhotoMetadataError,
  sniffPhotoFormat,
  stripPhotoMetadata,
  type PhotoFormat,
} from './photoMetadata.js';

export type CleanPhoto =
  | {
      ok: true;
      bytes: Uint8Array;
      format: PhotoFormat;
      /** True when anything was removed, i.e. the bytes differ from the input. */
      changed: boolean;
      /** The input carried something that can place it on a map. Never the place itself. */
      hadLocation: boolean;
    }
  | { ok: false; reason: 'not_an_image' | 'type_mismatch' | 'unreadable' };

/**
 * `bytes` without their metadata, if they are a JPEG, PNG or WebP — and, when
 * `declaredType` is given, the one it names. Pure.
 */
export function cleanPhoto(bytes: Uint8Array, declaredType?: string): CleanPhoto {
  const format = sniffPhotoFormat(bytes);
  if (!format) return { ok: false, reason: 'not_an_image' };
  if (declaredType !== undefined && declaredType !== format) {
    return { ok: false, reason: 'type_mismatch' };
  }
  let hadLocation: boolean;
  let stripped: Uint8Array;
  try {
    hadLocation = carriesLocation(inspectPhotoMetadata(bytes));
    stripped = stripPhotoMetadata(bytes).bytes;
    // Read back what is about to be kept: an orientation tag may stay, and
    // nothing else may.
    if (carriesMetadata(inspectPhotoMetadata(stripped))) {
      return { ok: false, reason: 'unreadable' };
    }
  } catch (err) {
    if (err instanceof PhotoMetadataError) return { ok: false, reason: 'unreadable' };
    throw err;
  }
  const changed = !Buffer.from(stripped).equals(Buffer.from(bytes));
  return { ok: true, bytes: stripped, format, changed, hadLocation };
}

/** What the upload confirm routes answer when a photo is refused. */
export const REFUSED_MESSAGES: Record<Exclude<CleanPhoto, { ok: true }>['reason'], string> = {
  not_an_image: 'Uploaded file is not a valid image',
  type_mismatch: 'Uploaded file is not a valid image',
  unreadable:
    'This photo could not be checked for location details, so it was not saved. Try another photo.',
};
