import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PlantImageUpload } from '@/features/plants/PlantImageUpload';
import { plantService } from '@/services/plantService';
import { useAuthStore } from '@/store/authStore';
import { NativePhotoError } from '@/services/nativeCamera';
import { prepareImageForUpload } from '@/utils/image';

vi.mock('@/services/plantService', () => ({
  plantService: {
    getImageUploadUrl: vi.fn(),
    uploadImage: vi.fn(),
    confirmImageUpload: vi.fn(),
  },
}));

// The real pipeline (downscale + metadata strip) is covered by
// tests/unit/utils/imageMetadata.test.ts; here it hands the file through.
vi.mock('@/utils/image', () => ({
  prepareImageForUpload: vi.fn(async (file: Blob) => file),
}));

const pickNativePhoto = vi.hoisted(() => vi.fn());
vi.mock('@/services/nativeCamera', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/nativeCamera')>()),
  pickNativePhoto,
}));

function renderUpload(onUploadSuccess?: () => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <PlantImageUpload plantId="plant-1" onUploadSuccess={onUploadSuccess} />
    </QueryClientProvider>
  );
}

describe('PlantImageUpload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ activeHouseholdId: 'household-1' });
    vi.mocked(plantService.getImageUploadUrl).mockResolvedValue({
      uploadUrl: 'https://uploads.example/photo',
      imageUrl: 'https://images.example/photo.webp',
    });
    vi.mocked(plantService.confirmImageUpload).mockResolvedValue(undefined);
  });

  it('retries the same file after an upload failure', async () => {
    vi.mocked(plantService.uploadImage)
      .mockRejectedValueOnce(new Error('Upload connection failed'))
      .mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    const onUploadSuccess = vi.fn();
    renderUpload(onUploadSuccess);

    const file = new File(['plant-photo'], 'monstera.jpg', { type: 'image/jpeg' });
    await user.upload(screen.getByLabelText(/upload photo/i), file);

    expect(await screen.findByRole('alert')).toHaveTextContent('Upload connection failed');
    await user.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() => expect(plantService.uploadImage).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(plantService.confirmImageUpload).toHaveBeenCalledTimes(1));
    expect(vi.mocked(plantService.uploadImage).mock.calls[1][1]).toBe(file);
    // Each presign declares the type and the exact size of the file it is for.
    expect(plantService.getImageUploadUrl).toHaveBeenLastCalledWith(
      'plant-1',
      'image/jpeg',
      file.size
    );
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
    expect(onUploadSuccess).toHaveBeenCalledTimes(1);
  });

  describe('while a photo is uploading', () => {
    // Held open so the pending state can be looked at.
    function holdUpload() {
      let finish: () => void = () => {};
      vi.mocked(plantService.uploadImage).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = () => resolve();
          })
      );
      return () => finish();
    }

    it('keeps focus on the file control instead of dropping it', async () => {
      const finish = holdUpload();
      const user = userEvent.setup();
      renderUpload();
      const input = screen.getByLabelText(/upload photo/i);
      input.focus();

      await user.upload(input, new File(['photo'], 'fern.jpg', { type: 'image/jpeg' }));
      await screen.findByRole('progressbar');

      // A disabled control cannot keep focus, so the keyboard user who chose
      // the file was sent back to the top of the page (WCAG 2.4.3).
      expect(input).not.toBeDisabled();
      expect(input).toHaveAttribute('aria-disabled', 'true');
      expect(input).toHaveFocus();
      finish();
      await waitFor(() => expect(plantService.confirmImageUpload).toHaveBeenCalledTimes(1));
      expect(input).not.toHaveAttribute('aria-disabled');
    });

    it('does not open the picker again until the upload is done', async () => {
      const finish = holdUpload();
      const user = userEvent.setup();
      renderUpload();
      const input = screen.getByLabelText(/upload photo/i);
      await user.upload(input, new File(['photo'], 'fern.jpg', { type: 'image/jpeg' }));
      await screen.findByRole('progressbar');

      const click = new MouseEvent('click', { bubbles: true, cancelable: true });
      input.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(true);
      finish();
      await waitFor(() => expect(plantService.confirmImageUpload).toHaveBeenCalledTimes(1));
    });

    it('gives the progress bar a name', async () => {
      const finish = holdUpload();
      const user = userEvent.setup();
      renderUpload();
      await user.upload(
        screen.getByLabelText(/upload photo/i),
        new File(['photo'], 'fern.jpg', { type: 'image/jpeg' })
      );

      expect(await screen.findByRole('progressbar')).toHaveAccessibleName('Sending the photo…');
      finish();
      await waitFor(() => expect(plantService.confirmImageUpload).toHaveBeenCalledTimes(1));
    });

    it('says that the upload started and that it finished', async () => {
      const finish = holdUpload();
      const user = userEvent.setup();
      renderUpload();
      // The region is there before it has anything to say.
      const status = screen.getByRole('status');
      expect(status).toBeEmptyDOMElement();

      await user.upload(
        screen.getByLabelText(/upload photo/i),
        new File(['photo'], 'fern.jpg', { type: 'image/jpeg' })
      );
      await waitFor(() => expect(status).toHaveTextContent('Sending the photo…'));

      finish();
      await waitFor(() => expect(status).toHaveTextContent('Photo added'));
    });
  });

  describe('inside the native (Capacitor) shells', () => {
    beforeEach(() => {
      (window as unknown as { Capacitor?: unknown }).Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => 'ios',
      };
    });

    afterEach(() => {
      delete (window as unknown as { Capacitor?: unknown }).Capacitor;
    });

    it('offers the camera and the photo picker instead of a file input', async () => {
      renderUpload();
      expect(screen.getByRole('button', { name: 'Take photo' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Choose photo' })).toBeInTheDocument();
      expect(document.querySelector('input[type="file"]')).toBeNull();
    });

    it('uploads a photo taken with the camera through the same prepare-and-upload path', async () => {
      vi.mocked(plantService.uploadImage).mockResolvedValue(undefined);
      const photo = new File(['heic-or-jpeg'], 'plant-photo.jpg', { type: 'image/heic' });
      pickNativePhoto.mockResolvedValueOnce(photo);
      const onUploadSuccess = vi.fn();
      const user = userEvent.setup();
      renderUpload(onUploadSuccess);

      await user.click(screen.getByRole('button', { name: 'Take photo' }));

      expect(pickNativePhoto).toHaveBeenCalledWith('camera');
      // Not rejected for its type: the native photo goes straight to the
      // pipeline that re-encodes and strips it.
      await waitFor(() => expect(prepareImageForUpload).toHaveBeenCalledWith(photo));
      await waitFor(() => expect(plantService.confirmImageUpload).toHaveBeenCalledTimes(1));
      expect(onUploadSuccess).toHaveBeenCalledTimes(1);
    });

    it('does nothing when the picker is cancelled', async () => {
      pickNativePhoto.mockResolvedValueOnce(null);
      const user = userEvent.setup();
      renderUpload();
      await user.click(screen.getByRole('button', { name: 'Choose photo' }));
      expect(pickNativePhoto).toHaveBeenCalledWith('library');
      expect(plantService.getImageUploadUrl).not.toHaveBeenCalled();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('says how to turn camera access back on when it was denied', async () => {
      pickNativePhoto.mockRejectedValueOnce(new NativePhotoError('permission', 'camera'));
      const user = userEvent.setup();
      renderUpload();
      await user.click(screen.getByRole('button', { name: 'Take photo' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(/turn on camera access/i);
      expect(plantService.getImageUploadUrl).not.toHaveBeenCalled();
    });
  });
});
