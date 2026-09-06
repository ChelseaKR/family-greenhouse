import { beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AutoHandoffCard } from '@/features/household/AutoHandoffCard';
import { billingService } from '@/services/billingService';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

vi.mock('@/services/billingService', () => ({
  billingService: {
    listPlans: vi.fn(),
    getCurrentSubscription: vi.fn(),
  },
}));

function catalog() {
  return {
    paymentsAvailable: false,
    commercialHold: { active: false, effectiveDate: '' },
    plans: [
      {
        id: 'seedling',
        name: 'Seedling',
        description: '',
        maxPlants: 10,
        maxMembers: 6,
        householdToolkit: false,
      },
      {
        id: 'garden',
        name: 'Garden',
        description: '',
        maxPlants: 500,
        maxMembers: 6,
        householdToolkit: true,
      },
      {
        id: 'greenhouse',
        name: 'Greenhouse',
        description: '',
        maxPlants: 5000,
        maxMembers: 50,
        householdToolkit: true,
      },
    ],
  };
}

function renderCard(escalateAfterDays: number | null = null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AutoHandoffCard householdId="hh-1" household={{ escalateAfterDays }} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('AutoHandoffCard', () => {
  beforeEach(() => {
    vi.mocked(billingService.listPlans).mockResolvedValue(catalog() as never);
  });

  it('renders the locked state, not the control, on a plan without the toolkit', async () => {
    vi.mocked(billingService.getCurrentSubscription).mockResolvedValue({
      planId: 'seedling',
    } as never);
    renderCard();
    expect(
      await screen.findByText('Auto-handoff is part of the Garden household toolkit.')
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See plans' })).toHaveAttribute('href', '/pricing');
    expect(screen.queryByLabelText('Put a task up for grabs after')).not.toBeInTheDocument();
  });

  it('lets a Garden admin turn the rule on, offering nothing below the 5-day floor', async () => {
    vi.mocked(billingService.getCurrentSubscription).mockResolvedValue({
      planId: 'garden',
    } as never);
    let sentBody: unknown = null;
    server.use(
      http.put(`${API}/households/hh-1/escalation`, async ({ request }) => {
        sentBody = await request.json();
        return HttpResponse.json({ escalateAfterDays: 7 });
      })
    );
    renderCard();
    const select = await screen.findByLabelText('Put a task up for grabs after');
    const offered = Array.from((select as HTMLSelectElement).options).map((o) => o.value);
    expect(offered).toEqual(['', '5', '7', '10', '14']);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    await userEvent.selectOptions(select, '7');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(sentBody).toEqual({ escalateAfterDays: 7 }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('can turn the rule off (null), and states the current value in the select', async () => {
    vi.mocked(billingService.getCurrentSubscription).mockResolvedValue({
      planId: 'garden',
    } as never);
    let sentBody: unknown = null;
    server.use(
      http.put(`${API}/households/hh-1/escalation`, async ({ request }) => {
        sentBody = await request.json();
        return HttpResponse.json({ escalateAfterDays: null });
      })
    );
    renderCard(10);
    const select = await screen.findByLabelText('Put a task up for grabs after');
    expect((select as HTMLSelectElement).value).toBe('10');
    await userEvent.selectOptions(select, '');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sentBody).toEqual({ escalateAfterDays: null }));
  });

  it('surfaces the server’s refusal instead of pretending it saved', async () => {
    vi.mocked(billingService.getCurrentSubscription).mockResolvedValue({
      planId: 'garden',
    } as never);
    server.use(
      http.put(`${API}/households/hh-1/escalation`, () =>
        HttpResponse.json(
          { message: 'Auto-handoff is part of the household toolkit' },
          { status: 402 }
        )
      )
    );
    renderCard();
    await userEvent.selectOptions(
      await screen.findByLabelText('Put a task up for grabs after'),
      '5'
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/household toolkit/)).toBeInTheDocument();
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('renders a failed plan read as unknown — current setting shown, changes paused (ADR 0010)', async () => {
    vi.mocked(billingService.getCurrentSubscription).mockRejectedValue(new Error('network'));
    renderCard(7);
    expect(
      await screen.findByText(/couldn’t check whether auto-handoff is included/)
    ).toBeInTheDocument();
    expect(screen.getByText('Currently after 7 days overdue.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Put a task up for grabs after')).not.toBeInTheDocument();
    expect(screen.queryByText(/part of the Garden household toolkit/)).not.toBeInTheDocument();
  });

  it('treats a catalog without the flag (rolling deploy) as unknown, never as locked', async () => {
    vi.mocked(billingService.listPlans).mockResolvedValue({
      ...catalog(),
      plans: catalog().plans.map(({ householdToolkit: _omit, ...plan }) => plan),
    } as never);
    vi.mocked(billingService.getCurrentSubscription).mockResolvedValue({
      planId: 'garden',
    } as never);
    renderCard();
    expect(
      await screen.findByText(/couldn’t check whether auto-handoff is included/)
    ).toBeInTheDocument();
    expect(screen.getByText('Currently off.')).toBeInTheDocument();
  });
});
