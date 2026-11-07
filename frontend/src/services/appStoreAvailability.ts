import { getNativePlatform, hasNativePlugin } from '@/lib/platform';

/**
 * Whether Apple In-App Purchase is offered here at all (ADR 0041). Two
 * switches must both be on:
 *
 *   1. The BUILD: `VITE_APP_STORE_PURCHASES=true` in the store build's
 *      environment. Off by default, and in every web build.
 *   2. The BINARY: the iOS app registers the NativePurchases plugin
 *      (ios/App/App/NativePurchasesPlugin.swift). Read from the bridge's
 *      plugin headers, never from the platform alone (lib/platform.ts
 *      `hasNativePlugin`, ADR 0034).
 *
 * Kept apart from services/appStorePurchases.ts so the screens that only ask
 * this question do not load the purchase flow.
 */

/** The name the iOS app registers the plugin under (NativePurchasesPlugin.swift `jsName`). */
export const NATIVE_PURCHASES_PLUGIN = 'NativePurchases';
export const NATIVE_PURCHASES_METHODS = [
  'getProducts',
  'purchase',
  'currentEntitlements',
  'restore',
  'finish',
  'manageSubscriptions',
];

/** Build switch: off unless the store build sets it to exactly "true". */
export function appStorePurchasesEnabled(): boolean {
  return import.meta.env.VITE_APP_STORE_PURCHASES === 'true';
}

/** Both switches, and the iPhone app. Never true on the website or Android. */
export function appStorePurchasesAvailable(): boolean {
  return (
    appStorePurchasesEnabled() &&
    getNativePlatform() === 'ios' &&
    hasNativePlugin(NATIVE_PURCHASES_PLUGIN, NATIVE_PURCHASES_METHODS)
  );
}
