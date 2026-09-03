/**
 * The printable handoff brief. What is worth testing here is not the layout
 * but the honesty rules: a plant with no note SAYS it has no note, a plant the
 * curated pet-safety table does not know shows no verdict at all, and a failed
 * read is an error rather than an empty-looking brief.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import i18n from '@/i18n';
import { SitBriefPage } from '@/features/sitter/SitBriefPage';
import {
  sitterService,
  SitterLinkInactiveError,
  type SitterBrief,
  type SitterBriefPlant,
} from '@/services/sitterService';

vi.mock('@/services/sitterService', async () => {
  const actual = await vi.importActual<typeof import('@/services/sitterService')>(
    '@/services/sitterService'
  );
  return { ...actual, sitterService: { getBrief: vi.fn() } };
});

const getBrief = vi.mocked(sitterService.getBrief);
const TOKEN = 'a'.repeat(64);

function plant(over: Partial<SitterBriefPlant> = {}): SitterBriefPlant {
  return {
    plantId: 'p1',
    name: 'Monstera',
    spaceName: 'Living Room',
    placementNote: 'east window, top shelf',
    careNote: 'Bottom-water this one',
    careNoteSource: 'notes',
    photoUrl: 'https://cdn.example/p1.jpg',
    petSafety: {
      slug: 'monstera',
      commonName: 'Monstera',
      scientificName: 'Monstera deliciosa',
      cats: 'toxic',
      dogs: 'toxic',
      note: 'Chewing irritates the mouth and stomach.',
      matchedOn: 'Monstera deliciosa',
    },
    tasks: [
      { taskId: 't1', taskType: 'water', dueDate: '2026-09-05T09:00:00.000Z', overdue: false },
    ],
    ...over,
  };
}

function brief(over: Partial<SitterBrief> = {}): SitterBrief {
  return {
    label: 'The Smiths’ plants',
    startsAt: '2026-09-03T00:00:00.000Z',
    expiresAt: '2026-09-24T00:00:00.000Z',
    plants: [plant()],
    ...over,
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/sit/${TOKEN}/brief`]}>
      <Routes>
        <Route path="/sit/:token/brief" element={<SitBriefPage />} />
        <Route path="/sit/:token" element={<div>task list</div>} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage('en');
});

describe('SitBriefPage', () => {
  it('renders the household’s own words, place, photo, pet warning and due tasks', async () => {
    getBrief.mockResolvedValue(brief());
    renderPage();

    expect(
      await screen.findByRole('heading', { name: /The Smiths’ plants: the plant-care brief/ })
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Monstera', level: 2 })).toBeInTheDocument();
    expect(screen.getByText('Living Room · east window, top shelf')).toBeInTheDocument();
    expect(screen.getByText('Bottom-water this one')).toBeInTheDocument();
    expect(screen.getByText(/Keep away from pets — cats: toxic, dogs: toxic/)).toBeInTheDocument();
    expect(screen.getByText(/grounded in the ASPCA database/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Monstera' })).toHaveAttribute(
      'src',
      'https://cdn.example/p1.jpg'
    );
    expect(screen.getByText(/^Water/)).toBeInTheDocument();
    expect(getBrief).toHaveBeenCalledWith(TOKEN, expect.anything());
  });

  it('says a plant has no note instead of inventing care text', async () => {
    getBrief.mockResolvedValue(
      brief({
        plants: [
          plant({ careNote: null, careNoteSource: null, placementNote: null, spaceName: null }),
        ],
      })
    );
    renderPage();

    expect(await screen.findByText(/No note for this plant/)).toBeInTheDocument();
    expect(screen.getByText(/No placement note/)).toBeInTheDocument();
    // Nothing that reads as household instruction was fabricated.
    expect(screen.queryByText('Bottom-water this one')).not.toBeInTheDocument();
  });

  it('shows no pet verdict at all for a plant the verified table does not know', async () => {
    getBrief.mockResolvedValue(brief({ plants: [plant({ petSafety: null })] }));
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Monstera', level: 2 })).toBeInTheDocument();
    expect(screen.queryByText(/Keep away from pets/)).not.toBeInTheDocument();
    expect(screen.queryByText(/non-toxic/)).not.toBeInTheDocument();
    expect(screen.queryByText(/ASPCA/)).not.toBeInTheDocument();
  });

  it('labels a structured house rule as a house rule, not as a free-text note', async () => {
    getBrief.mockResolvedValue(
      brief({ plants: [plant({ careNote: 'Bottom-water only', careNoteSource: 'rule' })] })
    );
    renderPage();
    expect(await screen.findByText('House rule')).toBeInTheDocument();
    expect(screen.queryByText('The household’s note')).not.toBeInTheDocument();
  });

  it('says when nothing is due for a plant during the window', async () => {
    getBrief.mockResolvedValue(brief({ plants: [plant({ tasks: [] })] }));
    renderPage();
    expect(await screen.findByText('Nothing due during your window.')).toBeInTheDocument();
  });

  it('marks an overdue task as overdue rather than merely due', async () => {
    getBrief.mockResolvedValue(
      brief({
        plants: [
          plant({
            tasks: [
              {
                taskId: 't1',
                taskType: 'water',
                dueDate: '2026-09-01T09:00:00.000Z',
                overdue: true,
              },
            ],
          }),
        ],
      })
    );
    renderPage();
    expect(await screen.findByText(/overdue since/)).toBeInTheDocument();
  });

  it('shows a friendly notice when the link or the plan does not open a brief', async () => {
    getBrief.mockRejectedValue(new SitterLinkInactiveError());
    renderPage();
    expect(await screen.findByText(/This care brief isn’t available/)).toBeInTheDocument();
  });

  it('shows an error — never an empty-looking brief — when the read fails', async () => {
    getBrief.mockRejectedValue(new Error('boom'));
    renderPage();

    expect(await screen.findByText(/couldn’t load the care brief/)).toBeInTheDocument();
    expect(screen.queryByText(/no plants on this brief/i)).not.toBeInTheDocument();
  });

  it('offers a print control and a way back to the day-to-day list', async () => {
    getBrief.mockResolvedValue(brief());
    renderPage();
    expect(await screen.findByRole('button', { name: 'Print' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Back to what needs doing today/ })).toHaveAttribute(
      'href',
      `/sit/${TOKEN}`
    );
  });
});
