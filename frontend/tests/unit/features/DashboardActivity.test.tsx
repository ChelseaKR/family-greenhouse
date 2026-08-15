import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { http, HttpResponse } from 'msw';
import i18n from '@/i18n';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { filterActivity } from '@/features/dashboard/activityFeed';
import type {
  ActivityEvent,
  ActivityEventByType,
  ActivityPayloadByType,
  ActivityType,
} from '@/services/householdService';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

function event<T extends ActivityType>(
  type: T,
  payload: ActivityPayloadByType[T],
  id = type
): ActivityEventByType<T> {
  return {
    id: `event-${id}`,
    type,
    householdId: 'hh-1',
    actorId: 'user-1',
    actorName: 'Chelsea',
    occurredAt: '2026-08-06T12:00:00.000Z',
    payload,
  };
}

/** Simulates unvalidated network/history data that intentionally violates this build's contract. */
function runtimeEvent(type: string, payload: Record<string, unknown>): ActivityEvent {
  return {
    id: `event-${type}`,
    type,
    householdId: 'hh-1',
    actorId: 'user-1',
    actorName: 'Chelsea',
    occurredAt: '2026-08-06T12:00:00.000Z',
    payload,
  } as unknown as ActivityEvent;
}

function renderDashboardActivity(activity: ActivityEvent[]) {
  server.use(
    http.get(`${API}/tasks/upcoming`, () => HttpResponse.json([])),
    http.get(`${API}/tasks`, () => HttpResponse.json([])),
    http.get(`${API}/plants`, () => HttpResponse.json([])),
    http.get(`${API}/spaces`, () => HttpResponse.json([])),
    http.get(`${API}/households/hh-1`, () =>
      HttpResponse.json({
        id: 'hh-1',
        name: 'Home',
        createdAt: '',
        createdBy: 'user-1',
        members: [{ userId: 'user-1', name: 'Chelsea', role: 'admin', joinedAt: '' }],
      })
    ),
    http.get(`${API}/households/hh-1/activity`, () => HttpResponse.json(activity)),
    http.get(`${API}/households/hh-1/climate`, () => HttpResponse.json({ status: 'no_location' })),
    http.get(`${API}/households/hh-1/year-in-review`, () =>
      HttpResponse.json({
        year: 2026,
        totalCompletions: 0,
        byMember: [],
        byTaskType: [],
        topPlants: [],
      })
    )
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/dashboard']}>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  useAuthStore.setState({
    user: {
      id: 'user-1',
      email: 'chelsea@example.com',
      name: 'Chelsea',
      householdId: 'hh-1',
      householdRole: 'admin',
    },
    isAuthenticated: true,
    isLoading: false,
  } as never);
});

describe('dashboard activity rows', () => {
  it('renders all four production event types with their event details', async () => {
    renderDashboardActivity([
      event('plants.imported', { count: 12 }),
      event('plant.propagated', {
        plantId: 'plant-baby',
        plantName: 'Baby Monstera',
        parentPlantId: 'plant-mother',
        parentPlantName: 'Mother Monstera',
      }),
      event('plant.shared_accepted', {
        plantId: 'plant-pothos',
        plantName: 'Pothos',
        fromHouseholdName: 'Kelly household',
      }),
      event('plant.health_checked', {
        plantId: 'plant-fernie',
        plantName: 'Fernie',
        overall: 'monitor',
        demo: false,
      }),
    ]);

    expect(await screen.findByText('Chelsea imported 12 plants')).toBeInTheDocument();
    expect(
      screen.getByText('Chelsea propagated Baby Monstera from Mother Monstera')
    ).toBeInTheDocument();
    expect(screen.getByText('Chelsea accepted Pothos from Kelly household')).toBeInTheDocument();
    expect(
      screen.getByText('Chelsea ran a leaf-health check on Fernie — Worth monitoring')
    ).toBeInTheDocument();
  });

  it('labels a demo leaf-health result as canned instead of a real check', async () => {
    renderDashboardActivity([
      event('plant.health_checked', {
        plantId: 'plant-fernie',
        plantName: 'Fernie',
        overall: 'monitor',
        demo: true,
      }),
    ]);

    expect(
      await screen.findByText(
        'Chelsea viewed a demo leaf-health result for Fernie — no image analysis was performed'
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/ran a leaf-health check/i)).not.toBeInTheDocument();
  });

  it('uses neutral copy when a legacy payload lacks a count or known health verdict', async () => {
    renderDashboardActivity([
      runtimeEvent('plants.imported', {}),
      runtimeEvent('plant.health_checked', {
        plantName: 'Fernie',
        overall: 'unexpected',
        // A real check — only its verdict is unrenderable here.
        demo: false,
      }),
    ]);

    expect(await screen.findByText('Chelsea imported plants')).toBeInTheDocument();
    expect(screen.getByText('Chelsea ran a leaf-health check on Fernie')).toBeInTheDocument();
    expect(screen.queryByText(/imported 0 plants/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/worth monitoring/i)).not.toBeInTheDocument();
  });

  it('does not present a legacy health verdict as confirmed when demo provenance is missing', async () => {
    renderDashboardActivity([
      runtimeEvent('plant.health_checked', { plantName: 'Fernie', overall: 'healthy' }),
    ]);

    expect(
      await screen.findByText(
        "Chelsea requested a leaf-health check for Fernie — this record doesn't say whether a real analysis ran or a demo result was shown"
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/looking healthy/i)).not.toBeInTheDocument();
  });

  it('will not claim a check ran for a row written before demo labelling', async () => {
    // Rows recorded before the `demo` flag existed are indistinguishable from
    // demo results, and a demo result means no image was analysed. The row
    // must not assert the analysis it cannot evidence (#306).
    renderDashboardActivity([
      runtimeEvent('plant.health_checked', { plantName: 'Fernie', overall: 'monitor' }),
    ]);

    const row = (await screen.findByText(/requested a leaf-health check for Fernie/)).closest('li');
    expect(row).not.toBeNull();
    expect(screen.queryByText(/ran a leaf-health check/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/worth monitoring/i)).not.toBeInTheDocument();
    // Not the success tick, which is what made an unexplained row read as
    // "someone did something and it worked".
    expect(row?.querySelector('svg')).not.toHaveClass('text-primary-700');
  });

  it('uses status-specific visual tones while keeping the verdict in text', async () => {
    renderDashboardActivity([
      event(
        'plant.health_checked',
        {
          plantId: 'plant-healthy',
          plantName: 'Fernie',
          overall: 'healthy',
          demo: false,
        },
        'healthy'
      ),
      event(
        'plant.health_checked',
        {
          plantId: 'plant-monitor',
          plantName: 'Ivy',
          overall: 'monitor',
          demo: false,
        },
        'monitor'
      ),
      event(
        'plant.health_checked',
        {
          plantId: 'plant-concern',
          plantName: 'Rose',
          overall: 'concern',
          demo: false,
        },
        'concern'
      ),
    ]);

    const healthyRow = (
      await screen.findByText('Chelsea ran a leaf-health check on Fernie — Looking healthy')
    ).closest('li');
    const monitorRow = screen
      .getByText('Chelsea ran a leaf-health check on Ivy — Worth monitoring')
      .closest('li');
    const concernRow = screen
      .getByText('Chelsea ran a leaf-health check on Rose — Needs attention')
      .closest('li');

    expect(healthyRow?.querySelector('svg')).toHaveClass('text-primary-700');
    expect(healthyRow?.firstElementChild).toHaveClass('bg-primary-100');
    expect(monitorRow?.querySelector('svg')).toHaveClass('text-amber-700');
    expect(monitorRow?.firstElementChild).toHaveClass('bg-amber-50');
    expect(concernRow?.querySelector('svg')).toHaveClass('text-red-700');
    expect(concernRow?.firstElementChild).toHaveClass('bg-red-50');
  });

  it('keeps rendering when a newer backend sends an activity type this build does not know', async () => {
    renderDashboardActivity([runtimeEvent('plant.future_event', {})]);

    expect(await screen.findByText('Chelsea made an update')).toBeInTheDocument();
  });
});

describe('dashboard activity filters', () => {
  it('includes every plant event, including the plural plants.imported type', () => {
    const plantEvents: ActivityEvent[] = [
      event('plant.created', { plantId: 'p1', plantName: 'Plant 1' }),
      event('plants.imported', { count: 2 }),
      event('plant.deleted', { plantId: 'p2', plantName: 'Plant 2' }),
      event('plant.died', { plantId: 'p3', plantName: 'Plant 3' }),
      event('plant.gave_away', { plantId: 'p4', plantName: 'Plant 4' }),
      event('plant.archived', { plantId: 'p5', plantName: 'Plant 5' }),
      event('plant.restored', { plantId: 'p6', plantName: 'Plant 6' }),
      event('plant.propagated', {
        plantId: 'p7',
        plantName: 'Plant 7',
        parentPlantId: 'p6',
        parentPlantName: 'Plant 6',
      }),
      event('plant.shared_accepted', {
        plantId: 'p8',
        plantName: 'Plant 8',
        fromHouseholdName: 'Neighbors',
      }),
      event('plant.health_checked', {
        plantId: 'p9',
        plantName: 'Plant 9',
        overall: 'healthy',
        demo: false,
      }),
      event('photo.uploaded', { plantId: 'p10', photoId: 'photo-1' }),
    ];
    const plantTypes = plantEvents.map(({ type }) => type);
    const events = [
      ...plantEvents,
      event('task.completed', {
        taskId: 'task-1',
        plantId: 'p1',
        taskType: 'water',
      }),
      event('member.joined', { role: 'member' }),
    ];

    expect(filterActivity(events, 'plants').map(({ type }) => type)).toEqual(plantTypes);
  });
});
