import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPendingConfirmation,
  getPendingConfirmation,
  setPendingConfirmation,
} from '@/features/auth/pendingConfirmation';

describe('pending confirmation context', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('round-trips and clears an email plus safe redirect intent', () => {
    setPendingConfirmation({ email: 'new@example.com', redirect: '/join/code-1' });
    expect(getPendingConfirmation()).toEqual({
      email: 'new@example.com',
      redirect: '/join/code-1',
    });

    clearPendingConfirmation();
    expect(getPendingConfirmation()).toBeNull();
  });

  it('ignores malformed storage', () => {
    sessionStorage.setItem('fg.pendingConfirmation', '{not-json');
    expect(getPendingConfirmation()).toBeNull();
  });
});
