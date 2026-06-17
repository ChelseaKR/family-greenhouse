import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  setPendingShareCode,
  getPendingShareCode,
  clearPendingShareCode,
} from '@/features/plants/pendingShareCode';

/**
 * The pending-share-code helper is what carries a cutting's lineage link
 * through the register → confirm-email → onboarding flow, which otherwise
 * drops URL params. These tests pin its round-trip and its graceful
 * degradation when storage is unavailable (private mode).
 */
describe('pendingShareCode', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('round-trips a share code through sessionStorage', () => {
    expect(getPendingShareCode()).toBeNull();
    setPendingShareCode('share-123');
    expect(getPendingShareCode()).toBe('share-123');
  });

  it('clears the pending code once redeemed', () => {
    setPendingShareCode('share-123');
    clearPendingShareCode();
    expect(getPendingShareCode()).toBeNull();
  });

  it('degrades to no-op when storage throws (private mode / SSR)', () => {
    const blocked = () => {
      throw new Error('blocked');
    };
    vi.spyOn(window.sessionStorage, 'setItem').mockImplementation(blocked);
    vi.spyOn(window.sessionStorage, 'getItem').mockImplementation(blocked);

    // No throw, and the read falls back to "no pending graft".
    expect(() => setPendingShareCode('share-123')).not.toThrow();
    expect(getPendingShareCode()).toBeNull();
  });
});
