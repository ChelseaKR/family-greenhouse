import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const getPreferred = vi.fn(() => Promise.resolve({ value: 1.35 }));
const set = vi.fn((_options: { value: number }) => Promise.resolve());
vi.mock('@capacitor/text-zoom', () => ({ TextZoom: { getPreferred, set } }));

import { textScaleFor, useNativeTextSize } from '@/hooks/useNativeTextSize';

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

describe('textScaleFor', () => {
  it('applies every size the person chose, with no ceiling, the accessibility sizes included', () => {
    expect(textScaleFor(0.82)).toBe(0.82);
    expect(textScaleFor(1.76)).toBe(1.76);
    expect(textScaleFor(2)).toBe(2);
    // AX5, the largest iOS size: 53pt body text over the 17pt default.
    expect(textScaleFor(53 / 17)).toBe(53 / 17);
  });

  it('falls back to the default on a value it cannot use', () => {
    expect(textScaleFor(Number.NaN)).toBe(1);
    expect(textScaleFor(0)).toBe(1);
    expect(textScaleFor(-1)).toBe(1);
  });
});

it('hands the largest iOS size to the WebView as it is, not capped at 200%', async () => {
  (window as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'ios',
  };
  getPreferred.mockResolvedValueOnce({ value: 3.12 });
  set.mockClear();
  try {
    renderHook(() => useNativeTextSize());
    await waitFor(() => expect(set).toHaveBeenCalledWith({ value: 3.12 }));
  } finally {
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  }
});
