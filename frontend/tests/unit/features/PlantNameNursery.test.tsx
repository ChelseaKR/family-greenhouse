import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlantNameNursery } from '@/features/plants/PlantNameNursery';
import { generatePlantNameSuggestion } from '@/utils/plantNameGenerator';

/**
 * The nursery draws names through the generator's default `Math.random`. Left
 * unpinned, whether a reroll happens to redraw the previous name — and so
 * whether the component's retry loop runs at all — changes from run to run,
 * which makes this file's coverage (and therefore the repo's frontend coverage
 * total) non-reproducible. Every test pins the draw.
 */
function pinRandom(sequence: readonly number[]) {
  let call = 0;
  vi.spyOn(Math, 'random').mockImplementation(() => {
    const value = sequence[call % sequence.length];
    call += 1;
    return value;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PlantNameNursery', () => {
  it('lets someone choose a vibe, reroll, and use a suggestion', async () => {
    pinRandom([0, 0.5, 0.9]);
    const user = userEvent.setup();
    const onUseName = vi.fn();
    render(<PlantNameNursery species="Boston fern" onUseName={onUseName} />);

    await user.click(screen.getByRole('button', { name: 'Name this plant for me' }));
    expect(screen.getByRole('region', { name: 'Plant name nursery' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Punny/ }));
    expect(screen.getByText('Inspired by ferns')).toBeInTheDocument();
    const firstSuggestion = screen.getByText('Ready for adoption').nextElementSibling?.textContent;
    expect(firstSuggestion).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Another one' }));
    await user.click(screen.getByRole('button', { name: 'Use this name' }));

    expect(onUseName).toHaveBeenCalledTimes(1);
    expect(onUseName).toHaveBeenCalledWith(expect.any(String));
    expect(screen.queryByRole('region', { name: 'Plant name nursery' })).not.toBeInTheDocument();
  });

  it('still offers a usable name when every reroll redraws the same one', async () => {
    // A single-valued draw makes the generator return the same card forever, so
    // the reroll's "try again for something different" loop runs out its
    // attempts. It has to give up and keep the card, not spin or blank out.
    pinRandom([0]);
    const expectedName = generatePlantNameSuggestion('punny', 'Boston fern', () => 0).name;
    const user = userEvent.setup();
    const onUseName = vi.fn();
    render(<PlantNameNursery species="Boston fern" onUseName={onUseName} />);

    await user.click(screen.getByRole('button', { name: 'Name this plant for me' }));
    await user.click(screen.getByRole('button', { name: /Punny/ }));
    await user.click(screen.getByRole('button', { name: 'Another one' }));

    expect(screen.getByText(expectedName)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Use this name' }));

    expect(onUseName).toHaveBeenCalledWith(expectedName);
  });

  it('can be closed without overwriting the form name', async () => {
    pinRandom([0]);
    const user = userEvent.setup();
    const onUseName = vi.fn();
    render(<PlantNameNursery species="" onUseName={onUseName} />);

    await user.click(screen.getByRole('button', { name: 'Name this plant for me' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(onUseName).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Name this plant for me' })).toBeInTheDocument();
  });
});
