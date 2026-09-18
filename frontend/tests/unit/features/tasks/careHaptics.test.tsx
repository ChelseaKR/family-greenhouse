/**
 * The haptic is the server's answer, not the tap: a completion or snooze that
 * the API accepted plays one, and one it refused plays none.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { useCompleteTaskMutation, useSkipCycleMutation } from '@/features/tasks/taskMutations';
import { useToastStore } from '@/store/toastStore';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../../msw/server';

const playHaptic = vi.fn();
vi.mock('@/services/nativeHaptics', () => ({ playHaptic: (cue: string) => playHaptic(cue) }));

const API = 'http://localhost:4000';

const task = {
  id: 't1',
  plantId: 'p1',
  plantName: 'Fern',
  type: 'water',
  frequency: 7,
  lastCompleted: null,
  nextDue: '2026-09-08T09:00:00.000Z',
  assignedTo: null,
  assignedToName: null,
  notes: null,
  createdBy: 'u1',
  createdAt: '',
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  playHaptic.mockClear();
  useToastStore.setState({ toasts: [] });
  useAuthStore.setState({
    user: { id: 'u1', email: 'u@example.com', name: 'Me', householdId: 'hh-1' } as never,
    isAuthenticated: true,
  });
});

describe('care haptics', () => {
  it('plays the completed cue once the server accepts a completion', async () => {
    server.use(http.post(`${API}/tasks/t1/complete`, () => HttpResponse.json(task)));
    const { result } = renderHook(() => useCompleteTaskMutation('hh-1'), { wrapper });

    act(() => result.current.mutate({ taskId: 't1', expectedNextDue: task.nextDue }));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(playHaptic).toHaveBeenCalledExactlyOnceWith('completed');
  });

  it('plays nothing when the server refuses the completion', async () => {
    server.use(
      http.post(`${API}/tasks/t1/complete`, () =>
        HttpResponse.json({ message: 'Already claimed' }, { status: 409 })
      )
    );
    const { result } = renderHook(() => useCompleteTaskMutation('hh-1'), { wrapper });

    act(() => result.current.mutate({ taskId: 't1', expectedNextDue: task.nextDue }));

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(playHaptic).not.toHaveBeenCalled();
  });

  it('plays the snoozed cue once the server accepts a skip', async () => {
    server.use(http.post(`${API}/tasks/t1/snooze`, () => HttpResponse.json(task)));
    const { result } = renderHook(() => useSkipCycleMutation('hh-1'), { wrapper });

    act(() => result.current.mutate({ task, reason: 'rain' as never }));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(playHaptic).toHaveBeenCalledExactlyOnceWith('snoozed');
  });
});
