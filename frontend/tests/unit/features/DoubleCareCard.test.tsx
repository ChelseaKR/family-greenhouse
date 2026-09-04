import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { DoubleCareCard } from '@/features/analytics/DoubleCareCard';
import type { DailyAnalytics } from '@/services/householdService';

function renderCard(props: { loading: boolean; daily: DailyAnalytics | undefined }) {
  return render(
    <MemoryRouter>
      <DoubleCareCard {...props} />
    </MemoryRouter>
  );
}

const daily = (doubleCare?: DailyAnalytics['doubleCare']): DailyAnalytics => ({
  days: 30,
  series: [],
  doubleCare,
});

describe('DoubleCareCard', () => {
  it('shows a real count when the server counted', () => {
    renderCard({
      loading: false,
      daily: daily({ status: 'ok', month: '2026-09', confirmedDuplicates: 3 }),
    });
    expect(screen.getByText('3 confirmed duplicates')).toBeInTheDocument();
    expect(screen.getByText(/September 2026/)).toBeInTheDocument();
  });

  it('shows a real zero only when the server said ok', () => {
    renderCard({
      loading: false,
      daily: daily({ status: 'ok', month: '2026-09', confirmedDuplicates: 0 }),
    });
    expect(screen.getByText('No double-care confirmed yet this month.')).toBeInTheDocument();
  });

  it('never renders a failed read as zero — analytics failed, field missing, or unavailable', () => {
    const unavailable = 'We couldn’t check double-care just now.';
    const { unmount: a } = renderCard({ loading: false, daily: undefined });
    expect(screen.getByText(unavailable)).toBeInTheDocument();
    a();
    const { unmount: b } = renderCard({ loading: false, daily: daily(undefined) });
    expect(screen.getByText(unavailable)).toBeInTheDocument();
    b();
    renderCard({ loading: false, daily: daily({ status: 'unavailable' }) });
    expect(screen.getByText(unavailable)).toBeInTheDocument();
    expect(screen.queryByText(/confirmed duplicate/)).not.toBeInTheDocument();
  });

  it('renders the locked feature to free households with a way to the plans', () => {
    renderCard({ loading: false, daily: daily({ status: 'not_in_plan' }) });
    expect(screen.getByText(/part of the Garden household toolkit/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See plans' })).toHaveAttribute('href', '/pricing');
  });

  it('shows a spinner, not a number, while loading', () => {
    renderCard({ loading: true, daily: undefined });
    expect(screen.queryByText(/confirmed duplicate|couldn’t check/)).not.toBeInTheDocument();
  });
});
