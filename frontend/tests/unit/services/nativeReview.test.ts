import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The rating ask's wiring (ADR 0036): gated on the bridge's plugin header,
 * counted per completion, asked only when the rules allow, and recorded only
 * when StoreKit was actually handed the request.
 *
 * lib/platform is mocked partially: the real implementations run unless a
 * test says otherwise, so the header gate is exercised against a pretended
 * `window.Capacitor`, and the asking tests can simply switch it on.
 */
const platform = vi.hoisted(() => ({
  getNativePlatform: vi.fn(),
  hasNativePlugin: vi.fn(),
}));
vi.mock('@/lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform')>();
  platform.getNativePlatform.mockImplementation(actual.getNativePlatform);
  platform.hasNativePlugin.mockImplementation(actual.hasNativePlugin);
  return {
    ...actual,
    getNativePlatform: platform.getNativePlatform,
    hasNativePlugin: platform.hasNativePlugin,
  };
});

import {
  ASK_DELAY_MS,
  NATIVE_REVIEW_METHODS,
  NATIVE_REVIEW_PLUGIN,
  hasNativeReview,
  noteCareDone,
  resetNativeReviewForTests,
  type ReviewDeps,
} from '@/services/nativeReview';
import { REVIEW_STATE_KEY, readReviewState, writeReviewState } from '@/lib/reviewPromptState';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-12T17:00:00.000Z');

type Header = { name: string; methods: Array<{ name: string }> };
const REVIEW_HEADER: Header = { name: 'NativeReview', methods: [{ name: 'requestReview' }] };
const APP_HEADER: Header = { name: 'App', methods: [{ name: 'getInfo' }] };

function pretendShell(platformName: 'ios' | 'android', headers: Header[]) {
  (window as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => platformName,
    PluginHeaders: headers,
  };
}

/** A shell with the plugin, a clock and a version the test controls. */
function deps(over: Partial<ReviewDeps> = {}) {
  const clock = { now: NOW };
  const requestReview = vi.fn(async () => true);
  const waits: number[] = [];
  const made: ReviewDeps = {
    available: () => true,
    now: () => clock.now,
    launch: 'launch-2',
    path: () => '/tasks',
    visible: () => true,
    wait: async (ms) => {
      waits.push(ms);
    },
    appVersion: async () => '0.43.0',
    requestReview,
    ...over,
  };
  return { made, clock, requestReview, waits };
}

beforeEach(() => {
  localStorage.clear();
  resetNativeReviewForTests();
});

afterEach(() => {
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
});

describe('hasNativeReview: the header gate', () => {
  it('is false on the website', () => {
    expect(hasNativeReview()).toBe(false);
  });

  it('is false in an iOS build whose bridge does not list NativeReview', () => {
    pretendShell('ios', [APP_HEADER]);
    expect(hasNativeReview()).toBe(false);
  });

  it('is false when NativeReview is listed without requestReview', () => {
    pretendShell('ios', [{ name: 'NativeReview', methods: [] }, APP_HEADER]);
    expect(hasNativeReview()).toBe(false);
  });

  it('is false when the App plugin (the version) is not listed', () => {
    pretendShell('ios', [REVIEW_HEADER]);
    expect(hasNativeReview()).toBe(false);
  });

  it('is true in the iOS app with both headers', () => {
    pretendShell('ios', [REVIEW_HEADER, APP_HEADER]);
    expect(hasNativeReview()).toBe(true);
    expect(platform.hasNativePlugin).toHaveBeenCalledWith(NATIVE_REVIEW_PLUGIN, ['requestReview']);
  });

  it('is true in the Android app with the same headers, and false there without them', () => {
    pretendShell('android', [REVIEW_HEADER, APP_HEADER]);
    expect(hasNativeReview()).toBe(true);
    pretendShell('android', [APP_HEADER]);
    expect(hasNativeReview()).toBe(false);
  });

  it('is false on iOS when the platform says so but the header lookup fails (partial mock)', () => {
    platform.getNativePlatform.mockReturnValueOnce('ios');
    platform.hasNativePlugin.mockReturnValueOnce(false);
    expect(hasNativeReview()).toBe(false);
  });
});

describe('noteCareDone', () => {
  it('records and asks nothing without the plugin (the website, an older build)', async () => {
    const { made, requestReview } = deps();
    // The real gate, on the website.
    expect(await noteCareDone({ ...made, available: hasNativeReview })).toBe('unavailable');
    expect(localStorage.getItem(REVIEW_STATE_KEY)).toBeNull();
    expect(requestReview).not.toHaveBeenCalled();
  });

  it('goes through the real header gate: with both headers on iOS it counts', async () => {
    pretendShell('ios', [REVIEW_HEADER, APP_HEADER]);
    const { made, requestReview } = deps();
    expect(await noteCareDone({ ...made, available: hasNativeReview })).toBe('counted');
    expect(readReviewState().completions).toBe(1);
    expect(requestReview).not.toHaveBeenCalled();
  });

  it('never asks during the first launch, however many tasks are done', async () => {
    const { made, requestReview } = deps({ launch: 'launch-1' });
    for (let i = 0; i < 6; i += 1) expect(await noteCareDone(made)).toBe('counted');
    expect(requestReview).not.toHaveBeenCalled();
    expect(readReviewState()).toMatchObject({ completions: 6, firstLaunch: 'launch-1' });
  });

  it('asks on the third completion in a later launch, after the pause, and records it', async () => {
    const first = deps({ launch: 'launch-1' });
    await noteCareDone(first.made);
    await noteCareDone(first.made);
    const { made, requestReview, waits } = deps({ launch: 'launch-2' });
    expect(await noteCareDone(made)).toBe('asked');
    expect(requestReview).toHaveBeenCalledOnce();
    expect(waits).toEqual([ASK_DELAY_MS]);
    expect(readReviewState()).toEqual({
      completions: 0,
      lastAskedAt: NOW,
      lastAskedVersion: '0.43.0',
    });
  });

  it('does not ask again in the same version, nor before 120 days in a new one', async () => {
    writeReviewState({ completions: 0, lastAskedAt: NOW, lastAskedVersion: '0.43.0' });
    const early = deps({ launch: 'launch-3' });
    for (let i = 0; i < 3; i += 1) await noteCareDone(early.made);
    const sameVersion = deps({ launch: 'launch-4' });
    sameVersion.clock.now = NOW + 200 * DAY;
    expect(await noteCareDone(sameVersion.made)).toBe('counted');
    const newVersionTooSoon = deps({ launch: 'launch-4', appVersion: async () => '0.44.0' });
    newVersionTooSoon.clock.now = NOW + 119 * DAY;
    expect(await noteCareDone(newVersionTooSoon.made)).toBe('counted');
    const newVersionLater = deps({ launch: 'launch-4', appVersion: async () => '0.44.0' });
    newVersionLater.clock.now = NOW + 120 * DAY;
    expect(await noteCareDone(newVersionLater.made)).toBe('asked');
    expect(sameVersion.requestReview).not.toHaveBeenCalled();
    expect(newVersionTooSoon.requestReview).not.toHaveBeenCalled();
    expect(newVersionLater.requestReview).toHaveBeenCalledOnce();
  });

  it('does not ask on a setup screen', async () => {
    writeReviewState({ completions: 2, firstLaunch: 'launch-1' });
    const { made, requestReview } = deps({ path: () => '/onboarding' });
    expect(await noteCareDone(made)).toBe('counted');
    expect(requestReview).not.toHaveBeenCalled();
  });

  it('does not ask when the person left the app or the screen during the pause', async () => {
    writeReviewState({ completions: 2, firstLaunch: 'launch-1' });
    const hidden = deps({ visible: () => false });
    expect(await noteCareDone(hidden.made)).toBe('counted');
    expect(hidden.requestReview).not.toHaveBeenCalled();

    let path = '/tasks';
    const moved = deps({
      path: () => path,
      wait: async () => {
        path = '/welcome';
      },
    });
    expect(await noteCareDone(moved.made)).toBe('counted');
    expect(moved.requestReview).not.toHaveBeenCalled();
  });

  it('records nothing as asked when StoreKit was not handed the request, so the next one tries', async () => {
    writeReviewState({ completions: 2, firstLaunch: 'launch-1' });
    const background = deps({ requestReview: vi.fn(async () => false) });
    expect(await noteCareDone(background.made)).toBe('not-shown');
    expect(readReviewState()).toMatchObject({ completions: 3, lastAskedAt: undefined });
    const foreground = deps();
    expect(await noteCareDone(foreground.made)).toBe('asked');
  });

  it('never asks without a version', async () => {
    writeReviewState({ completions: 2, firstLaunch: 'launch-1' });
    const { made, requestReview } = deps({ appVersion: async () => null });
    expect(await noteCareDone(made)).toBe('counted');
    expect(requestReview).not.toHaveBeenCalled();
  });

  it('asks once when two completions land together', async () => {
    writeReviewState({ completions: 2, firstLaunch: 'launch-1' });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { made, requestReview } = deps({ wait: () => gate });
    const first = noteCareDone(made);
    const second = noteCareDone(made);
    release();
    expect(await Promise.all([first, second])).toEqual(['asked', 'counted']);
    expect(requestReview).toHaveBeenCalledOnce();
  });

  it('never throws, even when the plugin call does', async () => {
    writeReviewState({ completions: 2, firstLaunch: 'launch-1' });
    const { made } = deps({
      requestReview: async () => {
        throw new Error('bridge gone');
      },
    });
    await expect(noteCareDone(made)).resolves.toBe('unavailable');
  });
});

describe('the native halves answer what the web reads', () => {
  // Neither is compiled in CI, so their source is held to the web's names.
  const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
  const swift = read('ios/App/App/NativeReviewPlugin.swift');
  const kotlin = read(
    'android/app/src/main/java/net/familygreenhouse/app/review/NativeReviewPlugin.kt'
  );
  const mainActivity = read('android/app/src/main/java/net/familygreenhouse/app/MainActivity.kt');

  it('registers under the same name and method on both platforms', () => {
    expect(swift).toContain(`jsName = "${NATIVE_REVIEW_PLUGIN}"`);
    expect(kotlin).toContain(`@CapacitorPlugin(name = "${NATIVE_REVIEW_PLUGIN}")`);
    for (const method of NATIVE_REVIEW_METHODS) {
      expect(swift).toContain(`CAPPluginMethod(name: "${method}"`);
      expect(kotlin).toMatch(new RegExp(`@PluginMethod\\s+fun ${method}\\(`));
    }
    expect(mainActivity).toContain('registerPlugin(NativeReviewPlugin::class.java)');
  });

  it('answers { requested } on every path', () => {
    expect(swift).toContain('call.resolve(["requested": true])');
    expect(swift).toContain('call.resolve(["requested": false])');
    expect(kotlin).toContain('put("requested", false)');
    expect(kotlin).toContain('put("requested", launched.isSuccessful)');
  });
});
