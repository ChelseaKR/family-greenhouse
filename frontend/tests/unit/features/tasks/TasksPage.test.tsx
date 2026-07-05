import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WaterDropIcon } from '@/components/icons/WaterDropIcon';
import { FertilizeIcon } from '@/components/icons/FertilizeIcon';
import { PruneIcon } from '@/components/icons/PruneIcon';
import { RepotIcon } from '@/components/icons/RepotIcon';
import { CustomTaskIcon } from '@/components/icons/CustomTaskIcon';
import { TasksPage } from '@/features/tasks/TasksPage';
import { useAuthStore, User } from '@/store/authStore';
import { server } from '../../../msw/server';

const API = 'http://localhost:4000';

/**
 * The `taskTypeStyles` chip-mapping that TasksPage uses is a module-local
 * constant — not exported. Rather than render the full page (which would
 * pull in the auth store, react-query, the router, etc.) we exercise the
 * five icon components directly. They are the only collaborators that
 * `taskTypeStyles` introduces; the chip / iconColor strings are inert and
 * are visually verified upstream via the Playwright suite.
 */

const iconCases = [
  ['WaterDropIcon', WaterDropIcon],
  ['FertilizeIcon', FertilizeIcon],
  ['PruneIcon', PruneIcon],
  ['RepotIcon', RepotIcon],
  ['CustomTaskIcon', CustomTaskIcon],
] as const;

describe('TasksPage task-type icons', () => {
  it.each(iconCases)('%s renders as an inline <svg>', (_name, Icon) => {
    const { container } = render(<Icon />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    // All five icons are 32x32 viewBox botanicals.
    expect(svg?.getAttribute('viewBox')).toBe('0 0 32 32');
  });

  it.each(iconCases)('%s forwards className onto the rendered svg', (_name, Icon) => {
    const { container } = render(<Icon className="h-6 w-6 text-sky-700" />);
    const svg = container.querySelector('svg') as SVGElement;
    expect(svg).not.toBeNull();
    // Use the SVG-specific className.baseVal for SVGAnimatedString.
    const cls =
      (svg.className as unknown as SVGAnimatedString).baseVal ?? svg.getAttribute('class');
    expect(cls).toContain('h-6');
    expect(cls).toContain('w-6');
    expect(cls).toContain('text-sky-700');
  });

  it.each(iconCases)(
    '%s marks itself as aria-hidden so screen readers skip the decoration',
    (_name, Icon) => {
      const { container } = render(<Icon />);
      const svg = container.querySelector('svg');
      expect(svg).toHaveAttribute('aria-hidden', 'true');
    }
  );

  it('each icon uses currentColor for stroke so callers can recolor via text-*', () => {
    for (const [, Icon] of iconCases) {
      const { container, unmount } = render(<Icon />);
      const svg = container.querySelector('svg');
      expect(svg?.getAttribute('stroke')).toBe('currentColor');
      unmount();
    }
  });
});

function renderTasksPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/tasks']}>
        <TasksPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("TasksPage 'My tasks' filter", () => {
  it('includes a task covered via vacation hand-off (effectiveAssignee), not just assignedTo', async () => {
    useAuthStore.setState({
      accessToken: 'access-1',
      user: { id: 'u1', email: 'me@example.com', name: 'Me', householdId: 'hh-1' } as User,
    });
    server.use(
      http.get(`${API}/tasks`, () =>
        HttpResponse.json([
          {
            id: 't-covered',
            plantId: 'p1',
            plantName: 'Pothos',
            type: 'water',
            customType: null,
            frequency: 7,
            lastCompleted: null,
            nextDue: '2099-01-01T00:00:00.000Z',
            assignedTo: 'user-away',
            assignedToName: 'Away Person',
            notes: null,
            createdBy: 'u1',
            createdAt: '',
            effectiveAssignee: 'u1',
            effectiveAssigneeName: 'Me',
            coveringFor: 'Away Person',
          },
          {
            id: 't-not-mine',
            plantId: 'p2',
            plantName: 'Fern',
            type: 'water',
            customType: null,
            frequency: 7,
            lastCompleted: null,
            nextDue: '2099-01-01T00:00:00.000Z',
            assignedTo: 'user-other',
            assignedToName: 'Someone Else',
            notes: null,
            createdBy: 'u1',
            createdAt: '',
          },
        ])
      ),
      http.get(`${API}/households/hh-1/climate`, () =>
        HttpResponse.json({ configured: false, weather: null, tips: [] })
      ),
      http.get(`${API}/plants`, () => HttpResponse.json([]))
    );
    renderTasksPage();

    fireEvent.click(await screen.findByRole('button', { name: 'My tasks' }));

    expect(await screen.findByText('Pothos')).toBeInTheDocument();
    expect(screen.queryByText('Fern')).not.toBeInTheDocument();
  });
});
