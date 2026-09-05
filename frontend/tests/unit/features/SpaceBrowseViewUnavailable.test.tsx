/**
 * #456: with an empty `spaces`, `buildSpaceOverviewGroups` files EVERY plant
 * under `'unplaced'`. When the rooms read merely FAILED, that renders a
 * household's whole collection as one card headed "Unplaced" — a confident
 * answer to a question nobody could look up, on a page whose entire job is to
 * show where things live.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { SpaceBrowseView } from '@/features/plants/SpaceBrowseView';
import type { Plant } from '@/services/plantService';

function plant(over: Partial<Plant> = {}): Plant {
  return {
    id: 'p1',
    householdId: 'hh',
    name: 'Fern',
    spaceId: 'kitchen',
    createdAt: '',
    updatedAt: '',
    ...over,
  } as Plant;
}

function renderView(spacesUnavailable: boolean) {
  return render(
    <MemoryRouter>
      <SpaceBrowseView
        plants={[plant(), plant({ id: 'p2', name: 'Monstera', spaceId: 'bedroom' })]}
        spaces={[]}
        spacesUnavailable={spacesUnavailable}
        showCareOverview={false}
      />
    </MemoryRouter>
  );
}

describe('SpaceBrowseView when the rooms read failed', () => {
  it('says it could not load the rooms rather than showing a clean grouping', () => {
    renderView(true);
    expect(screen.getByText(/couldn’t load your rooms/i)).toBeInTheDocument();
  });

  it('does not label the plants "Unplaced" — the room is unknown, not absent', () => {
    renderView(true);
    // Both the section heading and the card title said "Unplaced" before.
    expect(screen.queryByRole('heading', { name: 'Unplaced' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: 'Room unknown' }).length).toBeGreaterThan(0);
  });

  it('still lists every plant — the plants themselves loaded fine', () => {
    renderView(true);
    expect(screen.getByText('Fern')).toBeInTheDocument();
    expect(screen.getByText('Monstera')).toBeInTheDocument();
  });

  it('leaves the settled-empty case alone: a household with no rooms still reads "Unplaced"', () => {
    renderView(false);
    expect(screen.queryByText(/couldn’t load your rooms/i)).not.toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: 'Unplaced' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading', { name: 'Room unknown' })).not.toBeInTheDocument();
  });
});
