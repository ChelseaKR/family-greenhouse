import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AddTaskModal } from '@/features/plants/AddTaskModal';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

/** Adding a task plays the success haptic once the server has it; a refused
 *  add plays none. (Adding a plant does the same, from its own onSuccess.) */
const playHaptic = vi.hoisted(() => vi.fn());
vi.mock('@/services/nativeHaptics', () => ({ playHaptic }));

const API = 'http://localhost:4000';

function renderModal() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AddTaskModal plantId="p1" isOpen onClose={() => {}} />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  playHaptic.mockClear();
  useAuthStore.setState({
    accessToken: 'a',
    user: { id: 'u1', email: 'u@example.com', name: 'Me', householdId: 'hh-1' } as never,
  });
});

describe('the add haptic', () => {
  it('plays the success pattern once the task is added', async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${API}/tasks`, () =>
        HttpResponse.json({ id: 't9', plantId: 'p1', type: 'water', frequency: 7 })
      )
    );
    renderModal();
    await user.click(await screen.findByRole('button', { name: /add task/i }));
    await waitFor(() => expect(playHaptic).toHaveBeenCalledWith('added'));
    expect(playHaptic).toHaveBeenCalledTimes(1);
  });

  it('plays nothing when the server refuses the task', async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${API}/tasks`, () => HttpResponse.json({ message: 'no' }, { status: 400 }))
    );
    renderModal();
    await user.click(await screen.findByRole('button', { name: /add task/i }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(playHaptic).not.toHaveBeenCalled();
  });
});
