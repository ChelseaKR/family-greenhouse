/**
 * The three-state rooms read (ADR 0010, #456). The property under test is the
 * one the seven old call sites could not express: a failed read is not an
 * empty one, and the difference has to survive as far as the component.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useSpaces } from '@/hooks/useSpaces';
import { spaceService } from '@/services/spaceService';
import { useAuthStore } from '@/store/authStore';

vi.mock('@/services/spaceService', () => ({
  spaceService: { getSpaces: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const room = {
  id: 'kitchen',
  householdId: 'hh-1',
  name: 'Kitchen',
  environment: 'inside' as const,
  createdAt: '',
  createdBy: 'u1',
  updatedAt: '',
};

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({
    user: {
      id: 'u-1',
      email: 'a@b.co',
      name: 'A',
      householdId: 'hh-1',
      householdRole: 'admin',
    },
    activeHouseholdId: 'hh-1',
  });
});

describe('useSpaces', () => {
  it('reports `unavailable` — not an empty room list — when the read fails', async () => {
    vi.mocked(spaceService.getSpaces).mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useSpaces(), { wrapper });

    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.unavailable).toBe(true);
    expect(result.current.spaces).toEqual([]);
    expect(result.current.byId.size).toBe(0);
  });

  it('reports `ready` with an empty list when the household genuinely has no rooms', async () => {
    vi.mocked(spaceService.getSpaces).mockResolvedValue([]);
    const { result } = renderHook(() => useSpaces(), { wrapper });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    // The whole point: this empty list and the one above are different answers.
    expect(result.current.unavailable).toBe(false);
    expect(result.current.spaces).toEqual([]);
  });

  it('reports `ready` with the rooms, keyed by id', async () => {
    vi.mocked(spaceService.getSpaces).mockResolvedValue([room]);
    const { result } = renderHook(() => useSpaces(), { wrapper });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.spaces).toEqual([room]);
    expect(result.current.byId.get('kitchen')?.name).toBe('Kitchen');
  });

  it('is never `unavailable` while the read is still in flight', async () => {
    let settle: (rooms: (typeof room)[]) => void = () => {};
    vi.mocked(spaceService.getSpaces).mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      })
    );
    const { result } = renderHook(() => useSpaces(), { wrapper });

    expect(result.current.status).toBe('loading');
    expect(result.current.unavailable).toBe(false);
    settle([room]);
    await waitFor(() => expect(result.current.status).toBe('ready'));
  });
});
