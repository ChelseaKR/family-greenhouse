import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { ArchiveImportCard } from '@/features/settings/ArchiveImportCard';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';
const ROUTE = `${API}/households/hh-1/import-archive`;

let isAdmin = true;
vi.mock('@/hooks/useActiveHouseholdId', () => ({ useActiveHouseholdId: () => 'hh-1' }));
vi.mock('@/hooks/useActiveHouseholdRole', () => ({ useIsHouseholdAdmin: () => isAdmin }));

/**
 * Settings → Account → Restore a household from an archive (#669). What this
 * pins: a wrong file is answered before any upload, the upload carries one
 * household and no profile, the preview says what will NOT come back, and a
 * restore that stopped part-way says exactly how far it got.
 */
function exportFile(extra: Record<string, unknown> = {}, name = 'family-greenhouse-export.json') {
  const doc = {
    format: 'family-greenhouse-export',
    version: 1,
    exportedAt: '2026-09-01T00:00:00.000Z',
    user: { id: 'u1', email: 'someone@example.invalid', name: 'Someone' },
    notificationPreferences: {},
    households: [{ id: 'h1', name: 'The Old House', plants: [{ id: 'p1' }], tasks: [] }],
    ...extra,
  };
  return new File([JSON.stringify(doc)], name, { type: 'application/json' });
}

const PREVIEW = {
  digest: 'a'.repeat(64),
  source: {
    householdId: 'h1',
    name: 'The Old House',
    exportedAt: '2026-09-01T00:00:00.000Z',
    version: 2,
    manifest: 'verified',
  },
  counts: {
    plants: 5,
    activePlants: 2,
    pastPlants: 2,
    archivedPlants: 1,
    tasks: 3,
    lineageLinks: 1,
  },
  notRestored: {
    photos: 1,
    spaceAssignments: 1,
    unassignedTasks: 2,
    reinvite: [{ name: 'Mel Member', tasks: 2 }],
    orphanTasks: 0,
    brokenLineage: 0,
    unverifiedSpeciesNames: 0,
  },
  planLimit: { planName: 'Seedling', limit: 20, currentActivePlants: 0, fits: true },
  target: { state: 'empty' },
  canImport: true,
};

function renderCard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ArchiveImportCard />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

async function chooseFile(file: File) {
  await userEvent.upload(screen.getByLabelText('Choose an export file'), file);
}

describe('ArchiveImportCard', () => {
  let requests: Array<Record<string, unknown>>;
  beforeEach(() => {
    isAdmin = true;
    requests = [];
  });

  function answer(respond: (body: Record<string, unknown>) => Response) {
    server.use(
      http.post(ROUTE, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        requests.push(body);
        return respond(body);
      })
    );
  }

  it('tells a member that only an admin can restore, with no way to start one', () => {
    isAdmin = false;
    renderCard();
    expect(screen.getByText('Only a household admin can restore an export.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /choose an export file/i })).toBeNull();
  });

  it('names a newer export version and uploads nothing', async () => {
    answer(() => HttpResponse.json(PREVIEW));
    renderCard();
    await chooseFile(exportFile({ version: 3 }));
    expect(await screen.findByText(/format 3/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check this export' })).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it('previews what comes back and what does not, then restores with the previewed digest', async () => {
    answer((body) =>
      body.mode === 'preview'
        ? HttpResponse.json(PREVIEW)
        : HttpResponse.json({
            status: 'complete',
            imported: { plants: 5, tasks: 3 },
            counts: PREVIEW.counts,
            notRestored: PREVIEW.notRestored,
          })
    );
    renderCard();
    await chooseFile(exportFile());
    await userEvent.click(await screen.findByRole('button', { name: 'Check this export' }));

    const preview = await screen.findByRole('region', { name: 'What this restores' });
    expect(
      within(preview).getByText(
        'Plants: 5 (active 2, past 2, archived 1), with notes, house rules and tags'
      )
    ).toBeInTheDocument();
    expect(
      within(preview).getByText('Photos: 1 (the export only links to them)')
    ).toBeInTheDocument();
    expect(within(preview).getByText('Mel Member — tasks: 2')).toBeInTheDocument();
    expect(
      within(preview).getByText('Billing: no plan, subscription or trial carries over')
    ).toBeInTheDocument();
    expect(
      within(preview).getByText(
        'Sitter, wall display, tag, share, calendar and API links (issue new ones)'
      )
    ).toBeInTheDocument();
    expect(within(preview).getByText('Members (invite them again)')).toBeInTheDocument();

    // The upload carried one household and none of the person's profile.
    expect(requests[0]).toMatchObject({ mode: 'preview', sourceHouseholdId: 'h1' });
    const archive = requests[0].archive as Record<string, unknown>;
    expect(archive.user).toBeUndefined();
    expect(archive.notificationPreferences).toBeUndefined();
    expect(archive.households).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'Restore into this household' }));
    expect(
      await screen.findByText('Restored “The Old House”. Plants: 5, tasks: 3.')
    ).toBeInTheDocument();
    expect(requests[1]).toMatchObject({ mode: 'commit', confirmDigest: PREVIEW.digest });
  });

  it('says whether the export was checked against its own contents list', async () => {
    answer(() => HttpResponse.json(PREVIEW));
    renderCard();
    await chooseFile(exportFile({ version: 2 }));
    await userEvent.click(await screen.findByRole('button', { name: 'Check this export' }));
    const checked = await screen.findByRole('region', { name: 'What this restores' });
    expect(
      within(checked).getByText(
        'Checked against the export’s own contents list: nothing is missing or changed.'
      )
    ).toBeInTheDocument();
  });

  it('says so when an older export has no contents list to check, and still restores it', async () => {
    answer(() =>
      HttpResponse.json({
        ...PREVIEW,
        source: { ...PREVIEW.source, version: 1, manifest: 'absent' },
      })
    );
    renderCard();
    // A file the released app wrote: version 1.
    await chooseFile(exportFile({ version: 1 }));
    await userEvent.click(await screen.findByRole('button', { name: 'Check this export' }));
    const older = await screen.findByRole('region', { name: 'What this restores' });
    expect(
      within(older).getByText(
        'This export is from before contents lists, so we can’t check that nothing is missing.'
      )
    ).toBeInTheDocument();
    expect(within(older).queryByText(/Checked against the export’s own contents list/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Restore into this household' })).toBeInTheDocument();
    // The version 1 file was sent as version 1, untouched.
    expect((requests[0].archive as Record<string, unknown>).version).toBe(1);
  });

  it('answers a file that does not match its contents list, and nothing was restored', async () => {
    server.use(
      http.post(ROUTE, () =>
        HttpResponse.json(
          {
            message: 'This export does not match its own manifest.',
            details: {
              code: 'manifest_mismatch',
              plants: { manifest: 5, file: 4, missing: 1, unexpected: 0 },
              tasks: { manifest: 3, file: 3, missing: 0, unexpected: 0 },
            },
          },
          { status: 400 }
        )
      )
    );
    renderCard();
    await chooseFile(exportFile({ version: 2 }));
    await userEvent.click(await screen.findByRole('button', { name: 'Check this export' }));
    expect(
      await screen.findByText(/doesn’t match its own contents list.*Nothing was restored/)
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore into this household' })).toBeNull();
  });

  it('points a non-empty household at creating a new one, with no restore button', async () => {
    answer(() =>
      HttpResponse.json({ ...PREVIEW, target: { state: 'not_empty' }, canImport: false })
    );
    renderCard();
    await chooseFile(exportFile());
    await userEvent.click(await screen.findByRole('button', { name: 'Check this export' }));
    const link = await screen.findByRole('link', { name: 'Create a new household' });
    expect(link).toHaveAttribute('href', '/onboarding?mode=add');
    expect(screen.queryByRole('button', { name: 'Restore into this household' })).toBeNull();
  });

  it('says a plan-cap refusal plainly, before anything is written', async () => {
    answer(() =>
      HttpResponse.json({
        ...PREVIEW,
        counts: { ...PREVIEW.counts, activePlants: 23 },
        planLimit: { planName: 'Seedling', limit: 20, currentActivePlants: 0, fits: false },
        canImport: false,
      })
    );
    renderCard();
    await chooseFile(exportFile());
    await userEvent.click(await screen.findByRole('button', { name: 'Check this export' }));
    expect(
      await screen.findByText(
        'This export has 23 active plants and the Seedling plan allows 20. Nothing will be restored until you upgrade.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore into this household' })).toBeNull();
  });

  it('reports exactly how far an interrupted restore got, and offers to finish it', async () => {
    answer((body) =>
      body.mode === 'preview'
        ? HttpResponse.json(PREVIEW)
        : HttpResponse.json(
            {
              message: 'The restore stopped part-way',
              details: {
                code: 'interrupted',
                landed: { plants: 49, tasks: 0 },
                expected: { plants: 120, tasks: 120 },
              },
            },
            { status: 503 }
          )
    );
    renderCard();
    await chooseFile(exportFile());
    await userEvent.click(await screen.findByRole('button', { name: 'Check this export' }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Restore into this household' })
    );
    expect(
      await screen.findByText(
        'Stopped part-way. Plants: 49/120, tasks: 0/120. Restore again to finish; nothing is added twice.'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore again to finish' })).toBeInTheDocument();
  });

  it('asks which household to restore when the export holds several', async () => {
    answer(() => HttpResponse.json(PREVIEW));
    renderCard();
    await chooseFile(
      exportFile({
        households: [
          { id: 'h1', name: 'The Old House', plants: [], tasks: [] },
          { id: 'h2', name: 'Cabin', plants: [{ id: 'p' }], tasks: [] },
        ],
      })
    );
    await userEvent.selectOptions(
      await screen.findByLabelText('Household to restore'),
      'Cabin — plants: 1, tasks: 0'
    );
    await userEvent.click(screen.getByRole('button', { name: 'Check this export' }));
    await screen.findByRole('region', { name: 'What this restores' });
    expect(requests[0]).toMatchObject({ sourceHouseholdId: 'h2' });
    const archive = requests[0].archive as { households: Array<{ id: string }> };
    expect(archive.households.map((h) => h.id)).toEqual(['h2']);
  });
});
