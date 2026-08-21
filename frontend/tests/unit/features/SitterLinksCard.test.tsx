import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { SitterLinksCard } from '@/features/household/SitterLinksCard';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

/**
 * The card's "Active links" section is the only place an admin can revoke a
 * sitter link, so a FAILED read must not look like "no live links": that
 * rendered a card with no list, no error, and no Revoke control for links
 * that were still granting access to the household's task list.
 */
function renderCard(links: unknown[] | 'fail') {
  server.use(
    http.get(`${API}/households/hh-1/sitter-links`, () =>
      links === 'fail' ? new HttpResponse(null, { status: 500 }) : HttpResponse.json(links)
    )
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SitterLinksCard householdId="hh-1" />
    </QueryClientProvider>
  );
}

describe('SitterLinksCard existing-links read', () => {
  it('lists active links with a Revoke control when the read succeeds', async () => {
    renderCard([
      { id: 'l1', label: 'Neighbour', status: 'active', expiresAt: '2099-01-01T00:00:00.000Z' },
      { id: 'l2', label: 'Old', status: 'revoked', expiresAt: '2099-01-01T00:00:00.000Z' },
    ]);

    expect(await screen.findByText('Active links')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Revoke sitter link Neighbour' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Revoke sitter link Old' })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows nothing extra for a genuinely empty list', async () => {
    renderCard([]);

    expect(await screen.findByText('Plant-sitter links')).toBeInTheDocument();
    // Let the query settle, then assert the section stayed hidden with no error.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText('Active links')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says the existing links could not be loaded instead of implying there are none', async () => {
    renderCard('fail');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn.t load your existing sitter links/i);
    expect(alert).toHaveTextContent(/still active/i);
    expect(screen.queryByText('Active links')).not.toBeInTheDocument();
  });
});
