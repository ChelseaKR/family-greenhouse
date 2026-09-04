import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SplitTheBill } from '@/features/pricing/SplitTheBill';

describe('SplitTheBill', () => {
  const originalShare = (navigator as Navigator & { share?: unknown }).share;

  beforeEach(() => {
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(navigator, 'share', { value: originalShare, configurable: true });
  });

  it('shows the live price divided by the real member count, with the exact split when uneven', () => {
    render(
      <SplitTheBill
        amount={4.99}
        interval="month"
        planName="Garden"
        memberCount={4}
        householdName="The Kelly-Reifs"
      />
    );
    expect(screen.getByTestId('split-line')).toHaveTextContent('$4.99 ÷ 4 members ≈ $1.25 each');
    expect(screen.getByTestId('split-exact')).toHaveTextContent(
      'Exactly: 3 × $1.25 and 1 × $1.24.'
    );
    expect(screen.getByText('per month')).toBeInTheDocument();
  });

  it('uses an equals sign, and no exact line, when the split is even', () => {
    render(
      <SplitTheBill
        amount={10}
        interval="year"
        planName="Garden"
        memberCount={4}
        householdName="Home"
      />
    );
    expect(screen.getByTestId('split-line')).toHaveTextContent('$10.00 ÷ 4 members = $2.50 each');
    expect(screen.queryByTestId('split-exact')).not.toBeInTheDocument();
    expect(screen.getByText('per year')).toBeInTheDocument();
  });

  it('renders nothing for a household of one, or when the count is unknown', () => {
    const { container, rerender } = render(
      <SplitTheBill
        amount={4.99}
        interval="month"
        planName="Garden"
        memberCount={1}
        householdName="Home"
      />
    );
    expect(container).toBeEmptyDOMElement();
    rerender(
      <SplitTheBill
        amount={4.99}
        interval="month"
        planName="Garden"
        memberCount={null}
        householdName="Home"
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shares a plain-text line with the amount, the household name and the app link via the Web Share API', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    render(
      <SplitTheBill
        amount={4.99}
        interval="month"
        planName="Garden"
        memberCount={4}
        householdName="The Kelly-Reifs"
      />
    );
    await userEvent.click(screen.getByRole('button', { name: /Share the Garden split/ }));
    expect(share).toHaveBeenCalledTimes(1);
    const { text } = share.mock.calls[0][0] as { text: string };
    expect(text).toContain('The Kelly-Reifs');
    expect(text).toContain('$4.99');
    expect(text).toContain('$1.25');
    expect(text).toContain('4 members');
    expect(text).toContain('https://familygreenhouse.net/settings/billing');
    expect(text).not.toMatch(/undefined|null/);
  });

  it('copies the same line to the clipboard when the platform has no share sheet', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(
      <SplitTheBill
        amount={9.99}
        interval="month"
        planName="Greenhouse"
        memberCount={3}
        householdName={null}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: /Share the Greenhouse split/ }));
    expect(writeText).toHaveBeenCalledTimes(1);
    const text = writeText.mock.calls[0][0] as string;
    // Unknown household name falls back to a phrase, never a blank.
    expect(text).toMatch(/^Our household on Family Greenhouse/);
    expect(text).toContain('$9.99');
    expect(text).toContain('$3.33');
    expect(await screen.findByRole('status')).toHaveTextContent('Copied.');
  });

  it('says so when the copy fails instead of claiming success', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });
    render(
      <SplitTheBill
        amount={9.99}
        interval="month"
        planName="Greenhouse"
        memberCount={3}
        householdName="Home"
      />
    );
    await userEvent.click(screen.getByRole('button', { name: /Share the Greenhouse split/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn.t copy automatically/);
  });
});
