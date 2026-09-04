import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Alert } from '@/components/Alert';

/**
 * `role="alert"` is `aria-live="assertive"` — it interrupts a screen reader
 * mid-word. That is correct for an unexpected error and wrong for the large
 * majority of this component's ~130 uses, which are static informational
 * content that mounts when a query resolves (#446). No axe rule covers this:
 * an assertive region is valid ARIA whatever it contains, so the announcement
 * politeness has to be asserted by hand.
 */
describe('Alert live-region politeness', () => {
  it('keeps error assertive — an unexpected failure is worth interrupting for', () => {
    render(<Alert variant="error">Could not save your plant.</Alert>);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save your plant.');
  });

  it.each(['info', 'warning', 'success'] as const)(
    'announces %s politely rather than interrupting',
    (variant) => {
      render(<Alert variant={variant}>Move this one somewhere brighter for winter.</Alert>);
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByRole('status')).toHaveTextContent(
        'Move this one somewhere brighter for winter.'
      );
    }
  );

  it('lets a caller escalate a non-error alert that really is urgent', () => {
    render(
      <Alert variant="warning" live="assertive">
        Your card was declined and the household reverts to free in 3 days.
      </Alert>
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('lets a caller silence an alert that sits inside someone else’s live region', () => {
    const { container } = render(
      <Alert variant="success" live="off">
        Spider plant is pet-safe
      </Alert>
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(container.querySelector('[aria-live]')).toBeNull();
  });
});
