import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ImportPlantsPage } from '@/features/plants/ImportPlantsPage';
import { plantService, type ImportPlantsResponse } from '@/services/plantService';
import { billingService, type SubscriptionState } from '@/services/billingService';

vi.mock('@/services/plantService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/plantService')>();
  return {
    ...actual,
    plantService: {
      ...actual.plantService,
      importPlants: vi.fn(),
    },
  };
});

vi.mock('@/services/billingService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/billingService')>();
  return {
    ...actual, // keep readOutcome / resolvePlanUsage (the real read logic)
    billingService: { ...actual.billingService, getCurrentSubscription: vi.fn() },
  };
});

// The page must not gate on role: every member may import (#668 owner
// decision). Mocked so a member-role test can prove the page ignores it.
const isAdmin = vi.fn(() => true);
vi.mock('@/hooks/useActiveHouseholdRole', () => ({
  useIsHouseholdAdmin: () => isAdmin(),
  useActiveHouseholdRole: () => (isAdmin() ? 'admin' : 'member'),
}));

vi.mock('@/hooks/useActiveHouseholdId', () => ({
  useActiveHouseholdId: () => 'hh-1',
}));

function subscription(plantCount: number | null, maxPlants: number | null): SubscriptionState {
  return {
    planId: 'seedling',
    usageDetail: { plantCount, maxPlants, memberCount: 1, maxMembers: 2 },
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ImportPlantsPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

async function upload(contents: string, name = 'plants.csv', type = 'text/csv') {
  const user = userEvent.setup();
  renderPage();
  const file = new File([contents], name, { type });
  await user.upload(screen.getByLabelText('Choose a file'), file);
  return user;
}

/** The confirm button, once the plan read has settled and enabled it. */
async function readySubmit(name: RegExp = /^Import \d+ plants?$/) {
  const submit = await screen.findByRole('button', { name });
  await waitFor(() => expect(submit).toBeEnabled());
  return submit;
}

async function uploadCsvAndSubmit(csv: string, response: ImportPlantsResponse) {
  vi.mocked(plantService.importPlants).mockResolvedValue(response);
  const user = await upload(csv);
  await user.click(await readySubmit());
  await waitFor(() => expect(plantService.importPlants).toHaveBeenCalledOnce());
}

describe('ImportPlantsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isAdmin.mockReturnValue(true);
    vi.mocked(billingService.getCurrentSubscription).mockResolvedValue(subscription(0, null));
  });

  it('shows the specific reason and row name for each server-skipped row', async () => {
    await uploadCsvAndSubmit('name\nFiddle Leaf Fig\nSnake Plant\n', {
      results: [
        { index: 0, status: 'created', plantId: 'plant-1' },
        {
          index: 1,
          status: 'skipped',
          error: 'A plant with this name already exists in this household.',
        },
      ],
      created: 1,
      skipped: 1,
      planLimitHit: false,
    });

    expect(await screen.findByText('1 plant created · 1 row skipped')).toBeInTheDocument();
    expect(screen.getByText('Row 2 — Snake Plant')).toBeInTheDocument();
    expect(
      screen.getByText('A plant with this name already exists in this household.')
    ).toBeInTheDocument();
    // The row that succeeded should not show up in the skipped list.
    expect(screen.queryByText(/Row 1 — Fiddle Leaf Fig/)).not.toBeInTheDocument();
  });

  it('renders no skipped-rows list when every row is created', async () => {
    await uploadCsvAndSubmit('name\nFiddle Leaf Fig\n', {
      results: [{ index: 0, status: 'created', plantId: 'plant-1' }],
      created: 1,
      skipped: 0,
      planLimitHit: false,
    });

    expect(await screen.findByText('1 plant created')).toBeInTheDocument();
    expect(screen.queryByText('Skipped rows')).not.toBeInTheDocument();
  });

  it('says plainly that Planta, Greg and Vera have no export to import from', () => {
    renderPage();
    const note = screen.getByTestId('other-apps-note');
    expect(note).toHaveTextContent('Coming from Planta, Greg or Vera?');
    expect(note).toHaveTextContent(
      "Their help pages don't describe any way to export your plants to a file"
    );
  });

  it('lets a household member who is not an admin import (#668 owner decision)', async () => {
    isAdmin.mockReturnValue(false);
    await uploadCsvAndSubmit('name\nFiddle Leaf Fig\n', {
      results: [{ index: 0, status: 'created', plantId: 'plant-1' }],
      created: 1,
      skipped: 0,
      planLimitHit: false,
    });
    expect(plantService.importPlants).toHaveBeenCalledWith([{ name: 'Fiddle Leaf Fig' }]);
    expect(await screen.findByText('1 plant created')).toBeInTheDocument();
  });

  it('asks which column is which for a spreadsheet that is not our export, then imports that', async () => {
    vi.mocked(plantService.importPlants).mockResolvedValue({
      results: [{ index: 0, status: 'created', plantId: 'p1' }],
      created: 1,
      skipped: 0,
      planLimitHit: false,
    });
    // SYNTHETIC FIXTURE — a hand-made spreadsheet, not any app's export.
    const user = await upload(
      'Plant,Botanical name,Water every (days),Remarks,Purchased\n' +
        'Monty,Monstera deliciosa,7,Wipe leaves monthly,2024-03-01\n'
    );

    // Nothing is guessed: the matching step opens and cannot continue
    // until the person says which column holds the name.
    expect(await screen.findByText('Match your columns')).toBeInTheDocument();
    const next = screen.getByRole('button', { name: 'Preview import' });
    expect(next).toBeDisabled();

    await user.selectOptions(screen.getByLabelText('Plant name (required)'), 'Plant');
    await user.selectOptions(screen.getByLabelText('Species'), 'Botanical name');
    await user.selectOptions(screen.getByLabelText('Days between waterings'), 'Water every (days)');
    await user.selectOptions(screen.getByLabelText('Notes'), 'Remarks');
    expect(screen.getByText('First value: Monstera deliciosa')).toBeInTheDocument();
    await user.click(next);

    // The unmatched column is listed, not dropped unseen.
    const notImported = await screen.findByTestId('not-imported');
    expect(notImported).toHaveTextContent("This column has data that won't be imported:");
    expect(notImported).toHaveTextContent('Purchased');

    await user.click(await readySubmit(/^Import 1 plant$/));
    await waitFor(() => expect(plantService.importPlants).toHaveBeenCalledOnce());
    expect(plantService.importPlants).toHaveBeenCalledWith([
      {
        name: 'Monty',
        species: 'Monstera deliciosa',
        notes: 'Wipe leaves monthly',
        tasks: [{ type: 'water', frequency: 7 }],
      },
    ]);
  });

  it('previews the exact number the plan admits and never sends the rows over it', async () => {
    vi.mocked(billingService.getCurrentSubscription).mockResolvedValue(subscription(18, 20));
    vi.mocked(plantService.importPlants).mockResolvedValue({
      results: [
        { index: 0, status: 'created', plantId: 'p1' },
        { index: 1, status: 'created', plantId: 'p2' },
      ],
      created: 2,
      skipped: 0,
      planLimitHit: false,
    });
    const user = await upload('name\nOne\nTwo\nThree\nFour\n');

    expect(await screen.findByText('2 of 4 ready plants fit your plan')).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getAllByText('Over plan limit')).toHaveLength(2);
    expect(within(table).getAllByText('Ready')).toHaveLength(2);

    await user.click(await readySubmit(/^Import 2 plants$/));
    await waitFor(() => expect(plantService.importPlants).toHaveBeenCalledOnce());
    expect(plantService.importPlants).toHaveBeenCalledWith([{ name: 'One' }, { name: 'Two' }]);
    expect(
      await screen.findByText("2 ready rows were over your plan's limit and were not sent.")
    ).toBeInTheDocument();
  });

  it('imports nothing at a full plan and says why', async () => {
    vi.mocked(billingService.getCurrentSubscription).mockResolvedValue(subscription(20, 20));
    await upload('name\nOne\nTwo\n');

    expect(await screen.findByText("Your plan's plant limit is reached")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import 0 plants' })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'See your plan' })).toHaveAttribute(
      'href',
      '/settings/billing'
    );
  });

  it('says it could not check the plan instead of implying everything fits', async () => {
    vi.mocked(billingService.getCurrentSubscription).mockRejectedValue(new Error('network'));
    await upload('name\nOne\n');

    expect(
      await screen.findByText(/We couldn't check how much room your plan has left/)
    ).toBeInTheDocument();
    // The server still enforces the cap, so importing stays possible.
    expect(await readySubmit(/^Import 1 plant$/)).toBeEnabled();
  });

  it('lists JSON fields that will not be imported and never sends the house rule', async () => {
    vi.mocked(plantService.importPlants).mockResolvedValue({
      results: [{ index: 0, status: 'created', plantId: 'p1' }],
      created: 1,
      skipped: 0,
      planLimitHit: false,
    });
    const user = await upload(
      JSON.stringify([{ name: 'Pothos', notes: 'private', careRule: 'Bottom-water only' }]),
      'plants.json',
      'application/json'
    );

    const notImported = await screen.findByTestId('not-imported');
    expect(notImported).toHaveTextContent('careRule');
    await user.click(await readySubmit(/^Import 1 plant$/));
    await waitFor(() => expect(plantService.importPlants).toHaveBeenCalledOnce());
    expect(plantService.importPlants).toHaveBeenCalledWith([{ name: 'Pothos', notes: 'private' }]);
  });
});
