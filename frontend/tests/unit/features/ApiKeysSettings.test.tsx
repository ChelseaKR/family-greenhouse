import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { http, HttpResponse } from 'msw';
import { ApiKeysSettings } from '@/features/settings/ApiKeysSettings';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

function renderSettings() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ApiKeysSettings />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const KEY = {
  id: 'k1',
  householdId: 'hh-1',
  label: 'Home Assistant',
  last4: 'ab12',
  scopes: ['read:plants'],
  createdAt: '2026-08-01T00:00:00.000Z',
  createdBy: 'u1',
  lastUsedAt: null,
};

describe('ApiKeysSettings', () => {
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
    server.use(
      http.get(`${API}/me/households`, () =>
        HttpResponse.json([{ householdId: 'hh-1', name: 'Home', role: 'admin', joinedAt: '' }])
      ),
      // Issuing keys is Greenhouse-only; the existing tests describe an
      // entitled household, so the tier read answers Greenhouse here.
      http.get(`${API}/billing/me`, () => HttpResponse.json({ planId: 'greenhouse' }))
    );
  });

  it('renders issuing LOCKED (not hidden) below Greenhouse, and keeps the existing keys listed', async () => {
    server.use(
      http.get(`${API}/billing/me`, () => HttpResponse.json({ planId: 'garden' })),
      http.get(`${API}/billing/plans`, () =>
        HttpResponse.json({
          paymentsAvailable: true,
          commercialHold: { active: false, effectiveDate: '2026-09-01' },
          plans: [
            { id: 'seedling', name: 'Seedling', description: '', maxPlants: 10, maxMembers: 6 },
            { id: 'garden', name: 'Garden', description: '', maxPlants: 500, maxMembers: 6 },
            {
              id: 'greenhouse',
              name: 'Greenhouse',
              description: '',
              maxPlants: 5000,
              maxMembers: 50,
              monthlyPrice: 9.99,
            },
          ],
        })
      ),
      http.get(`${API}/households/hh-1`, () =>
        HttpResponse.json({
          id: 'hh-1',
          name: 'Home',
          createdAt: '',
          createdBy: 'u1',
          members: [{ userId: 'u1', name: 'Test', role: 'admin', joinedAt: '' }],
        })
      ),
      http.get(`${API}/api-keys`, () => HttpResponse.json([KEY]))
    );
    renderSettings();

    expect(await screen.findByTestId('locked-included')).toHaveTextContent(
      /Included with Greenhouse/
    );
    // The admin viewer gets the change-plan link, not an ask button.
    expect(screen.getByRole('link', { name: 'Change plan' })).toHaveAttribute(
      'href',
      '/settings/billing'
    );
    expect(screen.queryByRole('button', { name: 'Issue key' })).not.toBeInTheDocument();
    expect(await screen.findByText('Home Assistant')).toBeInTheDocument();
  });

  it('lists issued keys when the read succeeds', async () => {
    server.use(http.get(`${API}/api-keys`, () => HttpResponse.json([KEY])));
    renderSettings();

    expect(await screen.findByText('Active keys (1)')).toBeInTheDocument();
    expect(screen.getByText('Home Assistant')).toBeInTheDocument();
  });

  it('says there are no keys yet on a genuinely empty read', async () => {
    server.use(http.get(`${API}/api-keys`, () => HttpResponse.json([])));
    renderSettings();

    expect(await screen.findByText('Active keys (0)')).toBeInTheDocument();
    expect(screen.getByText('No keys yet.')).toBeInTheDocument();
  });

  // The defect (#349): only `isLoading` was checked, so a failed list read
  // fell through to the zero-state. An admin saw "Active keys (0)" and "No
  // keys yet." while live keys still granted programmatic access to household
  // data, with no error and no Revoke control to reach them.
  it('does not render a failed key read as the zero-state', async () => {
    server.use(
      http.get(`${API}/api-keys`, () => HttpResponse.json({ message: 'boom' }, { status: 500 }))
    );
    renderSettings();

    expect(
      await screen.findByText(/We couldn.?t load your API keys/i, { exact: false })
    ).toBeInTheDocument();
    expect(screen.queryByText('No keys yet.')).not.toBeInTheDocument();
    expect(screen.queryByText('Active keys (0)')).not.toBeInTheDocument();
    expect(screen.getByText('Active keys')).toBeInTheDocument();
  });

  it('says an earlier key may still be active when the read fails', async () => {
    server.use(http.get(`${API}/api-keys`, () => HttpResponse.error()));
    renderSettings();

    // The count is unknown, so the copy must not let "we could not read" be
    // taken for "nothing is out there".
    const notice = await screen.findByText(/Nothing changed/i, { exact: false });
    expect(notice).toBeInTheDocument();

    // ...and it must not overstate the other way either. The sentence used to
    // end "still active until you revoke it", which named revocation as the
    // only way a key stops working. `middleware/apiKey.ts` re-checks BOTH the
    // household's Greenhouse entitlement and the issuer's membership on every
    // single use, so a key also dies on downgrade or when its issuer leaves —
    // the two cases an admin reading this during an outage most needs to know
    // are possible.
    expect(notice.textContent).toMatch(/revoke it/i);
    expect(notice.textContent).toMatch(/leaves/i);
    expect(notice.textContent).toMatch(/Greenhouse/i);
  });
});
