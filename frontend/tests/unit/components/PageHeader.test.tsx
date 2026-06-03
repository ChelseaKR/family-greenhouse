import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PageHeader } from '@/components/PageHeader';

function renderHeader(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('PageHeader', () => {
  it('renders title, eyebrow, description, action, and art slots', () => {
    renderHeader(
      <PageHeader
        eyebrow="Your household"
        title="Plants"
        description="The leafy crew."
        action={<button type="button">Add plant</button>}
        art={<svg data-testid="art" />}
      />
    );

    expect(screen.getByRole('heading', { level: 1, name: 'Plants' })).toBeInTheDocument();
    expect(screen.getByText('Your household')).toBeInTheDocument();
    expect(screen.getByText('The leafy crew.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add plant' })).toBeInTheDocument();
    expect(screen.getByTestId('art')).toBeInTheDocument();
  });

  it('omits eyebrow when not provided', () => {
    renderHeader(<PageHeader title="Plants" />);

    // The eyebrow text would be the only paragraph that has the uppercase
    // tracking class — if it isn't there we shouldn't see any p with that
    // styling above the heading.
    expect(screen.queryByText('Your household')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Plants' })).toBeInTheDocument();
  });

  it('always renders the TitleUnderline SVG', () => {
    const { container } = renderHeader(<PageHeader title="Plants" />);
    // TitleUnderline renders an <svg viewBox="0 0 240 14">. Just look for an
    // svg under the header — there's no other SVG when art/action are absent.
    const svgs = container.querySelectorAll('svg');
    expect(svgs.length).toBeGreaterThanOrEqual(1);
    const underline = Array.from(svgs).find((s) => s.getAttribute('viewBox') === '0 0 240 14');
    expect(underline).toBeDefined();
  });

  it('renders TitleUnderline even when no other props are provided beyond title', () => {
    const { container } = renderHeader(<PageHeader title="Bare" />);
    const underline = container.querySelector('svg[viewBox="0 0 240 14"]');
    expect(underline).not.toBeNull();
  });

  it('places art in a sm:block container and stacks action below when both are present', () => {
    const { container } = renderHeader(
      <PageHeader
        title="Plants"
        action={<button type="button">Add plant</button>}
        art={<svg data-testid="art" />}
      />
    );

    // The art wrapper is hidden on mobile (sm: breakpoint). Find a div
    // containing the art SVG and verify the responsive classes.
    const artNode = screen.getByTestId('art');
    const artWrapper = artNode.parentElement;
    expect(artWrapper).not.toBeNull();
    expect(artWrapper).toHaveClass('hidden');
    expect(artWrapper?.className).toContain('sm:block');

    // When both action + art exist, an additional row at the end of the
    // header holds the action so it stacks under the art.
    const header = container.querySelector('header');
    const actionButton = screen.getByRole('button', { name: 'Add plant' });
    const actionWrapper = actionButton.parentElement;
    expect(actionWrapper).toHaveClass('flex', 'justify-end');
    // And that wrapper should be a direct child of the <header>, after the
    // main flex row.
    expect(actionWrapper?.parentElement).toBe(header);
  });

  it('places action inline (no extra stacked row) when art is absent', () => {
    renderHeader(<PageHeader title="Plants" action={<button type="button">Add plant</button>} />);
    const actionWrapper = screen.getByRole('button', { name: 'Add plant' }).parentElement;
    expect(actionWrapper).toHaveClass('flex-shrink-0');
    // Without art, there should not be the extra stacked `mt-4 justify-end`
    // row.
    expect(actionWrapper).not.toHaveClass('justify-end');
  });

  it('supports ReactNode descriptions', () => {
    renderHeader(
      <PageHeader
        title="Plants"
        description={
          <>
            code sent to <strong>plants@example.com</strong>
          </>
        }
      />
    );
    expect(screen.getByText(/code sent to/i)).toBeInTheDocument();
    const strong = screen.getByText('plants@example.com');
    expect(strong.tagName).toBe('STRONG');
  });

  it('forwards className onto the header element', () => {
    const { container } = renderHeader(<PageHeader title="Plants" className="extra-class" />);
    const header = container.querySelector('header');
    expect(header).toHaveClass('extra-class');
    // And keeps the default spacing.
    expect(header).toHaveClass('mb-8');
  });
});
