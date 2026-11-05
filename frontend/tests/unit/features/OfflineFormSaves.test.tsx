import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AddTaskModal } from '@/features/plants/AddTaskModal';
import { EditPlantModal } from '@/features/plants/EditPlantModal';
import { EditTaskModal } from '@/features/plants/EditTaskModal';
import type { Plant, Task } from '@/services/plantService';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

/**
 * The Edit Plant, Add Task and Edit Task forms fail fast. Offline they used to
 * pause (TanStack's default network mode): a spinner with no end, and a save
 * that might still land later. Now an offline save sends nothing, says so,
 * keeps what was typed, and stays unsent after reconnecting. A save the
 * server can't answer says "Can't reach" instead of hanging.
 */
const API = 'http://localhost:4000';
const OFFLINE = "You're offline. Nothing was saved. Try again once you're connected.";
let writes: string[] = [];

const plant: Plant = {
  id: 'p1',
  householdId: 'hh-1',
  name: 'Monstera',
  species: null,
  location: null,
  imageUrl: null,
  notes: null,
  createdAt: '',
  createdBy: 'u1',
  updatedAt: '',
};

const task: Task = {
  id: 't1',
  plantId: 'p1',
  plantName: 'Monstera',
  type: 'water',
  frequency: 7,
  lastCompleted: null,
  nextDue: '2026-11-10T00:00:00.000Z',
  assignedTo: null,
  assignedToName: null,
  notes: null,
  createdBy: 'u1',
  createdAt: '',
};

function renderInClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

async function goOfflineAndSubmit(button: RegExp) {
  const user = userEvent.setup();
  act(() => onlineManager.setOnline(false));
  await user.click(await screen.findByRole('button', { name: button }));
  return user;
}

/** Reconnect, give any queued save time to fire, and check none did. */
async function reconnectAndExpectNothingSent() {
  act(() => onlineManager.setOnline(true));
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(writes).toEqual([]);
}

beforeEach(() => {
  writes = [];
  useAuthStore.setState({
    accessToken: 'a',
    user: { id: 'u1', email: 'u@example.com', name: 'Me', householdId: 'hh-1' } as never,
  });
  server.events.on('request:start', ({ request }) => {
    const path = new URL(request.url).pathname;
    if (request.method !== 'GET' && !path.startsWith('/telemetry')) {
      writes.push(`${request.method} ${path}`);
    }
  });
  server.use(
    http.get(`${API}/species/search`, () => HttpResponse.json({ source: 'perenual', results: [] })),
    http.get(`${API}/spaces`, () => HttpResponse.json([])),
    http.put(`${API}/plants/p1`, () => HttpResponse.json(plant)),
    http.post(`${API}/tasks`, () => HttpResponse.json(task)),
    http.put(`${API}/tasks/t1`, () => HttpResponse.json(task))
  );
});

afterEach(() => {
  onlineManager.setOnline(true);
  server.events.removeAllListeners();
});

describe('saving a form while offline', () => {
  it('Edit Plant says nothing was saved and keeps the edit', async () => {
    const user = userEvent.setup();
    renderInClient(<EditPlantModal plant={plant} isOpen onClose={() => {}} />);
    const name = await screen.findByDisplayValue('Monstera');
    await user.clear(name);
    await user.type(name, 'Big Monstera');
    await goOfflineAndSubmit(/save changes/i);

    expect(await screen.findByText(OFFLINE)).toBeInTheDocument();
    expect(screen.getByDisplayValue('Big Monstera')).toBe(name);
    expect(screen.getByRole('button', { name: /save changes/i })).toBeEnabled();
    await reconnectAndExpectNothingSent();
  });

  it('Add Task says nothing was saved, and a retry online saves it', async () => {
    renderInClient(<AddTaskModal plantId="p1" isOpen onClose={() => {}} />);
    const user = await goOfflineAndSubmit(/add task/i);

    expect(await screen.findByText(OFFLINE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add task/i })).toBeEnabled();
    await reconnectAndExpectNothingSent();

    await user.click(screen.getByRole('button', { name: /add task/i }));
    await waitFor(() => expect(writes).toEqual(['POST /tasks']));
  });

  it('Edit Task says nothing was saved', async () => {
    renderInClient(<EditTaskModal task={task} isOpen onClose={() => {}} />);
    await goOfflineAndSubmit(/save changes/i);

    expect(await screen.findByText(OFFLINE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save changes/i })).toBeEnabled();
    await reconnectAndExpectNothingSent();
  });
});

describe('saving a form when the server cannot be reached', () => {
  it('Add Task stops and says it could not reach Family Greenhouse', async () => {
    server.use(http.post(`${API}/tasks`, () => HttpResponse.error()));
    const user = userEvent.setup();
    renderInClient(<AddTaskModal plantId="p1" isOpen onClose={() => {}} />);
    await user.click(await screen.findByRole('button', { name: /add task/i }));

    expect(
      await screen.findByText("Can't reach Family Greenhouse. Check your connection and try again.")
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add task/i })).toBeEnabled();
  });
});
