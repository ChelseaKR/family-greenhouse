import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const getPreferred = vi.fn(() => Promise.resolve({ value: 1.35 }));
const set = vi.fn((_options: { value: number }) => Promise.resolve());
vi.mock('@capacitor/text-zoom', () => ({ TextZoom: { getPreferred, set } }));

import { MAX_TEXT_SCALE, clampTextScale, useNativeTextSize } from '@/hooks/useNativeTextSize';

function enterShell(platform: 'ios' | 'android') {
  (window as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => platform,
  };
}

describe('useNativeTextSize', () => {
  beforeEach(() => {
    getPreferred.mockClear();
    set.mockClear();
  });

  afterEach(() => {
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  });

  it('applies the iOS text size setting on launch', async () => {
    enterShell('ios');
    renderHook(() => useNativeTextSize());
    await waitFor(() => expect(set).toHaveBeenCalledWith({ value: 1.35 }));
  });

  it('applies it again when the app returns to the foreground', async () => {
    enterShell('ios');
    renderHook(() => useNativeTextSize());
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));

    getPreferred.mockResolvedValueOnce({ value: 0.82 });
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(set).toHaveBeenLastCalledWith({ value: 0.82 }));
  });

  it('leaves Android, whose WebView already follows the font scale, and the web alone', async () => {
    renderHook(() => useNativeTextSize());
    enterShell('android');
    renderHook(() => useNativeTextSize());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(getPreferred).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });
});

describe('clampTextScale', () => {
  it('keeps smaller and larger settings, up to the 200% the layout is built for', () => {
    expect(clampTextScale(0.82)).toBe(0.82);
    expect(clampTextScale(1.76)).toBe(1.76);
    expect(clampTextScale(3.12)).toBe(MAX_TEXT_SCALE);
  });

  it('falls back to the default on a value it cannot use', () => {
    expect(clampTextScale(Number.NaN)).toBe(1);
    expect(clampTextScale(0)).toBe(1);
  });
});
