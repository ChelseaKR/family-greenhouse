import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { PlantImage } from '@/components/PlantImage';
import {
  SIGNED_PHOTO_REFRESH_INTERVAL_MS,
  __resetSignedPhotoRefreshForTests,
  isSignedPhotoUrl,
} from '@/hooks/useRefreshSignedPhotos';

/** The shape the API hands out (ADR 0033): an S3 presigned GET. */
const SIGNED =
  'https://fg-images.s3.us-east-1.amazonaws.com/plants/hh/p/a.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
  '&X-Amz-Date=20260918T120000Z&X-Amz-Expires=5400&X-Amz-Signature=' +
  'a'.repeat(64);

function mount(ui: ReactNode) {
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
  render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  return { invalidate };
}

describe('a plant photo whose signed URL has run out asks for fresh ones', () => {
  beforeEach(() => __resetSignedPhotoRefreshForTests());
  afterEach(() => vi.useRealTimers());

  it('refetches what is on screen when a signed photo fails to load', () => {
    const { invalidate } = mount(<PlantImage plant={{ name: 'Monstera', imageUrl: SIGNED }} />);
    fireEvent.error(screen.getByAltText('Photo of Monstera'));
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ refetchType: 'active' });
  });

  it('refetches at most once a minute, however many photos fail', () => {
    vi.useFakeTimers({ now: new Date('2026-09-18T12:00:00Z') });
    const { invalidate } = mount(
      <>
        <PlantImage plant={{ name: 'Monstera', imageUrl: SIGNED }} />
        <PlantImage plant={{ name: 'Pothos', imageUrl: `${SIGNED}&x=2` }} />
      </>
    );
    fireEvent.error(screen.getByAltText('Photo of Monstera'));
    fireEvent.error(screen.getByAltText('Photo of Pothos'));
    expect(invalidate).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + SIGNED_PHOTO_REFRESH_INTERVAL_MS);
    fireEvent.error(screen.getByAltText('Photo of Pothos'));
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it('leaves an unsigned image alone: refetching would not change it', () => {
    const { invalidate } = mount(
      <PlantImage plant={{ name: 'Fern', imageUrl: 'https://example.test/plants/hh/p/a.jpg' }} />
    );
    fireEvent.error(screen.getByAltText('Photo of Fern'));
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('recognizes a signed URL by its signature, not by its host', () => {
    expect(isSignedPhotoUrl(SIGNED)).toBe(true);
    expect(isSignedPhotoUrl('https://fg-images.s3.us-east-1.amazonaws.com/plants/hh/p/a.jpg')).toBe(
      false
    );
    expect(isSignedPhotoUrl('not a url')).toBe(false);
  });
});
