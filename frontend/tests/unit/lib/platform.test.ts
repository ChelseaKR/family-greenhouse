import { afterEach, describe, expect, it } from 'vitest';
import { markNativePlatform } from '@/lib/platform';

/**
 * `<html data-native>` is the one switch every native-only CSS rule keys on
 * (index.css, "Inside the native shells"). On the website it must never be
 * set: that absence is what keeps the website rendering exactly as before.
 */
describe('markNativePlatform', () => {
  afterEach(() => {
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
    delete document.documentElement.dataset.native;
  });

  it('marks <html data-native="ios"> inside the iOS app', () => {
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
    };
    markNativePlatform();
    expect(document.documentElement.getAttribute('data-native')).toBe('ios');
  });

  it('marks "android" inside the Android app', () => {
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
    };
    markNativePlatform();
    expect(document.documentElement.getAttribute('data-native')).toBe('android');
  });

  it('sets nothing on the website', () => {
    markNativePlatform();
    expect(document.documentElement.hasAttribute('data-native')).toBe(false);
  });

  it('sets nothing when @capacitor/core reports the web platform', () => {
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => false,
      getPlatform: () => 'web',
    };
    markNativePlatform();
    expect(document.documentElement.hasAttribute('data-native')).toBe(false);
  });
});
