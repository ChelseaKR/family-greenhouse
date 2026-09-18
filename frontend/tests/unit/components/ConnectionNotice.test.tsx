import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { ConnectionNotice } from '@/components/ConnectionNotice';

function renderNotice(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <ConnectionNotice />
    </QueryClientProvider>
  );
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('ConnectionNotice', () => {
  afterEach(() => {
    act(() => onlineManager.setOnline(true));
  });

  it('says nothing while reads are being answered', () => {
    renderNotice(client());
    expect(screen.queryByTestId('connection-notice')).not.toBeInTheDocument();
  });

  it('says the app is offline, how old the screen is, and what happens to a change', () => {
    const queryClient = client();
    queryClient.setQueryData(['tasks', 'hh'], [], {
      updatedAt: new Date(2026, 8, 18, 9, 5).getTime(),
    });
    vi.setSystemTime(new Date(2026, 8, 18, 12, 0));
    renderNotice(queryClient);

    act(() => onlineManager.setOnline(false));

    expect(screen.getByText("You're offline")).toBeInTheDocument();
    expect(screen.getByText(/What you see was last updated at 9:05/)).toBeInTheDocument();
    expect(
      screen.getByText(/sent once you're back online, as long as the app stays open/)
    ).toBeInTheDocument();
    // Offline, a retry would only pause again: there is no button to press.
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('names the date when the screen is older than today', () => {
    const queryClient = client();
    queryClient.setQueryData(['tasks', 'hh'], [], {
      updatedAt: new Date(2026, 8, 16, 18, 30).getTime(),
    });
    vi.setSystemTime(new Date(2026, 8, 18, 8, 0));
    renderNotice(queryClient);

    act(() => onlineManager.setOnline(false));

    expect(screen.getByText(/What you see was last updated on Sep 16, 2026/)).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('says the API cannot be reached when reads get no answer, and offers a retry', async () => {
    const queryClient = client();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    renderNotice(queryClient);

    await act(() =>
      queryClient
        .fetchQuery({
          queryKey: ['plants'],
          queryFn: () => Promise.reject(new AxiosError('Network Error', 'ERR_NETWORK')),
        })
        .catch(() => undefined)
    );

    expect(screen.getByText("Can't reach Family Greenhouse")).toBeInTheDocument();
    expect(screen.getByText('Nothing has loaded yet.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(invalidate).toHaveBeenCalledWith({ refetchType: 'active' });
  });
});
