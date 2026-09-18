/**
 * The native camera and photo picker (`@capacitor/camera`), as the plant
 * photo screens use them inside the iOS and Android shells.
 *
 * Pinned here: the plugin is never reached outside the shells; the camera
 * never saves to the gallery and the picker takes one photo; cancelling is
 * not an error; a denied permission is reported as a permission problem for
 * the right source; and the photo comes back as a File for the ordinary
 * upload path, which is what strips its metadata.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';

const camera = vi.hoisted(() => ({
  takePhoto: vi.fn(),
  chooseFromGallery: vi.fn(),
}));

vi.mock('@capacitor/camera', () => ({
  Camera: camera,
  MediaTypeSelection: { Photo: 0, Video: 1, All: 2 },
}));

import {
  NativePhotoError,
  canUseNativeCamera,
  nativePhotoErrorMessage,
  pickNativePhoto,
} from '@/services/nativeCamera';

function pluginError(code: string) {
  return Object.assign(new Error(code), { code });
}

describe('native camera', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
    };
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue(
      new Response('jpeg-bytes', { status: 200, headers: { 'Content-Type': 'image/jpeg' } })
    );
  });

  afterEach(() => {
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
    vi.unstubAllGlobals();
  });

  it('is unavailable in a browser, and never loads the plugin there', async () => {
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
    expect(canUseNativeCamera()).toBe(false);
    await expect(pickNativePhoto('camera')).rejects.toBeInstanceOf(NativePhotoError);
    expect(camera.takePhoto).not.toHaveBeenCalled();
  });

  it('takes a photo without saving it to the gallery and returns it as a File', async () => {
    camera.takePhoto.mockResolvedValue({
      type: 0,
      saved: false,
      webPath: 'https://localhost/_capacitor_file_/photo.jpg',
    });

    const file = await pickNativePhoto('camera');

    expect(camera.takePhoto).toHaveBeenCalledWith(
      expect.objectContaining({ saveToGallery: false, editable: 'no', includeMetadata: false })
    );
    expect(fetchMock).toHaveBeenCalledWith('https://localhost/_capacitor_file_/photo.jpg');
    expect(file).toBeInstanceOf(File);
    expect(file?.type).toBe('image/jpeg');
    expect(file?.name).toBe('plant-photo.jpg');
  });

  it('opens the system picker for exactly one photo', async () => {
    camera.chooseFromGallery.mockResolvedValue({
      results: [{ type: 0, saved: false, webPath: 'capacitor://localhost/_capacitor_file_/a.jpg' }],
    });

    const file = await pickNativePhoto('library');

    expect(camera.chooseFromGallery).toHaveBeenCalledWith(
      expect.objectContaining({ mediaType: 0, allowMultipleSelection: false })
    );
    expect(file).toBeInstanceOf(File);
  });

  it('treats cancelling the camera or the picker as nothing picked, not a failure', async () => {
    camera.takePhoto.mockRejectedValue(pluginError('OS-PLUG-CAMR-0006'));
    camera.chooseFromGallery.mockRejectedValue(pluginError('OS-PLUG-CAMR-0020'));
    await expect(pickNativePhoto('camera')).resolves.toBeNull();
    await expect(pickNativePhoto('library')).resolves.toBeNull();
    camera.chooseFromGallery.mockResolvedValue({ results: [] });
    await expect(pickNativePhoto('library')).resolves.toBeNull();
  });

  it('reports a denied permission for the source that was denied', async () => {
    camera.takePhoto.mockRejectedValue(pluginError('OS-PLUG-CAMR-0003'));
    await expect(pickNativePhoto('camera')).rejects.toMatchObject({
      failure: 'permission',
      source: 'camera',
    });
    camera.chooseFromGallery.mockRejectedValue(pluginError('OS-PLUG-CAMR-0005'));
    await expect(pickNativePhoto('library')).rejects.toMatchObject({
      failure: 'permission',
      source: 'library',
    });
  });

  it('turns every failure into a message that says what to do next', () => {
    const t = ((key: string) => key) as unknown as TFunction;
    expect(nativePhotoErrorMessage(new NativePhotoError('permission', 'camera'), t)).toBe(
      'plants.photoPicker.cameraDenied'
    );
    expect(nativePhotoErrorMessage(new NativePhotoError('permission', 'library'), t)).toBe(
      'plants.photoPicker.libraryDenied'
    );
    expect(nativePhotoErrorMessage(new NativePhotoError('unavailable', 'camera'), t)).toBe(
      'plants.photoPicker.noCamera'
    );
    expect(nativePhotoErrorMessage(new Error('anything else'), t)).toBe(
      'plants.photoPicker.failed'
    );
  });

  it('reports a photo it could not read back as a failure', async () => {
    camera.takePhoto.mockResolvedValue({ type: 0, saved: false });
    await expect(pickNativePhoto('camera')).rejects.toMatchObject({ failure: 'failed' });
    camera.takePhoto.mockResolvedValue({ type: 0, saved: false, webPath: 'x' });
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    await expect(pickNativePhoto('camera')).rejects.toMatchObject({ failure: 'failed' });
  });
});
