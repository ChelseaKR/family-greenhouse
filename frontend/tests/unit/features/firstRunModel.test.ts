import { describe, expect, it } from 'vitest';
import {
  decideFirstRun,
  firstRunStepsFor,
  type FirstRunInputs,
} from '@/features/onboarding/firstRunModel';

const brandNew: FirstRunInputs = {
  hasHousehold: true,
  welcomeSeen: false,
  plantCount: 0,
  plantsFailed: false,
};

describe('decideFirstRun', () => {
  it('runs the first run for a household with no plants yet', () => {
    expect(decideFirstRun(brandNew)).toEqual({ kind: 'run' });
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

  it('treats a household that already has plants as established, and records it', () => {
    // The point of the plant count: someone on a new device, or someone who
    // joined an existing household, must not be told to add their first plant.
    expect(decideFirstRun({ ...brandNew, plantCount: 3 })).toEqual({
      kind: 'leave',
      to: '/dashboard',
      markSeen: true,
    });
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
});

describe('firstRunStepsFor', () => {
  it('offers the invite step to admins', () => {
    expect(firstRunStepsFor(true)).toEqual(['plant', 'invite']);
  });

  it('omits the invite step for members, who cannot create invites', () => {
    expect(firstRunStepsFor(false)).toEqual(['plant']);
  });
});
