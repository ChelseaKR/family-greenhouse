/**
 * Lightweight client-side A/B experiment harness.
 *
 * Each visitor is bucketed once, 50/50, into variant 'A' or 'B' for a
 * named experiment. The assignment is derived from a per-experiment
 * random value persisted in localStorage, so it is stable across reloads
 * and navigations for the same browser. No network, no SDK, no cookies —
 * the whole thing is a few reads/writes against localStorage.
 *
 * Design notes:
 *  - The random draw happens lazily inside a function at call time, never
 *    at module top level. `Math.random()` at import time is banned in this
 *    codebase (it makes module evaluation non-deterministic); using it
 *    inside a runtime function is fine.
 *  - We persist the *draw* (a float in [0,1)), not the resolved variant.
 *    That keeps the bucketing rule in one place: if we ever move the split
 *    off 50/50, existing visitors keep a stable, well-distributed value
 *    and simply re-resolve against the new threshold.
 *  - Everything degrades to a deterministic default ('A') when storage is
 *    unavailable (SSR, privacy mode, quota errors) so a render never throws.
 *
 * Removal: delete this file, the `experiment_viewed` event + super-property
 * plumbing in services/analytics.ts, and the variant branch in
 * features/landing/LandingPage.tsx. Nothing else depends on it.
 */

import { useSyncExternalStore } from 'react';

export type Variant = 'A' | 'B';

/** localStorage key prefix for the persisted random draw, per experiment. */
const STORAGE_PREFIX = 'fg_exp_';

/** The single experiment this harness currently powers. */
export const HERO_EXPERIMENT = 'landing_hero_framing';

function storageKey(experiment: string): string {
  return `${STORAGE_PREFIX}${experiment}`;
}

function safeGet(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, value);
  } catch {
    // Storage full or blocked — fall back to an in-memory-only assignment
    // for this session. Bucketing simply won't persist; that's acceptable.
  }
}

/**
 * Read (or lazily create + persist) the stable [0,1) draw for an
 * experiment. The draw is generated with `Math.random()` inside this
 * function — deliberately not at module scope.
 */
function getDraw(experiment: string): number {
  const key = storageKey(experiment);
  const stored = safeGet(key);
  if (stored !== null) {
    const parsed = Number.parseFloat(stored);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed < 1) return parsed;
  }
  const draw = Math.random();
  safeSet(key, draw.toString());
  return draw;
}

/**
 * Resolve the assigned variant for an experiment, bucketing the visitor
 * on first call and persisting the assignment for stability. 50/50 split.
 */
export function getVariant(experiment: string): Variant {
  return getDraw(experiment) < 0.5 ? 'A' : 'B';
}

/**
 * React hook returning the visitor's hero variant ('A' = control, the
 * current household hero; 'B' = the solo-first hero). Stable for the life
 * of the browser. Uses `useSyncExternalStore` with a no-op subscriber so
 * the value is read consistently and never tears between renders.
 */
export function useHeroVariant(): Variant {
  // PAUSED while the public routes are prerendered.
  //
  // The server snapshot has no localStorage, so it can only render the
  // control. The client snapshot then drew at random, and a 'B' draw
  // rewrote the hero *after* the prerendered HTML had painted — different
  // copy, different height, a measurable layout shift on roughly half of
  // landing-page visits. Before prerendering this cost nothing: the page
  // painted blank first, so there was no earlier state to shift from.
  // Lighthouse's CLS assertion caught it, and it failed by coin flip
  // rather than consistently, which is exactly the shape a retry hides.
  //
  // Pausing rather than deleting: the harness, the analytics event and the
  // variant copy all stay. `experiment_viewed` now honestly reports the
  // control, which is what every visitor actually sees.
  //
  // To resume: give the hero a fixed min-height so swapping copy moves
  // nothing below it, then restore `() => getVariant(HERO_EXPERIMENT)` as
  // the client snapshot. Re-running it as-is would reintroduce the shift.
  return useSyncExternalStore(
    () => () => {},
    () => 'A',
    () => 'A'
  );
}
