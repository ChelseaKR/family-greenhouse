import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { PetSafePage } from '@/features/petsafe/PetSafePage';
import { petToxicityService, type ToxicityMatch } from '@/services/petToxicityService';
import { CARE_GUIDES } from '@/features/care/careGuides';
import { PET_SAFE_SPECIES } from '@/features/petsafe/petSafeSpecies';

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
    const { container } = renderPage();

    await user.type(screen.getByLabelText(/plant or species name/i), 'snake plant');

    // Scoped to the live results region: the static species list further down
    // the page names Dracaena trifasciata too, so an unscoped query now finds
    // two nodes. The assertion is about the result card either way.
    const results = within(container.querySelector('[aria-live="polite"]')!);
    expect(await results.findByText(/can be harmful to pets/i)).toBeInTheDocument();
    expect(results.getByText(/Dracaena trifasciata/)).toBeInTheDocument();
    // Verdict lines for both species are present.
    expect(results.getByText(/Cats:/)).toBeInTheDocument();
    expect(results.getByText(/Dogs:/)).toBeInTheDocument();
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

  // The page deliberately wraps its results in one polite live region so a
  // search-as-you-type surface reads its own results calmly (#446). Every child
  // of that region used to be an assertive `Alert`, so each keystroke's result
  // set interrupted the previous announcement mid-word — the polite wrapper was
  // defeated by its own children. Nothing in axe can see this: assertive
  // nested inside polite is valid ARIA.
  it('never nests an assertive region inside its own polite results region', async () => {
    lookup.mockResolvedValue([spiderPlant]);
    const user = userEvent.setup();
    const { container } = renderPage();

    await user.type(screen.getByLabelText(/plant or species name/i), 'spider plant');
    expect(await screen.findByText(/is pet-safe/i)).toBeInTheDocument();

    const polite = container.querySelector('[aria-live="polite"]');
    expect(polite).not.toBeNull();
    expect(polite!.querySelector('[role="alert"], [aria-live="assertive"], [role="status"]')).toBe(
      null
    );
  });

  it('still announces an error, once, through the same polite region', async () => {
    lookup.mockRejectedValue(new Error('network down'));
    const user = userEvent.setup();
    const { container } = renderPage();

    await user.type(screen.getByLabelText(/plant or species name/i), 'spider plant');
    expect(await screen.findByText(/something went wrong/i)).toBeInTheDocument();

    const polite = container.querySelector('[aria-live="polite"]');
    expect(polite).not.toBeNull();
    expect(polite!.textContent).toMatch(/something went wrong/i);
    expect(polite!.querySelector('[role="alert"], [aria-live="assertive"]')).toBe(null);
  });
});

/**
 * The static half of the page. The checker answers from a runtime fetch, so
 * everything it produces is absent from the HTML `scripts/prerender.mjs`
 * writes — the prerendered page was an empty search form with no outbound
 * internal links. These cases pin the fix: real content, real links, real
 * structured data, none of it waiting on the network.
 */
describe('PetSafePage static species list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('links every care guide without a toxicity lookup', () => {
    const { container } = renderPage();

    const hrefs = [...container.querySelectorAll('a[href^="/care/"]')].map((a) =>
      a.getAttribute('href')
    );
    expect(hrefs).toHaveLength(CARE_GUIDES.length);
    // 24 guides today. Asserted as a floor so adding the 25th doesn't fail
    // this, while dropping the list back to a handful of links would.
    expect(hrefs.length).toBeGreaterThanOrEqual(24);
    for (const guide of CARE_GUIDES) {
      expect(hrefs, `no link to ${guide.slug}`).toContain(`/care/${guide.slug}`);
    }
    // The whole point: this is in the first render, before any network work.
    expect(lookup).not.toHaveBeenCalled();
  });

  it('prints each guide’s own toxicity line rather than a paraphrase', () => {
    const { container } = renderPage();

    for (const guide of CARE_GUIDES) {
      expect(container.textContent, `${guide.slug} verdict missing`).toContain(
        guide.quickFacts.toxicity
      );
    }
  });

  it('links both pet-safety blog posts with their real titles as anchor text', () => {
    renderPage();

    expect(
      screen.getByRole('link', { name: /pet-safe houseplants that are genuinely hard to kill/i })
    ).toHaveAttribute('href', '/blog/pet-safe-houseplants-that-are-hard-to-kill');
    expect(
      screen.getByRole('link', { name: /most common toxic houseplants \(and safer swaps\)/i })
    ).toHaveAttribute('href', '/blog/most-common-toxic-houseplants-and-safer-swaps');
  });

  it('links the care-guide index from the page body, not just the shell', () => {
    renderPage();
    expect(screen.getByRole('link', { name: /browse all plant care guides/i })).toHaveAttribute(
      'href',
      '/care'
    );
  });

  it('publishes an ItemList of every species and a breadcrumb trail', () => {
    const { container } = renderPage();

    const script = container.ownerDocument.querySelector(
      'script[type="application/ld+json"][data-use-meta-tags]'
    );
    expect(script).not.toBeNull();
    const graph = JSON.parse(script!.textContent!)['@graph'] as Record<string, unknown>[];

    const collection = graph.find((node) => node['@type'] === 'CollectionPage')!;
    expect(collection).toBeDefined();
    expect(collection['@id']).toBe('https://familygreenhouse.net/pet-safe');

    const list = graph.find((node) => node['@type'] === 'ItemList') as {
      numberOfItems: number;
      itemListElement: { position: number; name: string; description: string; url: string }[];
    };
    expect(list).toBeDefined();
    expect(list.numberOfItems).toBe(CARE_GUIDES.length);
    expect(list.itemListElement).toHaveLength(CARE_GUIDES.length);
    // Absolute URLs, in DOM order, carrying the guide's own verdict text.
    list.itemListElement.forEach((item, index) => {
      const species = PET_SAFE_SPECIES[index]!;
      expect(item.position).toBe(index + 1);
      expect(item.name).toBe(species.commonName);
      expect(item.description).toBe(species.verdict);
      expect(item.url).toBe(`https://familygreenhouse.net/care/${species.slug}`);
    });

    const crumbs = graph.find((node) => node['@type'] === 'BreadcrumbList') as {
      itemListElement: { position: number; name: string; item?: string }[];
    };
    expect(crumbs).toBeDefined();
    expect(crumbs.itemListElement).toEqual([
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://familygreenhouse.net/' },
      { '@type': 'ListItem', position: 2, name: 'Pet-safe' },
    ]);
  });
});
