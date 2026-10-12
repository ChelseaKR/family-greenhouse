import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Layout } from '@/components/Layout';
import { useAuthStore } from '@/store/authStore';
import * as householdService from '@/services/householdService';
import { billingService } from '@/services/billingService';

vi.mock('@/services/analytics', () => ({
  track: vi.fn(),
  setActiveHousehold: vi.fn(),
  identify: vi.fn(),
  setTelemetryAuthToken: vi.fn(),
  reset: vi.fn(),
}));

/**
 * The memorial line closes every signed-in page of the website. In the iOS
 * and Android apps it lives only on Settings → About (owner decision
 * 2026-10-02), so the app frame must not draw it there.
 */
const MEMORIAL = 'In loving memory of my mom, Joyce — who taught us to keep growing.';

function renderFrame() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/dashboard" element={<div>dashboard body</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('the memorial line in the app frame', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(householdService, 'listMyHouseholds').mockResolvedValue([
      { householdId: 'hh-1', name: 'Home', role: 'admin', joinedAt: '' },
    ]);
    vi.spyOn(billingService, 'getCurrentSubscription').mockResolvedValue({
      planId: 'seedling',
    } as never);
    useAuthStore.setState({
      user: {
        id: 'u1',
        email: 'someone@example.invalid',
        name: 'Someone',
        householdId: 'hh-1',
        householdRole: 'admin',
      },
      idToken: 'id-1',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      isAuthenticated: true,
      isLoading: false,
      activeHouseholdId: null,
    });
  });

  afterEach(() => {
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  });

  it('closes every page on the website', async () => {
    renderFrame();
    expect(await screen.findByText('dashboard body')).toBeInTheDocument();
    expect(screen.getByText(MEMORIAL)).toBeInTheDocument();
  });

  it('is not drawn under every screen inside the iOS app', async () => {
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
    };
    renderFrame();
    expect(await screen.findByText('dashboard body')).toBeInTheDocument();
    expect(screen.queryByText(MEMORIAL)).not.toBeInTheDocument();
  });
});
