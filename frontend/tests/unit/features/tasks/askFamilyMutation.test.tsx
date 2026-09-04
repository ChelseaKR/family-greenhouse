/**
 * `useAskFamilyMutation` (ADR 0024) reports the REACH, not the request.
 *
 * The server answers with who was actually told (`recipients`), who was
 * deliberately skipped, and how many of those recipients had a channel really
 * deliver (`delivered`). A one-person household, or one where everyone is
 * away or inside their quiet hours, is a real outcome — and showing "Asked
 * your family" over it would be the repo's named dominant defect: an absence
 * rendered as a value. These pin the three distinct answers.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useAskFamilyMutation } from '@/features/tasks/taskMutations';
import { taskService, type AskFamilyResult } from '@/services/taskService';
import { useToastStore } from '@/store/toastStore';
import type { Task } from '@/services/plantService';

vi.mock('@/services/taskService', async () => {
  const actual =
    await vi.importActual<typeof import('@/services/taskService')>('@/services/taskService');
  return { ...actual, taskService: { ...actual.taskService, askFamily: vi.fn() } };
});

const task: Task = {
  id: 't-1',
  plantId: 'p-1',
  plantName: 'Monstera',
  type: 'water',
  frequency: 7,
  lastCompleted: null,
  nextDue: '2026-09-06T08:00:00.000Z',
  assignedTo: 'me',
  assignedToName: 'Sam',
  notes: null,
  createdBy: 'me',
  createdAt: '',
};

function result(over: Partial<AskFamilyResult> = {}): AskFamilyResult {
  return {
    task: task as AskFamilyResult['task'],
    note: null,
    askedAt: '2026-09-04T12:00:00.000Z',
    nextAllowedAt: '2026-09-05T12:00:00.000Z',
    recipients: [{ userId: 'u2', name: 'Priya' }],
    skipped: [],
    delivered: 1,
    ...over,
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

async function ask(over: Partial<AskFamilyResult>, note?: string) {
  vi.mocked(taskService.askFamily).mockResolvedValueOnce(result(over));
  const { result: hook } = renderHook(() => useAskFamilyMutation('hh-1'), { wrapper });
  hook.current.mutate({ task, note });
  await waitFor(() => expect(hook.current.isSuccess).toBe(true));
  return useToastStore.getState().toasts.at(-1)!;
}

beforeEach(() => {
  vi.clearAllMocks();
  useToastStore.setState({ toasts: [] });
});
afterEach(() => {
  useToastStore.setState({ toasts: [] });
});

describe('useAskFamilyMutation', () => {
  it('pins the occurrence it is asking about and drops a blank note', async () => {
    await ask({}, '   ');
    expect(taskService.askFamily).toHaveBeenCalledWith('t-1', undefined, task.nextDue);
  });

  it('celebrates only what actually went out', async () => {
    const toast = await ask({ recipients: [{ userId: 'u2', name: 'Priya' }], delivered: 1 });
    expect(toast.variant).toBe('success');
    expect(toast.message).toBe('Asked 1 housemate');
  });

  it('says nobody could be reached rather than claiming a delivered ask', async () => {
    const toast = await ask({
      recipients: [],
      skipped: [{ userId: 'u2', name: 'Priya', reason: 'away' }],
      delivered: 0,
    });
    expect(toast.variant).toBe('info');
    expect(toast.message).toBe('Nobody could be reached right now — it’s up for grabs anyway');
  });

  it('distinguishes "we tried and nothing sent" from "there was nobody to try"', async () => {
    const toast = await ask({
      recipients: [
        { userId: 'u2', name: 'Priya' },
        { userId: 'u3', name: 'Lee' },
      ],
      delivered: 0,
    });
    expect(toast.variant).toBe('info');
    expect(toast.message).toBe('Asked — but we couldn’t reach any of the 2 housemates just now');
  });
});
