import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { http, HttpResponse } from 'msw';
import i18n from '@/i18n';
import { CoverageCard } from '@/features/analytics/CoverageCard';
import { useAuthStore } from '@/store/authStore';
import { useToastStore } from '@/store/toastStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

/**
 * Coverage is the bus-factor view, deliberately not a leaderboard. These
 * tests pin the three settled states the card must never blur together
 * (failed read / locked plan / household of one), the copy that makes it a
 * fragility view rather than a scoreboard, and the two calls to action.
 */

const priya = { userId: 'user-1', name: 'Priya' };
const sam = { userId: 'user-2', name: 'Sam' };

function plant(
  id: string,
  name: string,
  caregivers: Array<{ userId: string; name: string }>,
  sole: { userId: string; name: string } | null
) {
  return {
    plantId: id,
    plantName: name,
    caregivers,
    caregiverCount: caregivers.length,
    soleCaregiver: sole,
  };
}

const TWO_MEMBER_REPORT = {
  members: [priya, sam],
  memberCount: 2,
  plantCount: 3,
  plants: [
    plant('p-aloe', 'Aloe', [sam], sam),
    plant('p-fern', 'Fern', [priya, sam], null),
    plant('p-monstera', 'Monstera', [priya], priya),
  ],
  soleCaregiverPlants: [
    plant('p-aloe', 'Aloe', [sam], sam),
    plant('p-monstera', 'Monstera', [priya], priya),
  ],
  uncaredPlantCount: 0,
  awayRisks: [],
  generatedAt: '2026-09-03T00:00:00.000Z',
};

function task(id: string, plantId: string, type = 'water', nextDue = '2026-09-05T08:00:00.000Z') {
  return {
    id,
    plantId,
    plantName: 'x',
    type,
    customType: null,
    frequency: 7,
    lastCompleted: null,
    nextDue,
    assignedTo: 'user-1',
    assignedToName: 'Priya',
    assignmentSource: null,
    notes: null,
    createdBy: 'user-1',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

/**
 * `plan` drives the CATALOG, which is what decides whether the request is made
 * at all. Only a POSITIVE entitlement asks (same rule as AwayRecapPage):
 *   'on'      — the tier includes the toolkit (the default; the read happens)
 *   'off'     — the catalog says it does not: locked, and no request
 *   'noFlag'  — an older catalog with no toolkit field: UNKNOWN, no request
 *   'fail'    — the catalog is unreachable: UNKNOWN, no request
 */
type PlanMode = 'on' | 'off' | 'noFlag' | 'fail';

/** Requests the card actually made to the coverage endpoint, per render. */
let coverageRequests = 0;

function renderCard({
  coverage,
  tasks = [],
  plan = 'on',
}: {
  coverage: unknown | 'fail' | 'locked';
  tasks?: unknown[];
  plan?: PlanMode;
}) {
  coverageRequests = 0;
  server.use(
    http.get(`${API}/households/hh-1/analytics/coverage`, () => {
      coverageRequests += 1;
      if (coverage === 'fail') return new HttpResponse(null, { status: 500 });
      if (coverage === 'locked') {
        return HttpResponse.json({ message: 'Garden plan and up' }, { status: 402 });
      }
      return HttpResponse.json(coverage as never);
    }),
    http.get(`${API}/tasks`, () => HttpResponse.json(tasks)),
    http.get(`${API}/billing/me`, () => HttpResponse.json({ planId: 'garden' })),
    http.get(`${API}/billing/plans`, () => {
      if (plan === 'fail') return new HttpResponse(null, { status: 500 });
      const garden: Record<string, unknown> = {
        id: 'garden',
        name: 'Garden',
        description: '',
        maxPlants: 200,
        maxMembers: null,
      };
      if (plan !== 'noFlag') {
        garden.features = { householdToolkit: plan === 'on' };
      }
      return HttpResponse.json({
        paymentsAvailable: false,
        commercialHold: { active: false, effectiveDate: '' },
        plans: [garden],
      });
    })
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/analytics']}>
        <CoverageCard />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  useToastStore.setState({ toasts: [] });
  useAuthStore.setState({
    user: {
      id: 'user-1',
      email: 'priya@example.com',
      name: 'Priya',
      householdId: 'hh-1',
      householdRole: 'member',
    },
    isAuthenticated: true,
    isLoading: false,
  } as never);
});

describe('CoverageCard — settled states', () => {
  it('says the read failed, and never claims every plant is covered', async () => {
    renderCard({ coverage: 'fail' });
    await screen.findByText(/couldn.t check coverage just now/i);
    expect(screen.queryByText(/every plant has at least two people/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/plants have only ever been cared for/i)).not.toBeInTheDocument();
  });

  it('renders the locked state on a plan without the household toolkit', async () => {
    // Defence in depth: the catalog says the tier IS entitled, so the request
    // is made, and the server's 402 must still settle as locked (not an error,
    // not an empty report).
    renderCard({ coverage: 'locked', plan: 'on' });
    await screen.findByText(/part of the Garden household toolkit/i);
    expect(screen.getByRole('link', { name: /view plan status/i })).toHaveAttribute(
      'href',
      '/settings/billing'
    );
    expect(screen.queryByText(/couldn.t check coverage/i)).not.toBeInTheDocument();
  });

  // The E2E console gate (responsive-ux.spec.ts) fails the build on any
  // browser console error, and a 402 the browser receives is logged by the
  // browser itself — no application catch can suppress it. So on a plan the
  // catalog says is off, the request must never be made.
  it('never requests coverage when the catalog says the tier has no toolkit', async () => {
    renderCard({ coverage: TWO_MEMBER_REPORT, plan: 'off' });

    await screen.findByText(/part of the Garden household toolkit/i);
    expect(coverageRequests).toBe(0);
    // Locked, not failed: the household is told why, not shown an error.
    expect(screen.queryByText(/couldn.t check coverage/i)).not.toBeInTheDocument();
    // And never the reassurance it did not earn.
    expect(screen.queryByText(/every plant has at least two people/i)).not.toBeInTheDocument();
  });

  it('says the plan could not be checked, and claims nothing either way', async () => {
    // An unreadable catalog must not become a silent "locked" (a paying
    // household would be shown an upgrade ad) nor a silent "covered".
    renderCard({ coverage: TWO_MEMBER_REPORT, plan: 'fail' });

    await screen.findByText(/couldn.t check your plan/i);
    expect(coverageRequests).toBe(0);
    expect(screen.queryByText(/part of the Garden household toolkit/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/every plant has at least two people/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/plants have only ever been cared for by one person/i)
    ).not.toBeInTheDocument();
  });

  it('treats a catalog with no toolkit field as unknown, not as entitled', async () => {
    renderCard({ coverage: TWO_MEMBER_REPORT, plan: 'noFlag' });

    await screen.findByText(/couldn.t check your plan/i);
    expect(coverageRequests).toBe(0);
  });

  it('makes exactly one coverage request on an entitled plan', async () => {
    renderCard({ coverage: TWO_MEMBER_REPORT, plan: 'on' });

    await screen.findByText(/plants have only ever been cared for by one person/i);
    expect(coverageRequests).toBe(1);
    expect(screen.queryByText(/part of the Garden household toolkit/i)).not.toBeInTheDocument();
  });

  it('gives a household of one an honest "needs a second member", not a red list', async () => {
    renderCard({
      coverage: {
        ...TWO_MEMBER_REPORT,
        members: [priya],
        memberCount: 1,
        // Every plant rests on Priya by construction — the card must not list them.
        soleCaregiverPlants: TWO_MEMBER_REPORT.plants.map((p) => ({
          ...p,
          caregivers: [priya],
          caregiverCount: 1,
          soleCaregiver: priya,
        })),
      },
    });
    await screen.findByText(/coverage needs a second member/i);
    expect(screen.getByRole('link', { name: /invite someone/i })).toHaveAttribute(
      'href',
      '/household'
    );
    expect(screen.queryByText('Monstera')).not.toBeInTheDocument();
    expect(screen.queryByText(/only you have ever cared/i)).not.toBeInTheDocument();
  });

  it('renders an explicit all-clear when nothing rests on one person', async () => {
    renderCard({
      coverage: { ...TWO_MEMBER_REPORT, soleCaregiverPlants: [] },
    });
    await screen.findByText(/every plant has at least two people who have cared for it/i);
    expect(screen.queryByText(/plants resting on one person/i)).not.toBeInTheDocument();
  });
});

describe('CoverageCard — the fragility view', () => {
  it('counts plants, names the one person who knows each, and keeps the API order (by name)', async () => {
    renderCard({ coverage: TWO_MEMBER_REPORT, tasks: [task('t-1', 'p-monstera')] });
    await screen.findByText('2 of 3 plants have only ever been cared for by one person.');

    const list = within(
      (await screen.findByRole('heading', { name: /plants resting on one person/i })).parentElement!
    );
    const names = list
      .getAllByRole('link', { name: /^(Aloe|Monstera)$/ })
      .map((a) => a.textContent);
    expect(names).toEqual(['Aloe', 'Monstera']);
    expect(list.getByText('Only Sam has ever cared for this plant.')).toBeInTheDocument();
    expect(list.getByText('Only you have ever cared for this plant.')).toBeInTheDocument();
  });

  it('shows no per-member totals anywhere on the card', async () => {
    const { container } = renderCard({
      coverage: TWO_MEMBER_REPORT,
      tasks: [task('t-1', 'p-monstera')],
    });
    await screen.findByRole('heading', { name: /plants resting on one person/i });
    // The only digits on the card are the plant counts in the summary line.
    const text = container.textContent ?? '';
    const numbers = text.match(/\d+/g) ?? [];
    expect(numbers).toEqual(['2', '3']);
    expect(text).not.toMatch(/completed/i);
    expect(text).not.toMatch(/top|rank|most|leader/i);
  });

  it('mentions plants nobody has cared for yet without listing them as a risk', async () => {
    renderCard({ coverage: { ...TWO_MEMBER_REPORT, uncaredPlantCount: 4 } });
    await screen.findByText(/4 plants haven.t had any care logged yet/i);
  });

  it('turns a vacation window into "N plants have no one else", with a teach-the-cover list', async () => {
    const user = userEvent.setup();
    renderCard({
      coverage: {
        ...TWO_MEMBER_REPORT,
        awayRisks: [
          {
            userId: 'user-1',
            name: 'Priya',
            startDate: '2026-09-10T00:00:00.000Z',
            endDate: '2026-09-17T23:59:59.000Z',
            coveredBy: 'user-2',
            coveredByName: 'Sam',
            active: false,
            uncoveredPlants: [{ plantId: 'p-monstera', plantName: 'Monstera' }],
            uncoveredPlantCount: 1,
          },
        ],
      },
    });
    await screen.findByText(
      /If Priya is away .*, 1 plant has no one else who has ever cared for it\./
    );
    expect(
      screen.getByText('Sam is covering, but hasn’t cared for these yet.')
    ).toBeInTheDocument();
    await user.click(screen.getByText('Teach Sam these plants'));
    const away = within(
      screen.getByRole('heading', { name: /if someone is away/i }).parentElement!
    );
    expect(away.getByRole('link', { name: 'Monstera' })).toHaveAttribute(
      'href',
      '/plants/p-monstera'
    );
  });

  it('reassures when an away member leaves nothing uncovered', async () => {
    renderCard({
      coverage: {
        ...TWO_MEMBER_REPORT,
        awayRisks: [
          {
            userId: 'user-2',
            name: 'Sam',
            startDate: '2026-09-01T00:00:00.000Z',
            endDate: '2026-09-30T00:00:00.000Z',
            coveredBy: 'user-1',
            coveredByName: 'Priya',
            active: true,
            uncoveredPlants: [],
            uncoveredPlantCount: 0,
          },
        ],
      },
    });
    await screen.findByText(/Sam is away until .*, and every plant they know has someone else/i);
    expect(screen.queryByText(/is covering, but/i)).not.toBeInTheDocument();
  });
});

describe('CoverageCard — calls to action', () => {
  it('"teach someone this plant" opens the plant page', async () => {
    renderCard({ coverage: TWO_MEMBER_REPORT, tasks: [task('t-1', 'p-monstera')] });
    const links = await screen.findAllByRole('link', { name: /teach someone this plant/i });
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/plants/p-aloe',
      '/plants/p-monstera',
    ]);
  });

  it('"assign a backup" hands the plant\'s next task to another member via the existing assignment', async () => {
    const user = userEvent.setup();
    let putBody: unknown = null;
    let putPath = '';
    server.use(
      http.put(`${API}/tasks/:id`, async ({ request, params }) => {
        putPath = String(params.id);
        putBody = await request.json();
        return HttpResponse.json({ ...task('t-late', 'p-monstera'), assignedTo: 'user-2' });
      })
    );
    renderCard({
      coverage: TWO_MEMBER_REPORT,
      tasks: [
        // Two tasks on the Monstera: the soonest-due one is what a backup takes.
        task('t-late', 'p-monstera', 'fertilize', '2026-10-01T08:00:00.000Z'),
        task('t-soon', 'p-monstera', 'water', '2026-09-04T08:00:00.000Z'),
      ],
    });
    // Only the Monstera has tasks; the Aloe cannot be handed over.
    await screen.findByText(/no active tasks to hand over/i);
    await user.click(screen.getByRole('button', { name: /assign a backup/i }));

    // Priya is the sole caregiver, so the only backup on offer is Sam.
    const select = screen.getByLabelText('Backup for Monstera') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['Sam']);
    expect(screen.getByText(/They.ll get the next Water\./)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Assign' }));
    await waitFor(() => expect(putBody).toEqual({ assignedTo: 'user-2' }));
    expect(putPath).toBe('t-soon');
    await waitFor(() =>
      expect(useToastStore.getState().toasts.map((t) => t.message)).toContain(
        'The next Water on Monstera is now Sam’s.'
      )
    );
    expect(screen.queryByLabelText('Backup for Monstera')).not.toBeInTheDocument();
  });

  it('reports a failed hand-over instead of pretending it happened', async () => {
    const user = userEvent.setup();
    server.use(
      http.put(`${API}/tasks/:id`, () =>
        HttpResponse.json(
          { message: 'assignedTo must be a current household member' },
          { status: 400 }
        )
      )
    );
    renderCard({ coverage: TWO_MEMBER_REPORT, tasks: [task('t-1', 'p-monstera')] });
    await user.click(await screen.findByRole('button', { name: /assign a backup/i }));
    await user.click(screen.getByRole('button', { name: 'Assign' }));
    await waitFor(() =>
      expect(useToastStore.getState().toasts.map((t) => t.message)).toContainEqual(
        expect.stringMatching(/couldn.t hand that task over/i)
      )
    );
    // The form stays open so the person can try another backup.
    expect(screen.getByLabelText('Backup for Monstera')).toBeInTheDocument();
  });
});
