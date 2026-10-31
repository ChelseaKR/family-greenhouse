import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The age signal's wiring (services/nativeAgeRange.ts): asked once per
 * launch, gated on the bridge's plugin header, a failure is `unavailable`,
 * and the signed app transaction goes to the server only for a known minor.
 */
import {
  NATIVE_AGE_RANGE_METHODS,
  NATIVE_AGE_RANGE_PLUGIN,
  hasNativeAgeRange,
  loadAgeSignal,
  registerAppTransactionIfMinor,
  resetAgeSignalForTests,
  settledAgeSignal,
} from '@/services/nativeAgeRange';
import { parseAgeSignal } from '@/lib/ageSignal';

type Header = { name: string; methods: Array<{ name: string }> };
const AGE_HEADER: Header = {
  name: NATIVE_AGE_RANGE_PLUGIN,
  methods: NATIVE_AGE_RANGE_METHODS.map((name) => ({ name })),
};

function pretendShell(platformName: 'ios' | 'android', headers: Header[]) {
  (window as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => platformName,
    PluginHeaders: headers,
  };
}

beforeEach(() => {
  resetAgeSignalForTests();
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
});
afterEach(() => {
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
});

describe('hasNativeAgeRange', () => {
  it('is false on the website, on Android and in an iOS build without the plugin', () => {
    expect(hasNativeAgeRange()).toBe(false);
    pretendShell('android', [AGE_HEADER]);
    expect(hasNativeAgeRange()).toBe(false);
    pretendShell('ios', []);
    expect(hasNativeAgeRange()).toBe(false);
    pretendShell('ios', [AGE_HEADER]);
    expect(hasNativeAgeRange()).toBe(true);
  });
});

describe('loadAgeSignal', () => {
  it('without the plugin, settles at once as unavailable, never adult', async () => {
    const request = vi.fn();
    expect(settledAgeSignal()).toEqual({ status: 'unavailable', reason: 'pluginMissing' });
    expect(await loadAgeSignal({ request })).toEqual({
      status: 'unavailable',
      reason: 'pluginMissing',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('asks once per launch with the configured policy and shares the answer', async () => {
    const request = vi.fn(async () => ({ status: 'known', bracket: 'age13to15' }));
    const first = loadAgeSignal({ available: () => true, request });
    const second = loadAgeSignal({ available: () => true, request });
    expect(await first).toEqual(await second);
    expect((await first).status).toBe('known');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('onlyWhenRequired');
  });

  it('a plugin failure (older iOS bridge, crash) is unavailable', async () => {
    const signal = await loadAgeSignal({
      available: () => true,
      request: vi.fn(async () => {
        throw new Error('bridge');
      }),
    });
    expect(signal).toEqual({ status: 'unavailable', reason: 'requestFailed' });
  });

  it('a declined share is unavailable', async () => {
    const signal = await loadAgeSignal({
      available: () => true,
      request: vi.fn(async () => ({ status: 'unavailable', reason: 'declinedSharing' })),
    });
    expect(signal).toEqual({ status: 'unavailable', reason: 'declinedSharing' });
  });
});

describe('registerAppTransactionIfMinor', () => {
  const deps = () => ({
    signedAppTransaction: vi.fn(async () => 'header.payload.signature'),
    register: vi.fn(async () => undefined),
  });

  it('registers for a known minor, once per account per launch', async () => {
    const d = deps();
    const minor = parseAgeSignal({ status: 'known', bracket: 'age16to17' });
    expect(await registerAppTransactionIfMinor('u1', minor, d)).toBe('registered');
    expect(await registerAppTransactionIfMinor('u1', minor, d)).toBe('skipped');
    expect(d.register).toHaveBeenCalledTimes(1);
    expect(d.register).toHaveBeenCalledWith('header.payload.signature');
  });

  it('never sends anything for an adult or for a missing signal', async () => {
    const d = deps();
    for (const raw of [
      { status: 'known', bracket: 'adult' },
      { status: 'unavailable', reason: 'platformUnsupported' },
      { status: 'unavailable', reason: 'declinedSharing' },
      undefined,
    ]) {
      expect(await registerAppTransactionIfMinor('u2', parseAgeSignal(raw), d)).toBe('skipped');
    }
    expect(d.signedAppTransaction).not.toHaveBeenCalled();
    expect(d.register).not.toHaveBeenCalled();
  });

  it('a failed post is retried at the next call', async () => {
    const d = deps();
    d.register.mockRejectedValueOnce(new Error('offline'));
    const minor = parseAgeSignal({ status: 'known', bracket: 'under13' });
    expect(await registerAppTransactionIfMinor('u3', minor, d)).toBe('failed');
    expect(await registerAppTransactionIfMinor('u3', minor, d)).toBe('registered');
  });
});
