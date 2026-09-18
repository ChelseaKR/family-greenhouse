import { describe, expect, it } from 'vitest';
import {
  LEAVE_REFUSAL_CODES,
  LEAVE_REFUSAL_MESSAGES,
  isRenewingSubscription,
  rosterRefusal,
} from '../../../src/services/leaveHouseholdRules.js';

describe('rosterRefusal (#686)', () => {
  it('refuses the only member, whatever their role', () => {
    expect(rosterRefusal('u1', [{ userId: 'u1', role: 'admin' }])).toBe('LAST_MEMBER');
    expect(rosterRefusal('u1', [{ userId: 'u1', role: 'member' }])).toBe('LAST_MEMBER');
  });

  it('refuses the sole admin of a household with other members', () => {
    expect(
      rosterRefusal('u1', [
        { userId: 'u1', role: 'admin' },
        { userId: 'u2', role: 'member' },
        { userId: 'u3', role: 'member' },
      ])
    ).toBe('LAST_ADMIN');
  });

  it('lets an admin go when another admin stays', () => {
    expect(
      rosterRefusal('u1', [
        { userId: 'u1', role: 'admin' },
        { userId: 'u2', role: 'admin' },
      ])
    ).toBeNull();
  });

  it('lets a plain member go even when there is only one admin', () => {
    expect(
      rosterRefusal('u2', [
        { userId: 'u1', role: 'admin' },
        { userId: 'u2', role: 'member' },
      ])
    ).toBeNull();
  });
});

describe('isRenewingSubscription', () => {
  it.each([
    ['active', true],
    ['trialing', true],
    ['past_due', true],
    ['unpaid', true],
    ['canceled', false],
    ['incomplete_expired', false],
    ['incomplete', false],
  ])('status %s → %s', (status, expected) => {
    expect(isRenewingSubscription({ stripeSubscriptionId: 'sub_1', status })).toBe(expected);
  });

  it('is false once the plan is set to end at period end', () => {
    expect(
      isRenewingSubscription({
        stripeSubscriptionId: 'sub_1',
        status: 'active',
        cancelAtPeriodEnd: true,
      })
    ).toBe(false);
  });

  it('is false with no subscription on file (free, lifetime, gift, no-card trial)', () => {
    expect(isRenewingSubscription({ status: 'active' })).toBe(false);
    expect(isRenewingSubscription({ stripeSubscriptionId: null, status: 'active' })).toBe(false);
  });
});

describe('LEAVE_REFUSAL_MESSAGES', () => {
  it('has a message for every code', () => {
    for (const code of Object.values(LEAVE_REFUSAL_CODES)) {
      expect(LEAVE_REFUSAL_MESSAGES[code].length).toBeGreaterThan(20);
    }
  });
});
