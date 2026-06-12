import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LeafHealthResults } from '@/features/plants/LeafHealthCard';
import type { LeafHealthResult } from '@/services/plantService';

function renderResults(result: LeafHealthResult) {
  return render(<LeafHealthResults result={result} />);
}

describe('LeafHealthResults', () => {
  it('renders the overall verdict, observations with confidence, suggestion, and disclaimer', () => {
    renderResults({
      overall: 'concern',
      observations: [
        { sign: 'Yellowing', confidence: 'high', note: 'Lower leaves are turning yellow.' },
        { sign: 'Browning edges', confidence: 'medium', note: 'Edges look crispy and brown.' },
      ],
      suggestion: 'Check soil moisture before the next watering.',
      disclaimer: 'Visual check only, not a diagnosis.',
    });

    // Overall verdict badge resolves through i18n.
    expect(screen.getByText('Needs attention')).toBeInTheDocument();

    // Observations list with per-row confidence chips and notes.
    expect(screen.getByText('Yellowing')).toBeInTheDocument();
    expect(screen.getByText('High confidence')).toBeInTheDocument();
    expect(screen.getByText('Lower leaves are turning yellow.')).toBeInTheDocument();
    expect(screen.getByText('Browning edges')).toBeInTheDocument();
    expect(screen.getByText('Medium confidence')).toBeInTheDocument();

    // Suggestion + small-print disclaimer.
    expect(screen.getByText('Check soil moisture before the next watering.')).toBeInTheDocument();
    expect(screen.getByText('Visual check only, not a diagnosis.')).toBeInTheDocument();

    // No demo notice unless the server flagged it.
    expect(screen.queryByText(/Demo result/)).not.toBeInTheDocument();
  });

  it('shows the empty-observations copy for a clean healthy leaf', () => {
    renderResults({
      overall: 'healthy',
      observations: [],
      suggestion: 'Keep doing what you are doing.',
      disclaimer: 'Visual check only, not a diagnosis.',
    });

    expect(screen.getByText('Looking healthy')).toBeInTheDocument();
    expect(screen.getByText('No visible signs of trouble on this leaf.')).toBeInTheDocument();
  });

  it('flags demo responses so users know no real analysis ran', () => {
    renderResults({
      demo: true,
      overall: 'monitor',
      observations: [],
      suggestion: 'Compare against a new photo next week.',
      disclaimer: 'Visual check only, not a diagnosis.',
    });

    expect(screen.getByText('Worth monitoring')).toBeInTheDocument();
    expect(
      screen.getByText('Demo result — image analysis is not configured on this server.')
    ).toBeInTheDocument();
  });
});
