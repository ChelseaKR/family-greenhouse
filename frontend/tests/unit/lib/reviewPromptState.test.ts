import { beforeEach, describe, expect, it } from 'vitest';
import {
  COMPLETIONS_BEFORE_ASK,
  MIN_DAYS_BETWEEN_ASKS,
  NO_ASK_PATHS,
  REVIEW_STATE_KEY,
  readReviewState,
  recordAsked,
  recordCompletion,
  shouldAskForReview,
  writeReviewState,
  type ReviewPromptState,
} from '@/lib/reviewPromptState';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-12T17:00:00.000Z');
const FIRST = 'launch-1';
const LATER = 'launch-2';

/** Three completions, the first of them in an earlier launch. */
function ready(over: Partial<ReviewPromptState> = {}): ReviewPromptState {
  return { completions: COMPLETIONS_BEFORE_ASK, firstLaunch: FIRST, ...over };
}

const ctx = { now: NOW, version: '0.43.0', launch: LATER, path: '/tasks' };

describe('when the rating ask is allowed', () => {
  it('asks after three completions, in a later launch, on an app screen', () => {
    expect(COMPLETIONS_BEFORE_ASK).toBe(3);
    expect(shouldAskForReview(ready(), ctx)).toBe(true);
  });

  it('waits for the third completion', () => {
    expect(shouldAskForReview(ready({ completions: 2 }), ctx)).toBe(false);
  });

  it('never asks in the launch that recorded the first completion, so never on a first launch', () => {
    let state: ReviewPromptState = { completions: 0 };
    for (let i = 0; i < 5; i += 1) state = recordCompletion(state, FIRST);
    expect(state).toMatchObject({ completions: 5, firstLaunch: FIRST });
    expect(shouldAskForReview(state, { ...ctx, launch: FIRST })).toBe(false);
    // The next launch may.
    expect(shouldAskForReview(state, { ...ctx, launch: LATER })).toBe(true);
  });

  it('never asks with no first launch on record', () => {
    expect(shouldAskForReview({ completions: 9 }, ctx)).toBe(false);
  });

  it('never asks on a sign-in or first-run setup screen', () => {
    for (const path of NO_ASK_PATHS) {
      expect(shouldAskForReview(ready(), { ...ctx, path }), path).toBe(false);
      expect(shouldAskForReview(ready(), { ...ctx, path: `${path}/` }), `${path}/`).toBe(false);
    }
    expect(NO_ASK_PATHS).toEqual(expect.arrayContaining(['/onboarding', '/welcome', '/login']));
  });

  it('never asks without the app version', () => {
    expect(shouldAskForReview(ready(), { ...ctx, version: null })).toBe(false);
    expect(shouldAskForReview(ready(), { ...ctx, version: '' })).toBe(false);
  });

  it('asks at most once per app version', () => {
    const asked = ready({ lastAskedVersion: '0.43.0', lastAskedAt: NOW - 400 * DAY });
    expect(shouldAskForReview(asked, ctx)).toBe(false);
    expect(shouldAskForReview(asked, { ...ctx, version: '0.44.0' })).toBe(true);
  });

  it('waits at least 120 days between asks, to the millisecond', () => {
    expect(MIN_DAYS_BETWEEN_ASKS).toBe(120);
    const at = (days: number) =>
      ready({ lastAskedVersion: '0.42.0', lastAskedAt: NOW - days * DAY });
    expect(shouldAskForReview(at(119), ctx)).toBe(false);
    expect(
      shouldAskForReview(
        ready({ lastAskedVersion: '0.42.0', lastAskedAt: NOW - 120 * DAY + 1 }),
        ctx
      )
    ).toBe(false);
    expect(shouldAskForReview(at(120), ctx)).toBe(true);
  });

  it('waits when the clock is behind the last ask', () => {
    const state = ready({ lastAskedVersion: '0.42.0', lastAskedAt: NOW + DAY });
    expect(shouldAskForReview(state, ctx)).toBe(false);
  });

  it('an ask starts the count over and remembers when and in which version', () => {
    const after = recordAsked(ready({ completions: 7 }), { now: NOW, version: '0.43.0' });
    expect(after).toEqual({ completions: 0, lastAskedAt: NOW, lastAskedVersion: '0.43.0' });
    // Three more completions in a new version, 120 days on, across launches.
    let state = after;
    state = recordCompletion(state, 'launch-3');
    state = recordCompletion(state, 'launch-3');
    state = recordCompletion(state, 'launch-4');
    const later = { ...ctx, now: NOW + 121 * DAY, version: '0.44.0', launch: 'launch-4' };
    expect(shouldAskForReview(state, later)).toBe(true);
    expect(shouldAskForReview(state, { ...later, now: NOW + 100 * DAY })).toBe(false);
  });
});

describe('the stored state', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips through one localStorage key', () => {
    writeReviewState(ready({ lastAskedAt: NOW, lastAskedVersion: '0.43.0' }));
    expect(localStorage.length).toBe(1);
    expect(localStorage.key(0)).toBe(REVIEW_STATE_KEY);
    expect(readReviewState()).toEqual(ready({ lastAskedAt: NOW, lastAskedVersion: '0.43.0' }));
  });

  it('reads nothing, garbage or wrong types as a fresh start, which can only ask later', () => {
    expect(readReviewState()).toEqual({ completions: 0 });
    localStorage.setItem(REVIEW_STATE_KEY, '{not json');
    expect(readReviewState()).toEqual({ completions: 0 });
    localStorage.setItem(
      REVIEW_STATE_KEY,
      JSON.stringify({ completions: 'x', firstLaunch: 3, lastAskedAt: 'y', lastAskedVersion: 1 })
    );
    expect(readReviewState()).toEqual({
      completions: 0,
      firstLaunch: undefined,
      lastAskedAt: undefined,
      lastAskedVersion: undefined,
    });
  });
});
