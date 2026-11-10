import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/healthService', () => ({
  healthService: {
    check: vi.fn(),
  },
}));

import { IncidentLog } from '@/features/status/IncidentLog';
import { StatusPage } from '@/features/status/StatusPage';
import i18n, { ensureLanguageCatalog } from '@/i18n';
import { healthService } from '@/services/healthService';

const healthyResponse = {
  status: 'ok',
  version: 'test-version',
  checkedAt: '2026-07-25T12:00:00.000Z',
  components: {
    database: { status: 'ok' },
    auth: { status: 'ok' },
    mail: { status: 'ok' },
  },
} as const;

function renderStatusPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <StatusPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('StatusPage', () => {
  beforeEach(() => {
    vi.mocked(healthService.check).mockReset();
  });

  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('does not label providers operational when they are not actively checked', async () => {
    vi.mocked(healthService.check).mockResolvedValue({
      status: 'ok',
      version: 'test-version',
      checkedAt: '2026-07-25T12:00:00.000Z',
      components: {
        database: { status: 'ok' },
        auth: { status: 'unknown' },
        mail: { status: 'unknown' },
      },
    });

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <StatusPage />
        </MemoryRouter>
      </QueryClientProvider>
    );

    expect(await screen.findByText('Core API operational')).toBeInTheDocument();
    expect(await screen.findAllByText('Not actively checked')).toHaveLength(2);
    expect(screen.getAllByText('Operational')).toHaveLength(1);
  });

  it('does not read an empty hand-kept log as a measure of uptime', () => {
    // The log is written by hand. An empty list means nobody wrote anything
    // down, not that nothing happened, so it never says "no incidents".
    render(<IncidentLog incidents={[]} unreachable={false} serverErrored={false} />);

    expect(screen.queryByText(/no incidents/iu)).not.toBeInTheDocument();
    expect(screen.getByText(/written up by hand/iu)).toBeInTheDocument();
  });

  it('posts the plant tag outage, with its dates and the fix', async () => {
    vi.mocked(healthService.check).mockResolvedValue(healthyResponse);
    renderStatusPage();

    expect(await screen.findByText('Core API operational')).toBeInTheDocument();
    const entry = screen
      .getByRole('heading', { name: 'Plant tags weren’t working' })
      .closest('li') as HTMLElement;
    expect(within(entry).getByText('Resolved')).toBeInTheDocument();
    expect(entry).toHaveTextContent('From September 4 to October 5, 2026');
    expect(entry).toHaveTextContent('plant tags weren’t working');
    expect(entry).toHaveTextContent('We couldn’t load your plant tags');
    expect(entry).toHaveTextContent('version 0.39.0');
    // A public page: it says what people lost, in their words, not ours.
    expect(entry.textContent).not.toMatch(/routes?\b|server error|#931|function|deploy/iu);
    expect(screen.queryByText(/written up by hand/iu)).not.toBeInTheDocument();
  });

  it('dates an incident by the day written down, in a time zone west of UTC', async () => {
    // Vitest pins TZ to America/New_York. `new Date('2026-09-04')` is midnight
    // UTC, which is still September 3 there and across the United States.
    vi.mocked(healthService.check).mockResolvedValue(healthyResponse);
    renderStatusPage();

    await screen.findByText('Core API operational');
    const entry = screen
      .getByRole('heading', { name: 'Plant tags weren’t working' })
      .closest('li') as HTMLElement;
    expect(within(entry).getByText('Sep 4, 2026')).toBeInTheDocument();
  });

  it('posts the outage in Spanish', async () => {
    await ensureLanguageCatalog('es');
    await i18n.changeLanguage('es');
    vi.mocked(healthService.check).mockResolvedValue(healthyResponse);
    renderStatusPage();

    await screen.findByText('API principal operativa');
    const entry = screen
      .getByRole('heading', { name: 'Las etiquetas de plantas no funcionaban' })
      .closest('li') as HTMLElement;
    expect(within(entry).getByText('Resuelto')).toBeInTheDocument();
    expect(entry).toHaveTextContent('Del 4 de septiembre al 5 de octubre de 2026');
    expect(entry).toHaveTextContent('No pudimos cargar tus etiquetas de plantas');
    expect(entry).toHaveTextContent('versión 0.39.0');
    expect(entry.textContent).not.toMatch(/rutas?\b|servidor|#931|función|despliegue/iu);
  });

  it('does not claim the API is healthy before the first health response arrives', () => {
    vi.mocked(healthService.check).mockImplementation(() => new Promise(() => undefined));
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <StatusPage />
        </MemoryRouter>
      </QueryClientProvider>
    );

    expect(screen.getByText('Checking live system status…')).toBeInTheDocument();
    expect(screen.queryByText('Core API operational')).not.toBeInTheDocument();
    expect(screen.queryByText('Operational')).not.toBeInTheDocument();
  });
});
