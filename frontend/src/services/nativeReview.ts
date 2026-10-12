import { getNativePlatform, hasNativePlugin } from '@/lib/platform';
import {
  THIS_LAUNCH,
  readReviewState,
  recordAsked,
  recordCompletion,
  shouldAskForReview,
  writeReviewState,
} from '@/lib/reviewPromptState';

/**
 * Asks for an App Store rating at a good moment, inside the iOS app only
 * (ADR 0036). The rules are in lib/reviewPromptState.ts; this file is the
 * wiring: the three places that confirm a care task was marked done (the
 * task list and plant pages, Today across homes, and a notification's Done
 * button) call {@link noteCareDone} next to their success haptic.
 *
 * Gated on the bridge's plugin headers, never on the platform alone: a
 * plugin's JavaScript must never be driven without its native half
 * (lib/platform.ts `hasNativePlugin`, ADR 0034). An iOS build without
 * NativeReview, Android and the website record nothing and ask nothing.
 */

/** The name the iOS app registers the plugin under (NativeReviewPlugin.swift `jsName`). */
export const NATIVE_REVIEW_PLUGIN = 'NativeReview';
export const NATIVE_REVIEW_METHODS = ['requestReview'];

/**
 * A breath after the success toast and haptic, so the sheet arrives after
 * the person has seen their care recorded, not on top of the tap.
 */
export const ASK_DELAY_MS = 1500;

export function hasNativeReview(): boolean {
  return (
    getNativePlatform() === 'ios' &&
    hasNativePlugin(NATIVE_REVIEW_PLUGIN, NATIVE_REVIEW_METHODS) &&
    // The version comes from @capacitor/app, which every build links; the
    // check keeps a pretended shell without it from driving it anyway.
    hasNativePlugin('App', ['getInfo'])
  );
}

export interface ReviewDeps {
  available: () => boolean;
  now: () => number;
  launch: string;
  path: () => string;
  visible: () => boolean;
  wait: (ms: number) => Promise<void>;
  appVersion: () => Promise<string | null>;
  requestReview: () => Promise<boolean>;
}

const defaultDeps: ReviewDeps = {
  available: hasNativeReview,
  now: () => Date.now(),
  launch: THIS_LAUNCH,
  path: () => (typeof window === 'undefined' ? '/' : window.location.pathname),
  visible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  appVersion: async () => (await import('@/services/nativeReviewPlugin')).appVersion(),
  requestReview: async () => (await import('@/services/nativeReviewPlugin')).requestReview(),
};

export type ReviewOutcome = 'unavailable' | 'counted' | 'asked' | 'not-shown';

let inFlight = false;

/**
 * A care task was marked done and the server accepted it. Counts it, and
 * when the rules allow, asks StoreKit for the rating sheet. Never throws.
 */
export async function noteCareDone(overrides: Partial<ReviewDeps> = {}): Promise<ReviewOutcome> {
  const deps = { ...defaultDeps, ...overrides };
  try {
    if (!deps.available()) return 'unavailable';
    const counted = recordCompletion(readReviewState(), deps.launch);
    writeReviewState(counted);
    if (inFlight) return 'counted';
    const context = { now: deps.now(), launch: deps.launch, path: deps.path() };
    // Everything but the version first, so the plugin chunk loads only when
    // the answer could be yes.
    if (!shouldAskForReview(counted, { ...context, version: 'unknown' })) return 'counted';
    inFlight = true;
    try {
      const version = await deps.appVersion();
      if (!shouldAskForReview(readReviewState(), { ...context, version })) return 'counted';
      await deps.wait(ASK_DELAY_MS);
      // The person may have left the screen or the app in the meantime.
      const later = { now: deps.now(), launch: deps.launch, path: deps.path(), version };
      if (!deps.visible() || !shouldAskForReview(readReviewState(), later)) return 'counted';
      const requested = await deps.requestReview();
      // Not handed to StoreKit (the app was in the background, say): nothing
      // was asked, so the next completion may try again.
      if (!requested || !version) return 'not-shown';
      writeReviewState(recordAsked(readReviewState(), { now: later.now, version }));
      return 'asked';
    } finally {
      inFlight = false;
    }
  } catch {
    return 'unavailable';
  }
}

/** Fire-and-forget form for the mutation callbacks. */
export function noteCareDoneInBackground(): void {
  void noteCareDone();
}

/** Test seam. */
export function resetNativeReviewForTests(): void {
  inFlight = false;
}
