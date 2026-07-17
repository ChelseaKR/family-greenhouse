import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { SharedCarePulse } from '@/features/dashboard/SharedCarePulse';
import { deriveSharedCareMilestones } from '@/features/dashboard/sharedCarePulseModel';
import type { ActivityEvent } from '@/services/householdService';
import { useAuthStore } from '@/store/authStore';
import { usePrefsStore } from '@/store/prefsStore';
import { server } from '../../msw/server';
import * as analytics from '@/services/analytics';

const API = 'http://localhost:4000';
const NOW = Date.parse('2026-07-16T12:00:00.000Z');

function completion(actorId: string, occurredAt: string): ActivityEvent {
  return {
    id: `event-${actorId}`,
    type: 'task.completed',
    householdId: 'hh-1',
    actorId,
    actorName: actorId,
    occurredAt,
    payload: {},
  };
}

function renderPulse() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SharedCarePulse />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function usePulseHandlers({
  members = [{ userId: 'u1', name: 'Chelsea', role: 'admin', joinedAt: '' }],
  activity = [],
}: {
  members?: Array<{ userId: string; name: string; role: 'admin' | 'member'; joinedAt: string }>;
  activity?: ActivityEvent[];
} = {}) {
  server.use(
    http.get(`${API}/plants`, () =>
      HttpResponse.json([
        {
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
        },
      ])
    ),
    http.get(`${API}/tasks`, () =>
      HttpResponse.json([
        {
          id: 't1',
          plantId: 'p1',
          plantName: 'Monstera',
          type: 'water',
          frequency: 7,
          nextDue: '2026-07-17T12:00:00.000Z',
        },
      ])
    ),
    http.get(`${API}/households/hh-1`, () =>
      HttpResponse.json({
        id: 'hh-1',
        name: 'Home',
        createdAt: '',
        createdBy: 'u1',
        members,
      })
    ),
    http.get(`${API}/households/hh-1/activity`, () => HttpResponse.json(activity))
  );
}

beforeEach(() => {
  useAuthStore.setState({
    user: {
      id: 'u1',
      email: 'chelsea@example.com',
      name: 'Chelsea',
      householdId: 'hh-1',
      householdRole: 'admin',
    },
    isAuthenticated: true,
    isLoading: false,
  } as never);
  usePrefsStore.setState({ sharedCarePulseDismissedUntil: {} });
});

describe('deriveSharedCareMilestones', () => {
  it('requires recent care from a different household member for the handoff milestone', () => {
    const milestones = deriveSharedCareMilestones({
      plantCount: 1,
      taskCount: 1,
      memberUserIds: ['u1', 'u2'],
      currentUserId: 'u1',
      now: NOW,
      activity: [
        completion('u1', '2026-07-16T10:00:00.000Z'),
        completion('u2', '2026-07-01T10:00:00.000Z'),
      ],
    });

    expect(milestones.map(({ key, completed }) => [key, completed])).toEqual([
      ['plant', true],
      ['task', true],
      ['teammate', true],
      ['sharedCare', false],
    ]);
  });

  it('completes the full loop when a teammate logged care within 14 days', () => {
    const milestones = deriveSharedCareMilestones({
      plantCount: 1,
      taskCount: 1,
      memberUserIds: ['u1', 'u2'],
      currentUserId: 'u1',
      now: NOW,
      activity: [completion('u2', '2026-07-10T10:00:00.000Z')],
    });

    expect(milestones.every((milestone) => milestone.completed)).toBe(true);
  });

  it('does not mistake an external plant sitter for a joined household teammate', () => {
    const milestones = deriveSharedCareMilestones({
      plantCount: 1,
      taskCount: 1,
      memberUserIds: ['u1', 'u2'],
      currentUserId: 'u1',
      now: NOW,
      activity: [completion('sitter:share-1', '2026-07-16T10:00:00.000Z')],
    });

    expect(milestones.find((milestone) => milestone.key === 'sharedCare')?.completed).toBe(false);
  });
});

describe('SharedCarePulse', () => {
  it('shows the first incomplete collaboration step and its direct action', async () => {
    usePulseHandlers();
    renderPulse();

    expect(
      await screen.findByRole('heading', { name: 'Make care something the household shares' })
    ).toBeInTheDocument();
    expect(screen.getByText('2 of 4 steps ready')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Invite someone' })).toHaveAttribute(
      'href',
      '/household'
    );
  });

  it('lets a solo caregiver hide the prompt for 30 days on this device', async () => {
    usePulseHandlers();
    const user = userEvent.setup();
    renderPulse();

    const dismissButton = await screen.findByRole('button', {
      name: 'Hide shared-care setup for 30 days',
    });
    await user.click(dismissButton);

    await waitFor(() => {
      expect(
        screen.queryByRole('heading', { name: 'Make care something the household shares' })
      ).not.toBeInTheDocument();
    });
    expect(
      Date.parse(usePrefsStore.getState().sharedCarePulseDismissedUntil['hh-1'])
    ).toBeGreaterThan(Date.now());
  });

  it('records the final milestone with a schema-safe context value', async () => {
    usePulseHandlers({
      members: [
        { userId: 'u1', name: 'Chelsea', role: 'admin', joinedAt: '' },
        { userId: 'u2', name: 'Sam', role: 'member', joinedAt: '' },
      ],
      activity: [],
    });
    const trackSpy = vi.spyOn(analytics, 'track');
    const user = userEvent.setup();
    renderPulse();

    await user.click(await screen.findByRole('link', { name: 'Open care tasks' }));

    expect(trackSpy).toHaveBeenCalledWith('shared_care_pulse_action', {
      context: 'shared_care',
    });
  });
});
