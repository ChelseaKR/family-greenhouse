import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PricingGrid } from '@/features/pricing/PricingGrid';

describe('PricingGrid commercial hold', () => {
  it('renders only the shared hold notice, with no price or acquisition control', () => {
    render(<PricingGrid />);

    expect(
      screen.getByRole('heading', {
        name: /new registration and commercial activity are paused/i,
      })
    ).toBeInTheDocument();
    expect(screen.getByText(/commercial hold effective 2026-07-14/i)).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\$\s*\d/);
    expect(document.body.textContent).not.toMatch(/upgrade|subscribe|start free trial|sign up/i);
  });
});
