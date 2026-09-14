import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NoCardTrialNotice, NoCardTrialNoticeView } from '@/features/billing/NoCardTrialNotice';
import {
  NO_CARD_TRIAL_ENDED_DASHBOARD_DAYS,
  NO_CARD_TRIAL_ENDING_SOON_DAYS,
  noCardTrialNoticeKind,
  type NoCardTrialPlacement,
} from '@/features/billing/noCardTrialNoticeKind';
import { formatDate } from '@/i18n/format';
import {
  billingService,
  effectivePlanId,
  type Plan,
  type PlanCatalog,
  type SubscriptionState,
} from '@/services/billingService';

vi.mock('@/services/billingService', async () => {
  const actual = await vi.importActual<typeof import('@/services/billingService')>(
    '@/services/billingService'
  );
  return {
    ...actual,
    billingService: { getCurrentSubscription: vi.fn(), listPlans: vi.fn() },
  };
});
vi.mock('@/hooks/useActiveHouseholdId', () => ({ useActiveHouseholdId: () => 'hh-1' }));

const DAY = 24 * 60 * 60 * 1000;

const CATALOG = {
  paymentsAvailable: true,
  commercialHold: { active: false, effectiveDate: '2026-09-01' },
  plans: [
    {
      id: 'seedling',
      name: 'Seedling',
      description: '',
      maxPlants: 20,
      maxMembers: 3,
      limits: {
        homes: 1,
        members: 3,
        plants: 20,
        tags: 0,
        analyticsHistoryDays: 30,
        sitterLinkMaxDays: 7,
        sitterLinksActive: 1,
      },
    },
    {
      id: 'garden',
      name: 'Garden',
      description: '',
      maxPlants: 200,
      maxMembers: null,
      limits: {
        homes: 1,
        members: null,
        plants: 200,
        tags: 50,
        analyticsHistoryDays: null,
        sitterLinkMaxDays: 90,
        sitterLinksActive: 10,
      },
    },
  ] as unknown as Plan[],
} as PlanCatalog;

function trialEndingIn(ms: number, state: 'active' | 'ended'): SubscriptionState {
  return {
    planId: 'seedling',
    trialAvailable: true,
    noCardTrial: { state, endsAt: new Date(Date.now() + ms).toISOString() },
  };
}

function renderNotice(placement: NoCardTrialPlacement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <NoCardTrialNotice placement={placement} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.mocked(billingService.listPlans).mockResolvedValue(CATALOG);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('noCardTrialNoticeKind', () => {
  const now = new Date('2026-09-25T12:00:00.000Z');
  const sub = (endsAt: string, state: 'active' | 'ended'): SubscriptionState => ({
    planId: 'seedling',
    noCardTrial: { state, endsAt },
  });

  it('says nothing for a household with no no-card trial, including one on Stripe', () => {
    expect(noCardTrialNoticeKind(undefined, 'dashboard', now)).toBeNull();
    expect(noCardTrialNoticeKind({ planId: 'seedling' }, 'dashboard', now)).toBeNull();
    expect(
      noCardTrialNoticeKind(
        { planId: 'garden', status: 'trialing', noCardTrial: null },
        'billing',
        now
      )
    ).toBeNull();
  });

  it(`starts, then warns in the last ${NO_CARD_TRIAL_ENDING_SOON_DAYS} days`, () => {
    expect(NO_CARD_TRIAL_ENDING_SOON_DAYS).toBe(3);
    expect(noCardTrialNoticeKind(sub('2026-10-04T23:30:00.000Z', 'active'), 'dashboard', now)).toBe(
      'started'
    );
    expect(noCardTrialNoticeKind(sub('2026-09-28T12:00:00.000Z', 'active'), 'dashboard', now)).toBe(
      'endingSoon'
    );
    expect(noCardTrialNoticeKind(sub('2026-09-28T12:00:00.001Z', 'active'), 'dashboard', now)).toBe(
      'started'
    );
  });

  it(`says what changed; the dashboard stops after ${NO_CARD_TRIAL_ENDED_DASHBOARD_DAYS} days, billing does not`, () => {
    expect(NO_CARD_TRIAL_ENDED_DASHBOARD_DAYS).toBe(7);
    const endedEightDaysAgo = sub('2026-09-17T12:00:00.000Z', 'ended');
    expect(noCardTrialNoticeKind(sub('2026-09-24T12:00:00.000Z', 'ended'), 'dashboard', now)).toBe(
      'ended'
    );
    expect(noCardTrialNoticeKind(endedEightDaysAgo, 'dashboard', now)).toBeNull();
    expect(noCardTrialNoticeKind(endedEightDaysAgo, 'billing', now)).toBe('ended');
  });

  it('trusts the server that a trial has ended even when the local clock disagrees', () => {
    expect(noCardTrialNoticeKind(sub('2026-10-30T00:00:00.000Z', 'ended'), 'billing', now)).toBe(
      'ended'
    );
  });
});

describe('effectivePlanId', () => {
  it('is Garden while a no-card trial runs, and the plan on file otherwise', () => {
    expect(effectivePlanId(trialEndingIn(5 * DAY, 'active'))).toBe('garden');
    expect(effectivePlanId(trialEndingIn(-DAY, 'ended'))).toBe('seedling');
    expect(effectivePlanId({ planId: 'seedling' })).toBe('seedling');
    expect(effectivePlanId({ planId: 'garden', status: 'trialing', noCardTrial: null })).toBe(
      'garden'
    );
    expect(
      effectivePlanId({
        planId: 'greenhouse',
        noCardTrial: { state: 'active', endsAt: '2999-01-01T00:00:00.000Z' },
      })
    ).toBe('greenhouse');
    expect(effectivePlanId(undefined)).toBeNull();
  });
});

describe('NoCardTrialNotice', () => {
  it('at the start: what the trial includes, that no card is needed, and when it ends', async () => {
    const sub = trialEndingIn(11 * DAY, 'active');
    vi.mocked(billingService.getCurrentSubscription).mockResolvedValue(sub);
    renderNotice('dashboard');
    const date = formatDate(sub.noCardTrial!.endsAt, { month: 'long' });

    expect(
      await screen.findByText(`Your household is trying Garden free until ${date}`)
    ).toBeInTheDocument();
    const notice = screen.getByTestId('no-card-trial-notice');
    expect(notice).toHaveAttribute('data-kind', 'started');
    expect(notice).toHaveTextContent('No card is needed, and nothing will be charged.');
    expect(
      await screen.findByText(
        /more than 3 members, up to 200 plants, several sitter links at once of up to 90 days/
      )
    ).toBeInTheDocument();
    expect(notice).toHaveTextContent(
      'Plant identifications, leaf-health checks and the care assistant use the free plan’s monthly allowances during the trial.'
    );
    expect(notice).toHaveTextContent(
      `On ${date} the household moves to the free Seedling plan on its own. Nothing is charged, and nothing you added is deleted.`
    );
    expect(screen.getByRole('link', { name: 'Plans and billing' })).toHaveAttribute(
      'href',
      '/settings/billing'
    );
  });

  it('before the end: the date, and exactly what changes', async () => {
    const sub = trialEndingIn(2 * DAY, 'active');
    vi.mocked(billingService.getCurrentSubscription).mockResolvedValue(sub);
    renderNotice('billing');
    const date = formatDate(sub.noCardTrial!.endsAt, { month: 'long' });

    expect(
      await screen.findByText(`Your household’s Garden trial ends on ${date}`)
    ).toBeInTheDocument();
    expect(screen.getByTestId('no-card-trial-notice')).toHaveAttribute('data-kind', 'endingSoon');
    expect(screen.getByText('When it ends:')).toBeInTheDocument();
    expect(
      await screen.findByText(
        'Every plant stays and can still be edited. Adding a plant waits until fewer than 20 are active.'
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Everyone stays. Nobody new can join until the household has fewer than 3 members.'
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Sitter links already shared keep their task list until they expire, without the handoff brief or photo-back. A new link can cover up to 7 days, one at a time.'
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText('Analytics show the last 30 days. Older history is kept, not deleted.')
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Choosing a paid plan replaces this trial with a subscription, which goes through checkout and needs a card.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Plans and billing' })).not.toBeInTheDocument();
  });

  it('at fallback: what changed, and that nothing was charged or deleted', async () => {
    const sub = trialEndingIn(-DAY, 'ended');
    vi.mocked(billingService.getCurrentSubscription).mockResolvedValue(sub);
    renderNotice('dashboard');
    const date = formatDate(sub.noCardTrial!.endsAt, { month: 'long' });

    expect(
      await screen.findByText(`Your household’s Garden trial ended on ${date}`)
    ).toBeInTheDocument();
    const notice = screen.getByTestId('no-card-trial-notice');
    expect(notice).toHaveAttribute('data-kind', 'ended');
    expect(notice).toHaveTextContent(
      'The household is on the free Seedling plan. Nothing was charged, and nothing was deleted.'
    );
    expect(await screen.findByText('What changed:')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Printed plant tags keep working when scanned. Managing and printing tags needs Garden.'
      )
    ).toBeInTheDocument();
    expect(notice).not.toHaveTextContent('No card is needed');
  });

  it('the billing-page view holds no query of its own: it renders with no QueryClient at all', () => {
    const sub = trialEndingIn(2 * DAY, 'active');
    render(
      <MemoryRouter>
        <NoCardTrialNoticeView placement="billing" subscription={sub} plans={CATALOG.plans} />
      </MemoryRouter>
    );
    expect(screen.getByTestId('no-card-trial-notice')).toHaveAttribute('data-kind', 'endingSoon');
    expect(billingService.getCurrentSubscription).not.toHaveBeenCalled();
    expect(billingService.listPlans).not.toHaveBeenCalled();
  });

  it('renders nothing for a household on a Stripe subscription or card trial', async () => {
    vi.mocked(billingService.getCurrentSubscription).mockResolvedValue({
      planId: 'garden',
      status: 'trialing',
      trialAvailable: false,
      noCardTrial: null,
    });
    const { container } = renderNotice('billing');
    await vi.waitFor(() => expect(billingService.getCurrentSubscription).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it('leaves out every line that needs a figure the catalog has not delivered, rather than guessing it', async () => {
    vi.mocked(billingService.listPlans).mockReturnValue(new Promise(() => {}));
    const sub = trialEndingIn(2 * DAY, 'active');
    vi.mocked(billingService.getCurrentSubscription).mockResolvedValue(sub);
    renderNotice('billing');

    const notice = await screen.findByTestId('no-card-trial-notice');
    expect(notice).toHaveTextContent('No card is needed, and nothing will be charged.');
    expect(notice).not.toHaveTextContent(/\d+ plants|\d+ days\.|\d+ members/);
    expect(screen.queryByText('When it ends:')).not.toBeInTheDocument();
  });
});
