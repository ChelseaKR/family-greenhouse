import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { AddTaskModal } from '@/features/plants/AddTaskModal';
import { EditTaskModal } from '@/features/plants/EditTaskModal';
import { PreferencesSettings } from '@/features/settings/PreferencesSettings';
import { useAuthStore } from '@/store/authStore';
import { usePrefsStore } from '@/store/prefsStore';
import { server } from '../../msw/server';

/**
 * pr7d: "every N days" gets − and + beside the field in Add and Edit task
 * (the field still takes a typed number), and Density is a segmented control
 * that is still a radio group.
 */
const API = 'http://localhost:4000';
let sent: Array<Record<string, unknown>> = [];

function wrap(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}
const frequency = () => screen.getByLabelText(/^Frequency \(days\)/) as HTMLInputElement;

beforeEach(() => {
  sent = [];
  useAuthStore.setState({
    accessToken: 'a',
    user: { id: 'u1', email: 'u@example.com', name: 'Me', householdId: 'hh-1' } as never,
  });
  server.use(
    http.post(`${API}/tasks`, async ({ request }) => {
      sent.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ id: 't9' });
    }),
    http.put(`${API}/tasks/:id`, async ({ request }) => {
      sent.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ id: 't1' });
    })
  );
});

describe('the "every N days" stepper', () => {
  it('Add task: + and − step the days, and the stepped value is what is saved', async () => {
    const user = userEvent.setup();
    wrap(<AddTaskModal plantId="p1" isOpen onClose={() => {}} />);
    await screen.findByLabelText(/^Frequency \(days\)/);
    expect(frequency()).toHaveValue(7);
    await user.click(screen.getByRole('button', { name: 'One day more' }));
    await user.click(screen.getByRole('button', { name: 'One day more' }));
    await user.click(screen.getByRole('button', { name: 'One day less' }));
    expect(frequency()).toHaveValue(8);
    await user.click(screen.getByRole('button', { name: 'Add task' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ frequency: 8 });
  });

  it('stops at 1 and at 365, and a typed number still works', async () => {
    const user = userEvent.setup();
    wrap(<AddTaskModal plantId="p1" isOpen onClose={() => {}} />);
    await screen.findByLabelText(/^Frequency \(days\)/);
    await user.clear(frequency());
    await user.type(frequency(), '1');
    expect(screen.getByRole('button', { name: 'One day less' })).toBeDisabled();
    await user.clear(frequency());
    await user.type(frequency(), '365');
    expect(screen.getByRole('button', { name: 'One day more' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'One day less' }));
    expect(frequency()).toHaveValue(364);
    // A typed number past the end: one step brings it back into range.
    await user.clear(frequency());
    await user.type(frequency(), '500');
    await user.click(screen.getByRole('button', { name: 'One day less' }));
    expect(frequency()).toHaveValue(365);
  });

  it('Edit task: steps from the task’s own frequency', async () => {
    const user = userEvent.setup();
    wrap(
      <EditTaskModal
        task={
          {
            id: 't1',
            plantId: 'p1',
            plantName: 'Fern',
            type: 'water',
            customType: null,
            frequency: 10,
            lastCompleted: null,
            nextDue: new Date().toISOString(),
            assignedTo: null,
            assignedToName: null,
            notes: null,
            createdBy: 'u1',
            createdAt: '',
          } as never
        }
        isOpen
        onClose={() => {}}
      />
    );
    await screen.findByLabelText(/^Frequency \(days\)/);
    expect(frequency()).toHaveValue(10);
    await user.click(screen.getByRole('button', { name: 'One day more' }));
    expect(frequency()).toHaveValue(11);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ frequency: 11 });
  });
});

describe('the Density segmented control', () => {
  it('is a radio group: a tap or the arrow keys choose, and Tab stops on the chosen one', async () => {
    const user = userEvent.setup();
    usePrefsStore.setState({ density: 'cozy' });
    wrap(
      <MemoryRouter>
        <PreferencesSettings />
      </MemoryRouter>
    );
    const group = screen.getByRole('radiogroup', { name: 'Density' });
    const [cozy, compact] = Array.from(group.querySelectorAll('[role="radio"]')) as HTMLElement[];
    expect(cozy).toHaveAttribute('aria-checked', 'true');
    expect(cozy).toHaveAttribute('tabindex', '0');
    expect(compact).toHaveAttribute('tabindex', '-1');

    await user.click(compact);
    expect(usePrefsStore.getState().density).toBe('compact');
    expect(compact).toHaveAttribute('aria-checked', 'true');

    compact.focus();
    await user.keyboard('{ArrowLeft}');
    expect(usePrefsStore.getState().density).toBe('cozy');
    expect(cozy).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(usePrefsStore.getState().density).toBe('compact');
    expect(compact).toHaveFocus();
  });
});
