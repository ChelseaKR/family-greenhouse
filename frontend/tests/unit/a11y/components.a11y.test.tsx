import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';

expect.extend(toHaveNoViolations);

// jest-axe augments jest's matchers, not vitest's — declare the matcher so
// `toHaveNoViolations()` type-checks under vitest's `expect`.
declare module 'vitest' {
  interface Assertion {
    toHaveNoViolations(): void;
  }
}

/**
 * Fast, structural a11y checks (labels, roles, names, aria wiring) on shared
 * primitives. Runs in jsdom, so it complements rather than replaces the
 * real-browser Playwright axe suite — color-contrast (1.4.6) needs layout and
 * is enforced there. Restricted to WCAG rules to avoid best-practice landmark
 * noise on isolated component renders.
 */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const run = (el: HTMLElement) => axe(el, { runOnly: { type: 'tag', values: WCAG_TAGS } });

describe('component accessibility (structural)', () => {
  it('Button has an accessible name and no violations', async () => {
    const { container } = render(<Button>Save plant</Button>);
    expect(await run(container)).toHaveNoViolations();
  });

  it('icon-only Button needs an aria-label to pass', async () => {
    const { container } = render(
      <Button aria-label="Delete plant">
        <svg aria-hidden="true" />
      </Button>
    );
    expect(await run(container)).toHaveNoViolations();
  });

  it('Input is label-associated with no violations', async () => {
    const { container } = render(<Input label="Email address" type="email" />);
    expect(await run(container)).toHaveNoViolations();
  });

  it('Input in an error state wires aria-invalid/describedby cleanly', async () => {
    const { container } = render(<Input label="Password" type="password" error="Required" />);
    expect(await run(container)).toHaveNoViolations();
  });
});
