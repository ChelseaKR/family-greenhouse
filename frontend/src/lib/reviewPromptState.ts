/**
 * When the apps may ask for a store rating (ADR 0036).
 *
 * The ask is the store's own rating card (Apple's StoreKit sheet on iOS,
 * Google Play's in-app review on Android, through the app's NativeReview
 * plugin), and it comes only after something went well: a care
 * task the person marked done, in the app or from a notification's Done
 * button. The store decides whether it actually appears (Apple shows it at
 * most three times a year; Play keeps its own quota); these rules are ours,
 * and stricter:
 *
 * - Not before the person has marked care done {@link COMPLETIONS_BEFORE_ASK}
 *   times since the last ask (or since install).
 * - Never in the launch that recorded the first of those completions, so
 *   never on a first launch.
 * - Never on a sign-in or first-run setup screen.
 * - At most once per app version, and at least {@link MIN_DAYS_BETWEEN_ASKS}
 *   days apart.
 *
 * Nobody is asked whether they like the app first, and nothing is offered
 * for a rating (App Review Guideline 5.6.1).
 *
 * The state lives in `localStorage`, which goes with the app when it is
 * deleted (on Android, unless Auto Backup restores it). Every
 * function here is pure over its inputs (the clock, the version, the launch
 * and the path are passed in), so the rules are unit-tested without a shell.
 */

export const REVIEW_STATE_KEY = 'fg.reviewPrompt';
export const COMPLETIONS_BEFORE_ASK = 3;
export const MIN_DAYS_BETWEEN_ASKS = 120;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Sign-in and first-run setup. The same list as the iOS edge-swipe policy
 * (MainViewController.swift `BackSwipePolicy`) and the Android app's
 * `BackPolicy.kt`.
 */
export const NO_ASK_PATHS: readonly string[] = [
  '/login',
  '/register',
  '/confirm-email',
  '/forgot-password',
  '/reset-password',
  '/onboarding',
  '/welcome',
];

export interface ReviewPromptState {
  /** Care marked done since the last ask (or since install). */
  completions: number;
  /** The launch that recorded the first of those completions. */
  firstLaunch?: string;
  /** When the app last asked the store for its rating card (ms since epoch). */
  lastAskedAt?: number;
  /** The app version (CFBundleShortVersionString) it last asked in. */
  lastAskedVersion?: string;
}

/** Names this launch (this page load), so the first one can be told apart. */
export const THIS_LAUNCH = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function readReviewState(): ReviewPromptState {
  try {
    const raw = localStorage.getItem(REVIEW_STATE_KEY);
    if (!raw) return { completions: 0 };
    const parsed = JSON.parse(raw) as Partial<ReviewPromptState> | null;
    return {
      completions:
        typeof parsed?.completions === 'number' && parsed.completions >= 0
          ? Math.floor(parsed.completions)
          : 0,
      firstLaunch: typeof parsed?.firstLaunch === 'string' ? parsed.firstLaunch : undefined,
      lastAskedAt:
        typeof parsed?.lastAskedAt === 'number' && Number.isFinite(parsed.lastAskedAt)
          ? parsed.lastAskedAt
          : undefined,
      lastAskedVersion:
        typeof parsed?.lastAskedVersion === 'string' ? parsed.lastAskedVersion : undefined,
    };
  } catch {
    return { completions: 0 };
  }
}

export function writeReviewState(state: ReviewPromptState): void {
  try {
    localStorage.setItem(REVIEW_STATE_KEY, JSON.stringify(state));
  } catch {
    // Storage refused: the count starts over, so the app asks later, never sooner.
  }
}

/** One more care task marked done, in `launch`. */
export function recordCompletion(state: ReviewPromptState, launch: string): ReviewPromptState {
  return {
    ...state,
    completions: state.completions + 1,
    firstLaunch: state.firstLaunch ?? launch,
  };
}

export interface AskContext {
  now: number;
  /** The app's version; null when it could not be read, which never asks. */
  version: string | null;
  launch: string;
  path: string;
}

function normalizedPath(path: string): string {
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1);
  return path || '/';
}

/** Whether this moment may ask the store for its rating card. */
export function shouldAskForReview(state: ReviewPromptState, ctx: AskContext): boolean {
  if (state.completions < COMPLETIONS_BEFORE_ASK) return false;
  if (!state.firstLaunch || state.firstLaunch === ctx.launch) return false;
  if (NO_ASK_PATHS.includes(normalizedPath(ctx.path))) return false;
  if (!ctx.version) return false;
  if (state.lastAskedVersion === ctx.version) return false;
  if (state.lastAskedAt !== undefined) {
    // A clock that moved backwards past the last ask waits too.
    if (ctx.now < state.lastAskedAt) return false;
    if (ctx.now - state.lastAskedAt < MIN_DAYS_BETWEEN_ASKS * DAY_MS) return false;
  }
  return true;
}

/** The store was asked: start counting again, and remember when and in which version. */
export function recordAsked(
  _state: ReviewPromptState,
  ctx: { now: number; version: string }
): ReviewPromptState {
  return { completions: 0, lastAskedAt: ctx.now, lastAskedVersion: ctx.version };
}
