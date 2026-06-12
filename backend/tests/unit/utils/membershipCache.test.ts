import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getCachedMembership,
  setCachedMembership,
  invalidateMembership,
  __resetMembershipCacheForTests,
} from '../../../src/utils/membershipCache.js';

describe('membershipCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetMembershipCacheForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetMembershipCacheForTests();
  });

  it('misses for a pairing never cached', () => {
    expect(getCachedMembership('u1', 'hh1')).toBeUndefined();
  });

  it('hits within the TTL, returning the cached role (no second lookup needed)', () => {
    setCachedMembership('u1', 'hh1', 'admin');
    expect(getCachedMembership('u1', 'hh1')).toBe('admin');

    // Just under the 60s TTL it is still a hit.
    vi.advanceTimersByTime(59_999);
    expect(getCachedMembership('u1', 'hh1')).toBe('admin');
  });

  it('keys on the (userId, householdId) pairing, not just the user', () => {
    setCachedMembership('u1', 'hh1', 'admin');
    setCachedMembership('u1', 'hh2', 'member');
    expect(getCachedMembership('u1', 'hh1')).toBe('admin');
    expect(getCachedMembership('u1', 'hh2')).toBe('member');
    expect(getCachedMembership('u2', 'hh1')).toBeUndefined();
  });

  it('expires entries once the TTL elapses', () => {
    setCachedMembership('u1', 'hh1', 'member');
    vi.advanceTimersByTime(60_000); // expiresAt <= now → expired
    expect(getCachedMembership('u1', 'hh1')).toBeUndefined();
  });

  it('a fresh set after expiry restarts the TTL window', () => {
    setCachedMembership('u1', 'hh1', 'member');
    vi.advanceTimersByTime(60_000);
    setCachedMembership('u1', 'hh1', 'admin');
    vi.advanceTimersByTime(30_000);
    expect(getCachedMembership('u1', 'hh1')).toBe('admin');
  });

  it('invalidateMembership(user, household) clears synchronously', () => {
    setCachedMembership('u1', 'hh1', 'admin');
    setCachedMembership('u1', 'hh2', 'member');

    invalidateMembership('u1', 'hh1');

    // Immediately gone — the very next read re-fetches from DDB.
    expect(getCachedMembership('u1', 'hh1')).toBeUndefined();
    // The sibling household entry is untouched.
    expect(getCachedMembership('u1', 'hh2')).toBe('member');
  });

  it('invalidateMembership(user) drops every household for that user only', () => {
    setCachedMembership('u1', 'hh1', 'admin');
    setCachedMembership('u1', 'hh2', 'member');
    setCachedMembership('u2', 'hh1', 'member');

    invalidateMembership('u1');

    expect(getCachedMembership('u1', 'hh1')).toBeUndefined();
    expect(getCachedMembership('u1', 'hh2')).toBeUndefined();
    expect(getCachedMembership('u2', 'hh1')).toBe('member');
  });

  it('user-wide invalidation does not clobber a user whose id is a prefix-collision risk', () => {
    // Keys are `<userId>#<householdId>`; invalidating "u1" must not match
    // user "u10" (prefix "u1#" vs key "u10#hh1").
    setCachedMembership('u10', 'hh1', 'admin');
    invalidateMembership('u1');
    expect(getCachedMembership('u10', 'hh1')).toBe('admin');
  });
});
