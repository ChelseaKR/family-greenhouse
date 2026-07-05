import { useState } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SpeciesCombobox } from '@/components/SpeciesCombobox';
import { speciesService } from '@/services/speciesService';
import type { SpeciesEntry } from '@/utils/species';

// Most tests here exercise the static-catalog path only and don't care what
// this resolves to — the two debounce/staleness tests below set their own
// per-test implementation.
vi.mock('@/services/speciesService', () => ({
  speciesService: {
    search: vi.fn().mockResolvedValue({ source: 'perenual', results: [] }),
  },
}));

// SpeciesCombobox calls useQuery for Perenual suggestions. The unit tests
// don't care about the network result — they exercise the static-catalog
// path — so we wrap each render in a fresh QueryClient with retries off.
function withQuery(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

function ControlledCombobox({
  initial = '',
  onPick,
  onPerenualPick,
}: {
  initial?: string;
  onPick?: (entry: SpeciesEntry) => void;
  onPerenualPick?: (id: number | null) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <SpeciesCombobox
      value={value}
      onChange={setValue}
      onPick={onPick}
      onPerenualPick={onPerenualPick}
    />
  );
}

describe('SpeciesCombobox', () => {
  it('renders without crashing on initial mount with empty value', () => {
    // Regression: previously crashed when AddPlantPage opened because of
    // a HeadlessUI Combobox API mismatch. The native datalist version has
    // no library risk and simply renders an <input> + <datalist>.
    render(withQuery(<SpeciesCombobox value="" onChange={() => {}} />));
    expect(screen.getByLabelText(/species/i)).toBeInTheDocument();
  });

  it('shows the full catalog as datalist options when value is empty', () => {
    const { container } = render(withQuery(<SpeciesCombobox value="" onChange={() => {}} />));
    const options = container.querySelectorAll('datalist option');
    expect(options.length).toBeGreaterThan(50);
  });

  it('narrows datalist options as the user types', () => {
    const { container } = render(
      withQuery(<SpeciesCombobox value="monstera" onChange={() => {}} />)
    );
    const options = Array.from(container.querySelectorAll('datalist option'));
    expect(options.length).toBeLessThan(20);
    expect(
      options.some((o) => (o as HTMLOptionElement).value.toLowerCase().includes('monstera'))
    ).toBe(true);
  });

  it('fires onPick when the user types an exact catalog value', async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    render(withQuery(<ControlledCombobox onPick={onPick} />));
    const input = screen.getByLabelText(/species/i);
    await user.type(input, 'Monstera deliciosa');
    expect((input as HTMLInputElement).value).toBe('Monstera deliciosa');
    expect(onPick).toHaveBeenCalled();
    expect(onPick.mock.calls.at(-1)?.[0].scientific).toBe('Monstera deliciosa');
  });

  it('renders the error message when provided', () => {
    render(withQuery(<SpeciesCombobox value="" onChange={() => {}} error="Required" />));
    expect(screen.getByText('Required')).toBeInTheDocument();
  });

  describe('Perenual match re-checking (debounce lag)', () => {
    beforeEach(() => {
      vi.mocked(speciesService.search).mockReset();
    });

    it('re-checks for a match once debounced results land, even though every keystroke saw stale data', async () => {
      // Resolves immediately once called — the point under test is that
      // nothing re-checks against it until the 300ms debounce elapses, not
      // that the network itself is slow.
      vi.mocked(speciesService.search).mockResolvedValue({
        source: 'perenual',
        results: [
          {
            id: 99,
            commonName: 'Monstera',
            scientificName: 'Monstera deliciosa',
            thumbnailUrl: null,
          },
        ],
      });
      const onPerenualPick = vi.fn();
      render(withQuery(<ControlledCombobox onPerenualPick={onPerenualPick} />));
      const input = screen.getByLabelText(/species/i);

      // Simulate one continuous burst of typing with no pauses: a single
      // change event straight to the final value, exactly like every
      // keystroke's onChange would see while the 300ms debounce is still
      // behind. `perenual` is still undefined at this point.
      fireEvent.change(input, { target: { value: 'Monstera deliciosa' } });
      expect(onPerenualPick).toHaveBeenLastCalledWith(null);

      // Let the debounce elapse and the mocked search resolve.
      await waitFor(() => expect(onPerenualPick).toHaveBeenLastCalledWith(99), { timeout: 2000 });
    });

    it('does not mix a stale query’s remote results into a fresh query’s merged list', async () => {
      vi.mocked(speciesService.search).mockImplementation((query: string) => {
        if (query.trim().toLowerCase() === 'aloe') {
          return Promise.resolve({
            source: 'perenual',
            results: [
              {
                id: 1,
                commonName: 'Aloe vera',
                scientificName: 'Aloe barbadensis',
                thumbnailUrl: null,
              },
            ],
          });
        }
        // Never resolves within this test's window — stands in for a
        // request that's still in flight.
        return new Promise(() => {});
      });

      const { container } = render(withQuery(<ControlledCombobox />));
      const input = screen.getByLabelText(/species/i);

      fireEvent.change(input, { target: { value: 'aloe' } });
      await waitFor(
        () => {
          const values = Array.from(container.querySelectorAll('datalist option')).map(
            (o) => (o as HTMLOptionElement).value
          );
          expect(values).toContain('Aloe barbadensis');
        },
        { timeout: 2000 }
      );

      // Clear and type a new query with no pause — the debounced query for
      // "philodendron" hasn't started (let alone resolved) yet.
      fireEvent.change(input, { target: { value: '' } });
      fireEvent.change(input, { target: { value: 'philodendron' } });
      const values = Array.from(container.querySelectorAll('datalist option')).map(
        (o) => (o as HTMLOptionElement).value
      );
      expect(values).not.toContain('Aloe barbadensis');
      expect(values.some((v) => v.toLowerCase().includes('philodendron'))).toBe(true);
    });
  });
});
