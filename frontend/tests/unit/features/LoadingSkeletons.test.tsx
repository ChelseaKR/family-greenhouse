import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HouseholdPage } from '@/features/household/HouseholdPage';
import { PlantDetailPage } from '@/features/plants/PlantDetailPage';
import { TasksPage } from '@/features/tasks/TasksPage';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

/**
 * While a tab root or the plant page loads, it shows the shape of what is
 * coming (a skeleton the content replaces in place), never a centered
 * spinner over an empty page.
 */
const API = 'http://localhost:4000';

function renderAt(path: string, route: string, element: React.ReactNode) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={route} element={element} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const spinner = () => document.querySelector('svg.animate-spin');

beforeEach(() => {
  useAuthStore.setState({
    accessToken: 'a',
    user: { id: 'u1', email: 'u@example.com', name: 'Me', householdId: 'hh-1' } as never,
  });
  // Every read the pages make stays in flight for the length of the test.
  server.use(
    http.get(`${API}/*`, async () => {
      await delay('infinite');
      return HttpResponse.json({});
    })
  );
});

describe('loading skeletons', () => {
  it('the Household tab', async () => {
    renderAt('/household', '/household', <HouseholdPage />);
    expect(await screen.findByRole('status', { name: 'Loading…' })).toBeInTheDocument();
    expect(spinner()).toBeNull();
  });

  it('the plant page', async () => {
    renderAt('/plants/p1', '/plants/:plantId', <PlantDetailPage />);
    expect(await screen.findByRole('status', { name: 'Loading…' })).toBeInTheDocument();
    expect(spinner()).toBeNull();
  });

  it('the Tasks tab on the desktop website', async () => {
    renderAt('/tasks', '/tasks', <TasksPage />);
    expect(await screen.findByRole('status', { name: 'Loading…' })).toBeInTheDocument();
    expect(spinner()).toBeNull();
  });
});
