import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ImportPlantsPage } from '@/features/plants/ImportPlantsPage';
import { plantService, type ImportPlantsResponse } from '@/services/plantService';

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

async function uploadCsvAndSubmit(csv: string, response: ImportPlantsResponse) {
  const user = userEvent.setup();
  renderPage();
  vi.mocked(plantService.importPlants).mockResolvedValue(response);

  const file = new File([csv], 'plants.csv', { type: 'text/csv' });
  const input = screen.getByLabelText('Choose a file');
  await user.upload(input, file);

  const submit = await screen.findByRole('button', { name: /^Import \d+ plants?$/ });
  await user.click(submit);
  await waitFor(() => expect(plantService.importPlants).toHaveBeenCalledOnce());
}

describe('ImportPlantsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
