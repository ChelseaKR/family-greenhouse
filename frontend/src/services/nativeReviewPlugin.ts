import { registerPlugin } from '@capacitor/core';
import { App } from '@capacitor/app';
import { NATIVE_REVIEW_PLUGIN } from '@/services/nativeReview';

/**
 * The apps' NativeReview plugin (ios/App/App/NativeReviewPlugin.swift and the
 * Android app's review/NativeReviewPlugin.kt), registered once. Loaded with a
 * dynamic import, and only behind `hasNativeReview()`, so the website never
 * downloads it or
 * `@capacitor/core` through it. Never resolve a promise with the plugin
 * itself: it is a proxy that answers every property, `then` included
 * (services/loadNativeChrome.ts).
 */
interface NativeReviewPlugin {
  requestReview(): Promise<{ requested?: boolean }>;
}

const NativeReview = registerPlugin<NativeReviewPlugin>(NATIVE_REVIEW_PLUGIN);

/** True when the store was handed the request (Apple or Google still decides whether it shows). */
export async function requestReview(): Promise<boolean> {
  try {
    const result = await NativeReview.requestReview();
    return result?.requested === true;
  } catch {
    return false;
  }
}

/** The app's version (CFBundleShortVersionString, or Android's versionName), or null if it cannot be read. */
export async function appVersion(): Promise<string | null> {
  try {
    const info = await App.getInfo();
    return typeof info?.version === 'string' && info.version ? info.version : null;
  } catch {
    return null;
  }
}
