import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

type StateListener = (state: { isActive: boolean }) => void;
let stateListener: StateListener | undefined;
const remove = vi.fn(() => Promise.resolve());
const addListener = vi.fn((_event: string, listener: StateListener) => {
  stateListener = listener;
  return Promise.resolve({ remove });
});
vi.mock('@capacitor/app', () => ({ App: { addListener } }));

import { RESUME_REFRESH_AFTER_MS, useNativeResumeRefresh } from '@/hooks/useNativeResumeRefresh';

function mount() {
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useNativeResumeRefresh(), { wrapper });
  return { invalidate, ...hook };
}

describe('useNativeResumeRefresh', () => {
  beforeEach(() => {
    stateListener = undefined;
    addListener.mockClear();
    remove.mockClear();
  });

  afterEach(() => {
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
    vi.useRealTimers();
  });

  it('listens for nothing on the website', async () => {
    mount();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(addListener).not.toHaveBeenCalled();
  });

  describe('inside the native shells', () => {
    beforeEach(() => {
      (window as unknown as { Capacitor?: unknown }).Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => 'ios',
      };
    });

    it('refetches what is on screen after the app has been away a while', async () => {
      const { invalidate } = mount();
      await waitFor(() => expect(stateListener).toBeDefined());

      vi.setSystemTime(new Date(2026, 8, 18, 8, 0, 0));
      stateListener!({ isActive: false });
      vi.setSystemTime(new Date(2026, 8, 18, 12, 30, 0));
      stateListener!({ isActive: true });

      expect(invalidate).toHaveBeenCalledExactlyOnceWith({ refetchType: 'active' });
    });

    it('leaves a quick app switch alone', async () => {
      const { invalidate } = mount();
      await waitFor(() => expect(stateListener).toBeDefined());

      vi.setSystemTime(new Date(2026, 8, 18, 8, 0, 0));
      stateListener!({ isActive: false });
      vi.setSystemTime(new Date(2026, 8, 18, 8, 0, 0).getTime() + RESUME_REFRESH_AFTER_MS - 1000);
      stateListener!({ isActive: true });

      expect(invalidate).not.toHaveBeenCalled();
    });

    it('removes its listener on unmount', async () => {
      const { unmount } = mount();
      await waitFor(() => expect(stateListener).toBeDefined());
      await new Promise((resolve) => setTimeout(resolve, 0));
      unmount();
      expect(remove).toHaveBeenCalled();
    });
  });
});
