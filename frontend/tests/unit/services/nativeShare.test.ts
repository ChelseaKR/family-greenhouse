import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const share = vi.fn((_options: { url: string; dialogTitle?: string }) => Promise.resolve({}));
const canShare = vi.fn(() => Promise.resolve({ value: true }));

vi.mock('@capacitor/share', () => ({ Share: { share, canShare } }));

import { shareLinkNatively } from '@/services/nativeShare';

describe('shareLinkNatively', () => {
  beforeEach(() => {
    share.mockClear();
    canShare.mockClear();
  });

  afterEach(() => {
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  });

  it('leaves the website to its copy button', async () => {
    expect(await shareLinkNatively({ url: 'https://familygreenhouse.net/join/abc' })).toBe(false);
    expect(share).not.toHaveBeenCalled();
  });

  describe('inside the native shells', () => {
    beforeEach(() => {
      (window as unknown as { Capacitor?: unknown }).Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => 'android',
      };
    });

    it('opens the share sheet with the link', async () => {
      const url = 'https://familygreenhouse.net/sit/token';
      expect(await shareLinkNatively({ url, dialogTitle: 'Share link' })).toBe(true);
      expect(share).toHaveBeenCalledWith({ url, dialogTitle: 'Share link' });
    });

    it('treats closing the sheet as an answer, not a reason to copy anyway', async () => {
      share.mockImplementationOnce(() => Promise.reject(new Error('Share canceled')));
      expect(await shareLinkNatively({ url: 'https://familygreenhouse.net/x' })).toBe(true);
    });

    it('falls back to copying when the sheet cannot open', async () => {
      share.mockImplementationOnce(() => Promise.reject(new Error('Unable to share')));
      expect(await shareLinkNatively({ url: 'https://familygreenhouse.net/x' })).toBe(false);

      canShare.mockImplementationOnce(() => Promise.resolve({ value: false }));
      expect(await shareLinkNatively({ url: 'https://familygreenhouse.net/x' })).toBe(false);
    });
  });
});
