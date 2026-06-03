import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SpeciesCombobox } from '@/components/SpeciesCombobox';
import type { SpeciesEntry } from '@/utils/species';

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
}: {
  initial?: string;
  onPick?: (entry: SpeciesEntry) => void;
}) {
  const [value, setValue] = useState(initial);
  return <SpeciesCombobox value={value} onChange={setValue} onPick={onPick} />;
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
});
