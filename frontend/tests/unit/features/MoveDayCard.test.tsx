import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { MoveDayCard } from '@/features/dashboard/MoveDayCard';
import type { ClimateResponse } from '@/services/climateService';
import type { MoveDayList, MoveDayResult } from '@/services/moveDayService';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

function renderCard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <MoveDayCard />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function climate(overrides: Partial<ClimateResponse> = {}): ClimateResponse {
  return {
    configured: true,
    location: { city: 'Portland', lat: 45.5, lon: -122.6 },
    weather: {
      observedAt: '2026-10-14T20:00:00.000Z',
      tempC: 8,
      humidity: 61,
      condition: 'Clear',
      description: 'clear sky',
      forecast: [{ date: '2026-10-14', minC: 2, maxC: 11, humidity: 60 }],
    },
    tips: [],
    ...overrides,
  };
}

function list(overrides: Partial<MoveDayList> = {}): MoveDayList {
  return {
    season: 'winter',
    firedAt: '2026-10-14T20:00:00.000Z',
    signal: { tempC: 8, lowC: 2.4, frostLineC: 5, heatLineC: 32 },
    items: [
      {
        plantId: 'p-basil',
        plantName: 'Basil',
        fromSpaceId: 'patio',
        fromSpaceName: 'Patio',
        toSpaceId: 'kitchen',
        toSpaceName: 'Kitchen',
        assigneeId: 'u-a',
        assigneeName: 'Ada',
        taskId: 't-1',
      },
      {
        plantId: 'p-monstera',
        plantName: 'Monstera',
        fromSpaceId: null,
        fromSpaceName: null,
        toSpaceId: 'living',
        toSpaceName: 'Living room',
        assigneeId: null,
        assigneeName: null,
        taskId: 't-2',
      },
    ],
    tenderWithoutWinterHome: [],
    ...overrides,
  };
}

/** Register both reads; returns a spy that records every Move Day POST. */
function mock(climateBody: ClimateResponse, moveDay: () => HttpResponse) {
  const posted = vi.fn();
  server.use(
    http.get(`${API}/households/hh-1/climate`, () => HttpResponse.json(climateBody)),
    http.post(`${API}/households/hh-1/move-day`, () => {
      posted();
      return moveDay();
    })
  );
  return posted;
}

const ready = (body: MoveDayList) => () =>
  HttpResponse.json({ status: 'ready', list: body } satisfies MoveDayResult);

describe('MoveDayCard', () => {
  beforeEach(() => {
    useAuthStore.setState({
      accessToken: 'access-1',
      user: {
        id: 'u1',
        email: 'test@example.com',
        name: 'Test',
        householdId: 'hh-1',
        householdRole: 'admin',
      },
      activeHouseholdId: 'hh-1',
    });
  });

  it('never asks for Move Day until the climate read has produced a snapshot', async () => {
    const posted = mock(climate({ weather: null }), ready(list()));
    const { container } = renderCard();
    // Let the climate read settle; the evaluation must still not have fired.
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    await new Promise((r) => setTimeout(r, 30));
    expect(posted).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the winter list with the measured low, the split, and up-for-grabs moves', async () => {
    mock(climate(), ready(list()));
    renderCard();

    expect(await screen.findByText(/bring these plants in/i)).toBeInTheDocument();
    // The snapshot's own numbers, rounded — never a date or degree it did not measure.
    expect(
      screen.getByText(/tonight.s low is 2°C — under the 5°C frost line/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/2 plants aren.t in their winter space/i)).toBeInTheDocument();

    expect(screen.getByRole('link', { name: 'Basil' })).toHaveAttribute('href', '/plants/p-basil');
    expect(screen.getByText('Patio → Kitchen')).toBeInTheDocument();
    expect(screen.getByText('Ada')).toBeInTheDocument();

    expect(screen.getByText('No space set → Living room')).toBeInTheDocument();
    expect(screen.getByText('Up for grabs')).toBeInTheDocument();

    expect(screen.getByRole('link', { name: /open the task list/i })).toHaveAttribute(
      'href',
      '/tasks'
    );
    // No hardiness hint when the backend named nobody.
    expect(screen.queryByText(/frost-tender/i)).not.toBeInTheDocument();
  });

  it('renders the summer variant from the same snapshot numbers', async () => {
    mock(
      climate(),
      ready(
        list({
          season: 'summer',
          signal: { tempC: 33.6, lowC: 19, frostLineC: 5, heatLineC: 32 },
          items: [list().items[0]],
        })
      )
    );
    renderCard();
    expect(await screen.findByText(/these plants can go back out/i)).toBeInTheDocument();
    expect(screen.getByText(/it.s 34°C today — over the 32°C heat line/i)).toBeInTheDocument();
    expect(screen.getByText(/1 plant isn.t in its summer space/i)).toBeInTheDocument();
  });

  it('names frost-tender plants that still have no winter space, and says who was not checked', async () => {
    mock(
      climate(),
      ready(
        list({
          tenderWithoutWinterHome: [
            { plantId: 'p-cactus', plantName: 'Cactus', hardinessZone: '10-12' },
          ],
        })
      )
    );
    renderCard();
    expect(
      await screen.findByText(/1 frost-tender plant outdoors has no winter space yet/i)
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Cactus' })).toHaveAttribute(
      'href',
      '/plants/p-cactus'
    );
    expect(screen.getByText(/hardy to zone 10-12/i)).toBeInTheDocument();
    expect(screen.getByText(/aren.t cleared, just unchecked/i)).toBeInTheDocument();
  });

  it.each<MoveDayResult['status']>(['locked', 'not_applicable', 'unavailable', 'quiet'])(
    'stays silent — no card, no nag — when the backend says %s',
    async (status) => {
      const posted = mock(climate(), () => HttpResponse.json({ status }));
      const { container } = renderCard();
      await waitFor(() => expect(posted).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 30));
      expect(container).toBeEmptyDOMElement();
    }
  );

  it('stays silent for a ready list with nothing in it', async () => {
    const posted = mock(climate(), ready(list({ items: [] })));
    const { container } = renderCard();
    await waitFor(() => expect(posted).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 30));
    expect(container).toBeEmptyDOMElement();
  });

  it('stays silent when the evaluation itself fails (the frost warning lives on ClimateCard)', async () => {
    const posted = mock(climate(), () => new HttpResponse(null, { status: 500 }));
    const { container } = renderCard();
    await waitFor(() => expect(posted).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 30));
    expect(container).toBeEmptyDOMElement();
  });
});
