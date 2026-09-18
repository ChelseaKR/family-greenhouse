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
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
    expect(onUploadSuccess).toHaveBeenCalledTimes(1);
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
