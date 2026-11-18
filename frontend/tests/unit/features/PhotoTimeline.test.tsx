import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PhotoTimeline } from '@/features/plants/PhotoTimeline';
import { plantService } from '@/services/plantService';
import { useAuthStore } from '@/store/authStore';

vi.mock('@/services/plantService', () => ({
  plantService: { listPhotos: vi.fn() },
}));

function renderTimeline() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <PhotoTimeline plantId="plant-1" />
    </QueryClientProvider>
  );
}

describe('PhotoTimeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ activeHouseholdId: 'household-1' });
    vi.mocked(plantService.listPhotos).mockResolvedValue([
      { id: 'a', imageUrl: 'https://images.example/a.webp', uploadedAt: '2026-11-01T12:00:00Z' },
      { id: 'b', imageUrl: 'https://images.example/b.webp', uploadedAt: '2026-10-01T12:00:00Z' },
    ] as never);
  });

  it('can be reached and scrolled from the keyboard', async () => {
    // The strip scrolls sideways and its photos are not focusable. With no
    // tab stop a keyboard user could not get to the ones off the right edge
    // (WCAG 2.1.1). axe reports it in a browser, where the strip overflows;
    // jsdom has no layout, so the tab stop itself is asserted here.
    renderTimeline();
    const strip = await screen.findByRole('list', { name: 'Photo timeline' });
    expect(strip).toHaveClass('overflow-x-auto');
    expect(strip).toHaveAttribute('tabindex', '0');
    strip.focus();
    expect(strip).toHaveFocus();
  });

  it('gives each photo a text alternative that says when it was taken', async () => {
    renderTimeline();
    const images = await screen.findAllByRole('img');
    expect(images).toHaveLength(2);
    for (const image of images) expect(image).toHaveAccessibleName(/^Photo from /);
  });
});
