import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PetSafePage } from '@/features/petsafe/PetSafePage';
import { petToxicityService, type ToxicityMatch } from '@/services/petToxicityService';

vi.mock('@/services/petToxicityService', () => ({
  petToxicityService: { lookup: vi.fn() },
}));

const lookup = vi.mocked(petToxicityService.lookup);

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/pet-safe']}>
      <Routes>
        <Route path="/pet-safe" element={<PetSafePage />} />
      </Routes>
    </MemoryRouter>
  );
}

const snakePlant: ToxicityMatch = {
  slug: 'snake-plant',
  commonName: 'Snake plant',
  scientificName: 'Dracaena trifasciata',
  cats: 'toxic',
  dogs: 'toxic',
  note: 'Contains saponins; mildly toxic if eaten.',
};

const spiderPlant: ToxicityMatch = {
  slug: 'spider-plant',
  commonName: 'Spider plant',
  scientificName: 'Chlorophytum comosum',
  cats: 'non-toxic',
  dogs: 'non-toxic',
  note: 'Non-toxic to cats and dogs per the ASPCA.',
};

describe('PetSafePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders an accessible search input and a single h1', () => {
    renderPage();
    expect(
      screen.getByRole('heading', { level: 1, name: /is this plant safe for pets/i })
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/plant or species name/i)).toBeInTheDocument();
  });

  it('shows a toxic verdict for cats and dogs after searching', async () => {
    lookup.mockResolvedValue([snakePlant]);
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText(/plant or species name/i), 'snake plant');

    expect(await screen.findByText(/can be harmful to pets/i)).toBeInTheDocument();
    expect(screen.getByText(/Dracaena trifasciata/)).toBeInTheDocument();
    // Verdict lines for both species are present.
    expect(screen.getByText(/Cats:/)).toBeInTheDocument();
    expect(screen.getByText(/Dogs:/)).toBeInTheDocument();
    await waitFor(() => expect(lookup).toHaveBeenCalledWith('snake plant', expect.anything()));
  });

  it('shows a pet-safe verdict for a non-toxic plant', async () => {
    lookup.mockResolvedValue([spiderPlant]);
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText(/plant or species name/i), 'spider plant');

    expect(await screen.findByText(/is pet-safe/i)).toBeInTheDocument();
  });

  it('tells the user when nothing matches', async () => {
    lookup.mockResolvedValue([]);
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText(/plant or species name/i), 'notaplant');

    expect(await screen.findByText(/no match yet/i)).toBeInTheDocument();
  });

  it('does not query for inputs shorter than two characters', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText(/plant or species name/i), 'a');
    // Give the debounce time to (not) fire.
    await new Promise((r) => setTimeout(r, 400));
    expect(lookup).not.toHaveBeenCalled();
  });

  it('keeps the public checker and links to free registration', () => {
    renderPage();
    expect(screen.getByLabelText(/plant or species name/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /get started/i })).toHaveAttribute('href', '/register');
  });
});
