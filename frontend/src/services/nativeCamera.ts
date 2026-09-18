import type { TFunction } from 'i18next';
import { isNativeApp } from '@/lib/platform';

/**
 * The native camera and photo picker, for plant photos inside the iOS and
 * Android shells (`@capacitor/camera`).
 *
 * Browsers never reach this module's plugin: it is imported dynamically, and
 * only after `isNativeApp()`, the same pattern as nativePush.ts, so web
 * visitors never download the Capacitor runtime. The web keeps its
 * `<input type="file">`.
 *
 * - `camera` opens the system camera. Nothing is saved to the gallery.
 * - `library` opens the system photo picker: PHPicker on iOS, the Android
 *   Photo Picker on Android 11+ (with the Play-services backport, and the
 *   system document picker below that). The app only ever receives the one
 *   photo the person picked, and needs no storage permission to get it.
 *
 * What comes back is the picked file as-is. It still goes through
 * `prepareImageForUpload()` like any other photo, which downscales it and
 * removes its metadata, GPS included, before anything is uploaded.
 */

export type PhotoSource = 'camera' | 'library';

/** Why a native photo could not be picked. Cancelling is not an error. */
export type NativePhotoFailure = 'permission' | 'unavailable' | 'failed';

export class NativePhotoError extends Error {
  constructor(
    readonly failure: NativePhotoFailure,
    readonly source: PhotoSource
  ) {
    super(`Native photo ${source} failed: ${failure}`);
    this.name = 'NativePhotoError';
  }
}

/**
 * The plugin's error codes (`CameraErrorCode` in @capacitor/camera). Listed
 * here rather than imported so the enum does not pull the plugin into a
 * web chunk.
 */
const CANCELLED_CODES = new Set(['OS-PLUG-CAMR-0006', 'OS-PLUG-CAMR-0020']);
const PERMISSION_CODES: Record<PhotoSource, string> = {
  camera: 'OS-PLUG-CAMR-0003',
  library: 'OS-PLUG-CAMR-0005',
};
const NO_CAMERA_CODE = 'OS-PLUG-CAMR-0007';

/** JPEG quality the plugin encodes at. The upload is re-encoded again after downscaling. */
const CAPTURE_QUALITY = 90;

/** Whether the native camera and picker are available: only inside the shells. */
export function canUseNativeCamera(): boolean {
  return isNativeApp();
}

function extensionFor(type: string): string {
  if (type === 'image/png') return 'png';
  if (type === 'image/webp') return 'webp';
  return 'jpg';
}

/**
 * Take a photo or pick one. Resolves the photo as a `File`, or `null` when
 * the person cancelled. Throws `NativePhotoError` otherwise.
 */
export async function pickNativePhoto(source: PhotoSource): Promise<File | null> {
  if (!canUseNativeCamera()) throw new NativePhotoError('unavailable', source);
  const { Camera, MediaTypeSelection } = await import('@capacitor/camera');

  let webPath: string | undefined;
  try {
    if (source === 'camera') {
      const result = await Camera.takePhoto({
        quality: CAPTURE_QUALITY,
        correctOrientation: true,
        saveToGallery: false,
        editable: 'no',
        includeMetadata: false,
      });
      webPath = result.webPath;
    } else {
      const { results } = await Camera.chooseFromGallery({
        mediaType: MediaTypeSelection.Photo,
        allowMultipleSelection: false,
        quality: CAPTURE_QUALITY,
        correctOrientation: true,
        editable: 'no',
        includeMetadata: false,
      });
      if (results.length === 0) return null;
      webPath = results[0].webPath;
    }
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && CANCELLED_CODES.has(code)) return null;
    if (code === PERMISSION_CODES[source]) throw new NativePhotoError('permission', source);
    if (code === NO_CAMERA_CODE) throw new NativePhotoError('unavailable', source);
    throw new NativePhotoError('failed', source);
  }

  if (!webPath) throw new NativePhotoError('failed', source);
  // `webPath` is served by the shell's own local server, which CapacitorHttp
  // leaves to the WebView's fetch, so this reads the file from disk.
  const response = await fetch(webPath);
  if (!response.ok) throw new NativePhotoError('failed', source);
  const blob = await response.blob();
  // A label only: prepareImageForUpload() decides the format from the bytes.
  const type = blob.type.startsWith('image/') ? blob.type : 'image/jpeg';
  return new File([blob], `plant-photo.${extensionFor(type)}`, { type });
}

/** What to tell someone when the native camera or picker could not be used. */
export function nativePhotoErrorMessage(error: unknown, t: TFunction): string {
  if (error instanceof NativePhotoError) {
    if (error.failure === 'permission') {
      return error.source === 'camera'
        ? t('plants.photoPicker.cameraDenied')
        : t('plants.photoPicker.libraryDenied');
    }
    if (error.failure === 'unavailable' && error.source === 'camera') {
      return t('plants.photoPicker.noCamera');
    }
  }
  return t('plants.photoPicker.failed');
}
