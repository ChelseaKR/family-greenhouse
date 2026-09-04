import { describe, expect, it } from 'vitest';
import {
  decideFirstRun,
  firstRunStepsFor,
  NEW_MEMBER_WINDOW_MS,
  type FirstRunInputs,
} from '@/features/onboarding/firstRunModel';

const DAY = 24 * 60 * 60 * 1000;

/** Someone who has just created a household: nothing in it, nobody else. */
const brandNew: FirstRunInputs = {
  hasHousehold: true,
  welcomeSeen: false,
  plantCount: 0,
  plantsFailed: false,
  membershipAgeMs: 0,
  membershipUnknown: false,
};

/** A household that is already under way. */
const established = { plantCount: 3 } as const;

describe('decideFirstRun', () => {
  it('runs the first run for a household with no plants yet', () => {
    expect(decideFirstRun(brandNew)).toEqual({ kind: 'run', variant: 'founder' });
  });

  it('sends a user with no household to household setup', () => {
    expect(decideFirstRun({ ...brandNew, hasHousehold: false })).toEqual({
      kind: 'leave',
      to: '/onboarding',
      markSeen: false,
    });
  });

  it('never re-runs once this device has seen it', () => {
    expect(decideFirstRun({ ...brandNew, welcomeSeen: true })).toEqual({
      kind: 'leave',
      to: '/dashboard',
      markSeen: false,
    });
  });

  it('waits rather than guessing while the plant count is unsettled', () => {
    expect(decideFirstRun({ ...brandNew, plantCount: null })).toEqual({ kind: 'loading' });
  });

  it('does not read a failed plants call as an empty household', () => {
    // A 500 is not the number zero. Step aside, but record nothing, so the
    // next successful load can still decide properly.
    expect(decideFirstRun({ ...brandNew, plantCount: null, plantsFailed: true })).toEqual({
      kind: 'leave',
      to: '/dashboard',
      markSeen: false,
    });
  });

  it('prefers a failed read over a stale zero count', () => {
    expect(decideFirstRun({ ...brandNew, plantCount: 0, plantsFailed: true })).toEqual({
      kind: 'leave',
      to: '/dashboard',
      markSeen: false,
    });
  });

  it('steps aside for a returning member on a new device, and records it', () => {
    // The case the plant count was introduced for: an established household
    // AND an established member. Telling this person to add their first
    // plant would be wrong, and they have already had their first run.
    expect(decideFirstRun({ ...brandNew, ...established, membershipAgeMs: 240 * DAY })).toEqual({
      kind: 'leave',
      to: '/dashboard',
      markSeen: true,
    });
  });

  it('does not skip the first run for someone who just joined an established household', () => {
    // The defect this variant exists to fix: a household worth joining
    // already has plants, so `plantCount > 0` skipped EVERY joiner. The
    // household having started is not the same fact as this person having
    // started.
    expect(decideFirstRun({ ...brandNew, ...established, membershipAgeMs: 30 * 1000 })).toEqual({
      kind: 'run',
      variant: 'joiner',
    });
  });

  it('welcomes a joiner right up to the edge of the new-member window', () => {
    expect(
      decideFirstRun({ ...brandNew, ...established, membershipAgeMs: NEW_MEMBER_WINDOW_MS })
    ).toEqual({ kind: 'run', variant: 'joiner' });
  });

  it('treats a member past the window as established rather than new', () => {
    expect(
      decideFirstRun({ ...brandNew, ...established, membershipAgeMs: NEW_MEMBER_WINDOW_MS + 1 })
    ).toEqual({ kind: 'leave', to: '/dashboard', markSeen: true });
  });

  it('treats clock skew that puts the join date in the future as brand new', () => {
    expect(decideFirstRun({ ...brandNew, ...established, membershipAgeMs: -5000 })).toEqual({
      kind: 'run',
      variant: 'joiner',
    });
  });

  it('still calls a plant-less household a founder without waiting on the membership read', () => {
    // The founder path must not be delayed by a second fact it does not
    // need — nobody can be joining an established household that has no
    // plants in it.
    expect(decideFirstRun({ ...brandNew, membershipAgeMs: null, membershipUnknown: true })).toEqual(
      { kind: 'run', variant: 'founder' }
    );
  });

  it('waits rather than guessing while the membership age is unsettled', () => {
    expect(decideFirstRun({ ...brandNew, ...established, membershipAgeMs: null })).toEqual({
      kind: 'loading',
    });
  });

  it('does not spend the one first run on a membership read it could not make', () => {
    // Same rule as `plantsFailed`: an unreadable join date is not "this
    // person is established". Leaving WITHOUT markSeen keeps the next
    // successful load able to decide.
    expect(
      decideFirstRun({
        ...brandNew,
        ...established,
        membershipAgeMs: null,
        membershipUnknown: true,
      })
    ).toEqual({ kind: 'leave', to: '/dashboard', markSeen: false });
  });

  it('does not read an unusable join date as a fresh one', () => {
    // A `joinedAt` that failed to parse arrives as unknown, never as 0. If
    // it were coalesced to 0 this case would run the joiner flow at every
    // sign-in on a new device, forever.
    expect(
      decideFirstRun({ ...brandNew, ...established, membershipAgeMs: 0, membershipUnknown: true })
    ).toEqual({ kind: 'leave', to: '/dashboard', markSeen: false });
  });
});

describe('firstRunStepsFor', () => {
  it('offers the invite step to admins', () => {
    expect(firstRunStepsFor(true)).toEqual(['plant', 'invite']);
  });

  it('omits the invite step for members, who cannot create invites', () => {
    expect(firstRunStepsFor(false)).toEqual(['plant']);
  });
});
