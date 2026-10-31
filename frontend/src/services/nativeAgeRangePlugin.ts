import { registerPlugin } from '@capacitor/core';
import { NATIVE_AGE_RANGE_PLUGIN } from '@/services/nativeAgeRange';

/**
 * The iPhone app's NativeAgeRange plugin (ios/App/App/NativeAgeRangePlugin.swift),
 * registered once. Loaded with a dynamic import, and only behind
 * `hasNativeAgeRange()`, so the website never downloads it. Never resolve a
 * promise with the plugin itself: it is a proxy that answers every property,
 * `then` included (services/loadNativeChrome.ts).
 */
interface NativeAgeRangePlugin {
  requestAgeRange(options: { requestPolicy: string }): Promise<unknown>;
  appTransaction(): Promise<{ signedAppTransaction?: string }>;
}

const NativeAgeRange = registerPlugin<NativeAgeRangePlugin>(NATIVE_AGE_RANGE_PLUGIN);

/** The plugin's raw answer; `lib/ageSignal.ts` parses it. */
export async function requestAgeRange(requestPolicy: string): Promise<unknown> {
  return NativeAgeRange.requestAgeRange({ requestPolicy });
}

/** Apple's signed app transaction (JWS), or null when StoreKit has none. */
export async function signedAppTransaction(): Promise<string | null> {
  const result = await NativeAgeRange.appTransaction();
  const jws = result?.signedAppTransaction;
  return typeof jws === 'string' && jws.length > 0 ? jws : null;
}
