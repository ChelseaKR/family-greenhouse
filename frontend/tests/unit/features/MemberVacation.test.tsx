/**
 * Regression test for the vacation-window date bug: start/end dates picked
 * in a `<input type="date">` must resolve to LOCAL midnight / local
 * 23:59:59.999, not hardcoded UTC midnight (which drifts by the caller's
 * UTC offset). The assertions decode the ISO strings back with `new Date`
 * and read local hour/minute/second — timezone-agnostic, since both the
 * construction and the decode happen in the same process clock (pinned to
 * America/New_York by frontend/vitest.config.ts, a non-UTC offset, so a
 * regression to hardcoded `Z` strings would fail this test).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemberVacation } from '@/features/household/MemberVacation';
import { taskService } from '@/services/taskService';
import type { HouseholdMember } from '@/services/householdService';

vi.mock('@/services/taskService', () => ({
  taskService: {
    setVacation: vi.fn(),
    getVacationWindows: vi.fn(),
    cancelVacation: vi.fn(),
  },
}));

const setVacation = vi.mocked(taskService.setVacation);

const member: HouseholdMember = {
  userId: 'user-1',
  name: 'Alice',
  role: 'member',
  joinedAt: '',
};
const cover: HouseholdMember = {
  userId: 'user-2',
  name: 'Bob',
  role: 'member',
  joinedAt: '',
};

function renderForm() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemberVacation
        householdId="hh-1"
        member={member}
        members={[member, cover]}
        canManage
        window={undefined}
      />
    </QueryClientProvider>
  );
}

describe('MemberVacation date window', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setVacation.mockResolvedValue({
      householdId: 'hh-1',
      userId: 'user-1',
      coveredBy: 'user-2',
      coveredByName: 'Bob',
      startDate: '',
      endDate: '',
      createdBy: 'user-1',
      createdAt: '',
    });
  });

  it('submits a window spanning local midnight-to-midnight, not fixed UTC midnight', async () => {
    renderForm();

    fireEvent.click(screen.getByText('Set vacation'));
    fireEvent.change(screen.getByLabelText('Start date'), {
      target: { value: '2026-07-10' },
    });
    fireEvent.change(screen.getByLabelText('End date'), {
      target: { value: '2026-07-12' },
    });
    fireEvent.click(screen.getByText('Save vacation'));

    await waitFor(() => expect(setVacation).toHaveBeenCalledTimes(1));
    const { startDate, endDate } = setVacation.mock.calls[0][0];

    const start = new Date(startDate);
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(6); // July, 0-indexed
    expect(start.getDate()).toBe(10);
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(start.getSeconds()).toBe(0);
    expect(start.getMilliseconds()).toBe(0);

    const end = new Date(endDate);
    expect(end.getFullYear()).toBe(2026);
    expect(end.getMonth()).toBe(6);
    expect(end.getDate()).toBe(12);
    expect(end.getHours()).toBe(23);
    expect(end.getMinutes()).toBe(59);
    expect(end.getSeconds()).toBe(59);
    expect(end.getMilliseconds()).toBe(999);

    // The old bug hardcoded a "Z" (UTC) suffix; assert it's gone in favor of
    // an offset that reflects the local (America/New_York) timezone.
    expect(startDate).not.toMatch(/T00:00:00\.000Z$/);
    expect(endDate).not.toMatch(/T23:59:59\.000Z$/);
  });
});
