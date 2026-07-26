import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/healthService', () => ({
  healthService: {
    check: vi.fn(),
  },
}));

import { StatusPage } from '@/features/status/StatusPage';
import { healthService } from '@/services/healthService';

describe('StatusPage', () => {
  beforeEach(() => {
    vi.mocked(healthService.check).mockReset();
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
