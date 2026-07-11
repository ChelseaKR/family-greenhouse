import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PlantImageUpload } from '@/features/plants/PlantImageUpload';
import { plantService } from '@/services/plantService';
import { useAuthStore } from '@/store/authStore';

vi.mock('@/services/plantService', () => ({
  plantService: {
    getImageUploadUrl: vi.fn(),
    uploadImage: vi.fn(),
    confirmImageUpload: vi.fn(),
  },
}));

vi.mock('@/utils/image', () => ({
  downscaleImage: vi.fn().mockResolvedValue(null),
}));

function renderUpload() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <PlantImageUpload plantId="plant-1" />
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
    renderUpload();

    const file = new File(['plant-photo'], 'monstera.jpg', { type: 'image/jpeg' });
    await user.upload(screen.getByLabelText(/upload photo/i), file);

    expect(await screen.findByRole('alert')).toHaveTextContent('Upload connection failed');
    await user.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() => expect(plantService.uploadImage).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(plantService.confirmImageUpload).toHaveBeenCalledTimes(1));
    expect(vi.mocked(plantService.uploadImage).mock.calls[1][1]).toBe(file);
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
  });
});
