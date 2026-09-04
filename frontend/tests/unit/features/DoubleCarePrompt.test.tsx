/**
 * The double-care round trip on the client: a completion the server holds
 * back (409 DUPLICATE_CARE) becomes a prompt instead of an error toast; the
 * optimistic advance is rolled back; confirming re-submits with
 * `confirmDuplicate: true`; declining logs nothing and says so.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, renderHook, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { DoubleCarePrompt } from '@/features/tasks/DoubleCarePrompt';
import { useCompleteTaskMutation } from '@/features/tasks/taskMutations';
import { useDoubleCareStore } from '@/store/doubleCareStore';
import { useToastStore } from '@/store/toastStore';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

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

const duplicateBody = {
  message: 'Sam already logged water for Fern. Send confirmDuplicate: true to log it anyway.',
  details: {
    code: 'DUPLICATE_CARE',
    plantName: 'Fern',
    duplicate: {
      completionId: 'c-sam',
      completedAt: new Date(Date.now() - 4 * 3_600_000).toISOString(),
      completedBy: 'user-sam',
      completedByName: 'Sam',
      taskId: 't1',
      taskType: 'water',
      sameTask: true,
      windowHours: 24,
    },
  },
};

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

beforeEach(() => {
  useDoubleCareStore.setState({ pending: null });
  useToastStore.setState({ toasts: [] });
  useAuthStore.setState({
    user: { id: 'u1', email: 'u@example.com', name: 'Me', householdId: 'hh-1' } as never,
    isAuthenticated: true,
  });
});

describe('useCompleteTaskMutation on 409 DUPLICATE_CARE', () => {
  it('rolls back, prompts, and does not toast an error', async () => {
    server.use(
      http.post(`${API}/tasks/t1/complete`, () => HttpResponse.json(duplicateBody, { status: 409 }))
    );
    const client = makeClient();
    client.setQueryData(['tasks', 'hh-1', 'all'], [task]);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useCompleteTaskMutation('hh-1'), { wrapper });

    act(() => result.current.mutate({ taskId: 't1', expectedNextDue: task.nextDue }));

    await waitFor(() => expect(useDoubleCareStore.getState().pending).not.toBeNull());
    expect(useDoubleCareStore.getState().pending).toMatchObject({
      taskId: 't1',
      expectedNextDue: task.nextDue,
      details: { plantName: 'Fern', duplicate: { completedByName: 'Sam' } },
    });
    // The optimistic advance was rolled back: the cached task is untouched.
    expect(client.getQueryData(['tasks', 'hh-1', 'all'])).toEqual([task]);
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('still toasts an ordinary 409 (a lost claim race is not double-care)', async () => {
    server.use(
      http.post(`${API}/tasks/t1/complete`, () =>
        HttpResponse.json({ message: 'Already claimed' }, { status: 409 })
      )
    );
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={makeClient()}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useCompleteTaskMutation('hh-1'), { wrapper });

    act(() => result.current.mutate({ taskId: 't1', expectedNextDue: task.nextDue }));

    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    expect(useToastStore.getState().toasts[0]).toMatchObject({
      variant: 'error',
      message: 'Already claimed',
    });
    expect(useDoubleCareStore.getState().pending).toBeNull();
  });
});

describe('DoubleCarePrompt', () => {
  function renderPrompt() {
    return render(
      <QueryClientProvider client={makeClient()}>
        <DoubleCarePrompt />
      </QueryClientProvider>
    );
  }

  it('renders nothing until a completion is held back', () => {
    renderPrompt();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('says who did it and when, and confirming re-submits with confirmDuplicate', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(`${API}/tasks/t1/complete`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ ...task, lastCompleted: new Date().toISOString() });
      })
    );
    renderPrompt();
    act(() =>
      useDoubleCareStore.getState().prompt({
        taskId: 't1',
        expectedNextDue: task.nextDue,
        details: duplicateBody.details as never,
      })
    );

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Already done');
    expect(dialog).toHaveTextContent('Sam logged Water for Fern 4 hours ago. Log it anyway?');

    await userEvent.click(screen.getByRole('button', { name: 'Log it anyway' }));

    await waitFor(() => expect(useDoubleCareStore.getState().pending).toBeNull());
    expect(bodies).toEqual([{ expectedNextDue: task.nextDue, confirmDuplicate: true }]);
    await waitFor(() =>
      expect(useToastStore.getState().toasts).toContainEqual(
        expect.objectContaining({ variant: 'success', message: 'Logged anyway' })
      )
    );
  });

  it('declining logs nothing and says so', async () => {
    renderPrompt();
    act(() =>
      useDoubleCareStore.getState().prompt({
        taskId: 't1',
        expectedNextDue: task.nextDue,
        details: duplicateBody.details as never,
      })
    );
    await screen.findByRole('dialog');

    await userEvent.click(screen.getByRole('button', { name: 'Don’t log it' }));

    await waitFor(() => expect(useDoubleCareStore.getState().pending).toBeNull());
    expect(useToastStore.getState().toasts).toContainEqual(
      expect.objectContaining({ variant: 'info', message: 'Not logged' })
    );
  });
});
