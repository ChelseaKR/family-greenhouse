import { describe, it, expect, beforeEach } from 'vitest';
import { useAuthStore } from '@/store/authStore';

describe('authStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    useAuthStore.setState({
      user: null,
      idToken: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,
      isLoading: true,
    });
  });

  it('sets user and marks as authenticated', () => {
    const user = {
      id: '123',
      email: 'test@example.com',
      name: 'Test User',
      householdId: null,
      householdRole: null,
    };

    useAuthStore.getState().setUser(user);

    const state = useAuthStore.getState();
    expect(state.user).toEqual(user);
    expect(state.isAuthenticated).toBe(true);
    expect(state.isLoading).toBe(false);
  });

  it('sets tokens correctly', () => {
    useAuthStore.getState().setTokens('id-token', 'access-token', 'refresh-token');

    const state = useAuthStore.getState();
    expect(state.idToken).toBe('id-token');
    expect(state.accessToken).toBe('access-token');
    expect(state.refreshToken).toBe('refresh-token');
  });

  it('sets household information', () => {
    // First set a user
    useAuthStore.getState().setUser({
      id: '123',
      email: 'test@example.com',
      name: 'Test User',
      householdId: null,
      householdRole: null,
    });

    // Then set household
    useAuthStore.getState().setHousehold('household-123', 'admin');

    const state = useAuthStore.getState();
    expect(state.user?.householdId).toBe('household-123');
    expect(state.user?.householdRole).toBe('admin');
  });

  it('clears state on logout', () => {
    // Set up authenticated state
    useAuthStore.getState().setUser({
      id: '123',
      email: 'test@example.com',
      name: 'Test User',
      householdId: 'household-123',
      householdRole: 'admin',
    });
    useAuthStore.getState().setTokens('id', 'access', 'refresh');

    // Logout
    useAuthStore.getState().logout();

    const state = useAuthStore.getState();
    expect(state.user).toBeNull();
    expect(state.idToken).toBeNull();
    expect(state.accessToken).toBeNull();
    expect(state.refreshToken).toBeNull();
    expect(state.isAuthenticated).toBe(false);
  });

  it('manages loading state', () => {
    useAuthStore.getState().setLoading(true);
    expect(useAuthStore.getState().isLoading).toBe(true);

    useAuthStore.getState().setLoading(false);
    expect(useAuthStore.getState().isLoading).toBe(false);
  });
});
