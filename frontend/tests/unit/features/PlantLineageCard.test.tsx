import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PlantLineageCard } from '@/features/plants/PlantLineageCard';
import type { PlantLineage } from '@/services/plantService';

function renderCard(lineage?: PlantLineage) {
  return render(
    <MemoryRouter>
      <PlantLineageCard lineage={lineage} />
    </MemoryRouter>
  );
}

describe('PlantLineageCard', () => {
  it('renders nothing when the plant has no lineage', () => {
    const { container } = renderCard({ children: [] });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when lineage is absent (older API responses)', () => {
    const { container } = renderCard(undefined);
    expect(container).toBeEmptyDOMElement();
  });

  it('links to the parent plant with its status badge', () => {
    renderCard({
      parent: { id: 'parent-1', name: 'Mother Monstera', status: 'active' },
      children: [],
    });
    const link = screen.getByRole('link', { name: 'Mother Monstera' });
    expect(link).toHaveAttribute('href', '/plants/parent-1');
    expect(screen.getByText('Cut from')).toBeInTheDocument();
  });

  it('lists children with status badges and mutes (but keeps) died cuttings', () => {
    renderCard({
      children: [
        { id: 'c1', name: 'First Cutting', status: 'died', createdAt: '2026-02-01T00:00:00Z' },
        { id: 'c2', name: 'Second Cutting', status: 'active', createdAt: '2026-03-01T00:00:00Z' },
        {
          id: 'c3',
          name: 'Gifted Cutting',
          status: 'gave_away',
          createdAt: '2026-04-01T00:00:00Z',
        },
      ],
    });

    // All three children are shown — died/given-away history is the point.
    const died = screen.getByRole('link', { name: 'First Cutting' });
    expect(died).toHaveAttribute('href', '/plants/c1');
    expect(screen.getByRole('link', { name: 'Second Cutting' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Gifted Cutting' })).toBeInTheDocument();

    // Status badges resolve through i18n.
    expect(screen.getByText('Died')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Gave away')).toBeInTheDocument();

    // The died row renders muted, not hidden.
    expect(died.closest('li')!.className).toContain('opacity-60');

    // Count summary ("3 cuttings").
    expect(screen.getByText(/3 cuttings/)).toBeInTheDocument();
  });
});
