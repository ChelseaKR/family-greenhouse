import { registerPlugin } from '@capacitor/core';
import { App } from '@capacitor/app';
import { NATIVE_REVIEW_PLUGIN } from '@/services/nativeReview';

/**
 * The iOS app's NativeReview plugin (ios/App/App/NativeReviewPlugin.swift),
 * registered once. Loaded with a dynamic import, and only behind
 * `hasNativeReview()`, so the website and Android never download it or
 * `@capacitor/core` through it. Never resolve a promise with the plugin
 * itself: it is a proxy that answers every property, `then` included
 * (services/loadNativeChrome.ts).
 */
interface NativeReviewPlugin {
  requestReview(): Promise<{ requested?: boolean }>;
}

const NativeReview = registerPlugin<NativeReviewPlugin>(NATIVE_REVIEW_PLUGIN);

/** True when StoreKit was handed the request (Apple still decides whether the sheet shows). */
export async function requestReview(): Promise<boolean> {
  try {
    const result = await NativeReview.requestReview();
    return result?.requested === true;
  } catch {
    return false;
  }
}

/** The app's version (CFBundleShortVersionString), or null if it cannot be read. */
export async function appVersion(): Promise<string | null> {
  try {
    const info = await App.getInfo();
    return typeof info?.version === 'string' && info.version ? info.version : null;
  } catch {
    return null;
  }
}
