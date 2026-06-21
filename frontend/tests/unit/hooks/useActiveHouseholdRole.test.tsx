import { describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { http, HttpResponse } from 'msw';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useIsHouseholdAdmin } from '@/hooks/useActiveHouseholdRole';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('useIsHouseholdAdmin', () => {
  beforeEach(() => {
    // Claim DEFAULT household role is 'admin'; the user is a plain member of a
    // second household.
    useAuthStore.setState({
      isAuthenticated: true,
      user: { id: 'u1', email: 'a@b.com', householdId: 'hh-default', householdRole: 'admin' },
      activeHouseholdId: null,
    } as never);
    server.use(
      http.get(`${API}/me/households`, () =>
        HttpResponse.json([
          { householdId: 'hh-default', name: 'Default', role: 'admin' },
          { householdId: 'hh-other', name: 'Other', role: 'member' },
        ])
      )
    );
  });

  it('is true for the default household where the user is admin', async () => {
    const { result } = renderHook(() => useIsHouseholdAdmin(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('is FALSE after switching to a household where the user is only a member (the bug)', async () => {
    useAuthStore.setState({ activeHouseholdId: 'hh-other' } as never);
    const { result } = renderHook(() => useIsHouseholdAdmin(), { wrapper: makeWrapper() });
    // The claim default role is 'admin', but the ACTIVE household role is
    // 'member' — admin controls must NOT render (else the mutation 403s).
    await waitFor(() => expect(result.current).toBe(false));
  });
});
