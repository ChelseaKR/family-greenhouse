import { beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { EditPlantModal } from '@/features/plants/EditPlantModal';
import { EditTaskModal } from '@/features/plants/EditTaskModal';
import type { Plant, Task } from '@/services/plantService';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

/**
 * The API reads an omitted key as "leave it alone" and null as "clear it". These
 * forms sent an emptied field as undefined, which JSON drops, so the save
 * succeeded, the form closed, and the old text came back on the next read.
 */
const API = 'http://localhost:4000';

const plant: Plant = {
  id: 'p1',
  householdId: 'hh-1',
  name: 'Monstera',
  species: 'Monstera deliciosa',
  location: null,
  imageUrl: null,
  notes: 'Gate code is 4412',
  perenualSpeciesId: null,
  createdAt: '',
  createdBy: 'u1',
  updatedAt: '',
};

const task = {
  id: 't1',
  householdId: 'hh-1',
  plantId: 'p1',
  plantName: 'Monstera',
  type: 'custom',
  customType: 'Mist',
  frequency: 7,
  seasonalCadences: null,
  lastCompleted: null,
  nextDue: '2026-12-01T12:00:00.000Z',
  assignedTo: null,
  assignedToName: null,
  notes: 'Use rainwater',
  createdAt: '',
  createdBy: 'u1',
} as unknown as Task;

function renderInClient(ui: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

/** The JSON body the form actually sent, parsed, so a dropped key stays dropped. */
function captureBody(path: string) {
  const sent: { body?: Record<string, unknown> } = {};
  server.use(
    http.put(`${API}${path}`, async ({ request }) => {
      sent.body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({});
    })
  );
  return sent;
}

beforeEach(() => {
  useAuthStore.setState({ accessToken: 'access-1' });
  server.use(
    http.get(`${API}/species/search`, () => HttpResponse.json({ source: 'perenual', results: [] }))
  );
});

describe('Edit Plant', () => {
  it('clears the notes when they are emptied', async () => {
    const sent = captureBody('/plants/p1');
    const user = userEvent.setup();
    renderInClient(<EditPlantModal plant={plant} isOpen onClose={() => {}} />);

    await user.clear(screen.getByLabelText(/^notes/i));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(sent.body).toBeDefined());
    expect(sent.body).toHaveProperty('notes', null);
  });

  it('clears the species when it is emptied', async () => {
    const sent = captureBody('/plants/p1');
    const user = userEvent.setup();
    renderInClient(<EditPlantModal plant={plant} isOpen onClose={() => {}} />);

    await user.clear(screen.getByLabelText(/species/i));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(sent.body).toHaveProperty('species', null));
  });

  it('sends the notes and species it was given, unchanged', async () => {
    const sent = captureBody('/plants/p1');
    const user = userEvent.setup();
    renderInClient(<EditPlantModal plant={plant} isOpen onClose={() => {}} />);

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(sent.body).toBeDefined());
    expect(sent.body).toMatchObject({
      notes: 'Gate code is 4412',
      species: 'Monstera deliciosa',
    });
  });
});

describe('Edit Task', () => {
  it('clears the notes when they are emptied', async () => {
    const sent = captureBody('/tasks/t1');
    const user = userEvent.setup();
    renderInClient(<EditTaskModal task={task} isOpen onClose={() => {}} />);

    await user.clear(screen.getByLabelText(/^notes/i));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(sent.body).toBeDefined());
    expect(sent.body).toHaveProperty('notes', null);
  });

  it('clears the custom name when the task stops being custom', async () => {
    const sent = captureBody('/tasks/t1');
    const user = userEvent.setup();
    renderInClient(<EditTaskModal task={task} isOpen onClose={() => {}} />);

    await user.selectOptions(screen.getByRole('combobox', { name: /type/i }), 'water');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(sent.body).toBeDefined());
    expect(sent.body).toMatchObject({ type: 'water', customType: null });
  });

  it('keeps the custom name and notes on an unchanged save', async () => {
    const sent = captureBody('/tasks/t1');
    const user = userEvent.setup();
    renderInClient(<EditTaskModal task={task} isOpen onClose={() => {}} />);

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(sent.body).toBeDefined());
    expect(sent.body).toMatchObject({ customType: 'Mist', notes: 'Use rainwater' });
  });
});
