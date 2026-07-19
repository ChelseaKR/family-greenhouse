import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PricingGrid } from '@/features/pricing/PricingGrid';

describe('PricingGrid commercial hold', () => {
  it('renders the paid-plan hold notice without price or purchase controls', () => {
    render(<PricingGrid />);

    expect(
      screen.getByRole('heading', {
        name: /paid plans are paused/i,
      })
    ).toBeInTheDocument();
    expect(screen.getByText(/commercial hold effective 2026-07-14/i)).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\$\s*\d/);
    expect(document.body.textContent).not.toMatch(/subscribe|start free trial|checkout/i);
  });
});
