import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { ClimateCard } from '@/features/dashboard/ClimateCard';
import type { ClimateResponse } from '@/services/climateService';
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
        <ClimateCard />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function climate(overrides: Partial<ClimateResponse> = {}): ClimateResponse {
  return {
    configured: true,
    location: { city: 'Portland', lat: 45.5, lon: -122.6 },
    weather: {
      observedAt: '2026-08-23T05:00:00.000Z',
      tempC: 4,
      humidity: 61,
      condition: 'Clear',
      description: 'clear sky',
      forecast: [],
    },
    tips: [],
    ...overrides,
  };
}

const FROST_TIP = {
  level: 'warning' as const,
  appliesTo: ['tropical' as const],
  message: 'Low of -2°C tonight. Bring tender plants indoors.',
};

describe('ClimateCard', () => {
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

  it('renders a frost warning when the climate read succeeds', async () => {
    server.use(
      http.get(`${API}/households/hh-1/climate`, () =>
        HttpResponse.json(climate({ tips: [FROST_TIP] }))
      )
    );
    renderCard();

    expect(
      await screen.findByText(/Low of -2°C tonight\. Bring tender plants indoors\./)
    ).toBeInTheDocument();
  });

  // The defect (#351): `if (!data) return null` collapsed a FAILED read into
  // the same silence as "no household" and "no location + integration off".
  // A household that would have seen the frost warning above saw nothing at
  // all, indistinguishable from a night with nothing to report.
  it('says the local climate could not be read when the read fails, instead of rendering nothing', async () => {
    server.use(
      http.get(`${API}/households/hh-1/climate`, () =>
        HttpResponse.json({ message: 'boom' }, { status: 500 })
      )
    );
    renderCard();

    expect(await screen.findByText(/Local climate unavailable\./)).toBeInTheDocument();
    expect(
      screen.getByText(/frost, heat, or rain warning for tonight is unchecked rather than clear/i)
    ).toBeInTheDocument();
  });

  it('does not claim the climate is fine when the read fails', async () => {
    server.use(http.get(`${API}/households/hh-1/climate`, () => HttpResponse.error()));
    renderCard();

    await screen.findByText(/Local climate unavailable\./);
    // A failed read must never render as a city + reading, which is the
    // shape a reader takes for "we checked, and here is tonight".
    expect(screen.queryByText(/outdoor\s*humidity/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Portland')).not.toBeInTheDocument();
  });

  it('still renders nothing when there is no saved location and the integration is off', async () => {
    server.use(
      http.get(`${API}/households/hh-1/climate`, () =>
        HttpResponse.json(climate({ configured: false, location: null, weather: null }))
      )
    );
    const { container } = renderCard();

    // Settle the read before asserting absence, so this is not just the
    // in-flight state passing for the empty one.
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(screen.queryByText(/Local climate unavailable\./)).not.toBeInTheDocument();
  });

  it('prompts for a location when the integration is on but no city is saved', async () => {
    server.use(
      http.get(`${API}/households/hh-1/climate`, () =>
        HttpResponse.json(climate({ location: null, weather: null }))
      )
    );
    renderCard();

    expect(await screen.findByText(/Add household location/)).toBeInTheDocument();
    expect(screen.queryByText(/Local climate unavailable\./)).not.toBeInTheDocument();
  });
});
