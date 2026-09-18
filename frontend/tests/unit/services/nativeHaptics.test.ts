import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const notification = vi.fn((_options: { type: string }) => Promise.resolve());
const impact = vi.fn((_options: { style: string }) => Promise.resolve());

vi.mock('@capacitor/haptics', () => ({
  Haptics: { notification, impact },
  ImpactStyle: { Light: 'LIGHT', Medium: 'MEDIUM', Heavy: 'HEAVY' },
  NotificationType: { Success: 'SUCCESS', Warning: 'WARNING', Error: 'ERROR' },
}));

import { playHaptic } from '@/services/nativeHaptics';

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('playHaptic', () => {
  beforeEach(() => {
    notification.mockClear();
    impact.mockClear();
  });

  afterEach(() => {
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  });

  it('does nothing on the website', async () => {
    playHaptic('completed');
    playHaptic('snoozed');
    await settle();
    expect(notification).not.toHaveBeenCalled();
    expect(impact).not.toHaveBeenCalled();
  });

  describe('inside the native shells', () => {
    beforeEach(() => {
      (window as unknown as { Capacitor?: unknown }).Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => 'ios',
      };
    });

    it('plays the success pattern for a completed task', async () => {
      playHaptic('completed');
      await settle();
      expect(notification).toHaveBeenCalledWith({ type: 'SUCCESS' });
      expect(impact).not.toHaveBeenCalled();
    });

    it('plays one light tick for a snoozed task', async () => {
      playHaptic('snoozed');
      await settle();
      expect(impact).toHaveBeenCalledWith({ style: 'LIGHT' });
      expect(notification).not.toHaveBeenCalled();
    });

    it('never throws into the mutation that called it', async () => {
      notification.mockImplementationOnce(() => Promise.reject(new Error('unavailable')));
      expect(() => playHaptic('completed')).not.toThrow();
      await settle();
    });
  });
});
