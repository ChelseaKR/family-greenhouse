/**
 * #456: the pickers. With `data: spaces = []` a failed rooms read rendered a
 * destination `<select>` containing nothing but "Unplaced" — "you have nowhere
 * to put this" — on a control the user opened specifically to choose a room.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { SpacePicker } from '@/features/plants/SpacePicker';
import { useSpaces } from '@/hooks/useSpaces';

vi.mock('@/hooks/useSpaces', () => ({ useSpaces: vi.fn() }));

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

function mockSpaces(status: 'ready' | 'unavailable') {
  vi.mocked(useSpaces).mockReturnValue({
    status,
    spaces: [],
    byId: new Map(),
    unavailable: status === 'unavailable',
    error: status === 'unavailable' ? new Error('network') : null,
  });
}

beforeEach(() => vi.clearAllMocks());

describe('SpacePicker when the rooms read failed', () => {
  it('says the rooms could not be loaded instead of offering an empty list', () => {
    mockSpaces('unavailable');
    wrap(<SpacePicker value="" onChange={vi.fn()} />);
    expect(screen.getByText(/couldn’t load your spaces|couldn’t load your rooms/i)).toBeVisible();
  });

  it('stays silent when the household genuinely has no rooms yet', () => {
    mockSpaces('ready');
    wrap(<SpacePicker value="" onChange={vi.fn()} />);
    expect(
      screen.queryByText(/couldn’t load your spaces|couldn’t load your rooms/i)
    ).not.toBeInTheDocument();
  });
});
